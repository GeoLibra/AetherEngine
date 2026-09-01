mod cli;
mod diagnostics;
mod protocol;
mod version;

use cli::{Command, CookArgumentError, CookCommand};
use diagnostics::{
    error as cook_error, parse_error, write_diagnostic, BACKEND_EMISSION_FAILED, INVALID_ARGUMENTS,
    INVALID_SOURCE_URI, SOURCE_READ_FAILED, WGSL_VALIDATION_FAILED,
};
use protocol::CookDiagnostic;
use std::{env, fs, process};

use naga::{
    back::glsl,
    front::wgsl,
    proc::BoundsCheckPolicies,
    valid::{Capabilities, ValidationFlags, Validator},
    ShaderStage,
};

fn main() {
    let args = env::args().skip(1).collect();
    match cli::parse_command(args) {
        Ok(Command::Cook(command)) => {
            if let Err(diagnostic) = run_cook(command) {
                let _ = write_diagnostic(&diagnostic);
                process::exit(1);
            }
        }
        Ok(Command::Legacy(args)) => {
            if let Err(error) = run_legacy(args) {
                eprintln!("{error}");
                process::exit(1);
            }
        }
        Err(CookArgumentError::InvalidArguments) => {
            let diagnostic = cook_error(
                INVALID_ARGUMENTS,
                "expected cook <wgsl-file> --source-uri <asset-or-package-uri>",
                "",
            );
            let _ = write_diagnostic(&diagnostic);
            process::exit(1);
        }
        Err(CookArgumentError::InvalidSourceUri) => {
            let diagnostic = cook_error(
                INVALID_SOURCE_URI,
                "source URI must use asset:// or package:// without traversal or fragments",
                "",
            );
            let _ = write_diagnostic(&diagnostic);
            process::exit(1);
        }
    }
}

#[allow(clippy::result_large_err)] // Diagnostics are the stable protocol error value, not a hot path.
fn run_cook(command: CookCommand) -> Result<(), CookDiagnostic> {
    let source = fs::read_to_string(&command.input_path).map_err(|_| {
        cook_error(
            SOURCE_READ_FAILED,
            "failed to read WGSL source",
            &command.source_uri,
        )
    })?;
    let module = wgsl::parse_str(&source)
        .map_err(|error| parse_error(&error, &source, &command.source_uri))?;
    Validator::new(ValidationFlags::all(), Capabilities::all())
        .validate(&module)
        .map_err(|error| {
            let location = error.location(&source);
            let mut diagnostic = cook_error(
                WGSL_VALIDATION_FAILED,
                &format!("WGSL validation failed: {error}"),
                &command.source_uri,
            );
            diagnostic.line = location.map(|value| value.line_number);
            diagnostic.column = location.map(|value| value.line_position);
            diagnostic.backend_stage = Some("validation".to_owned());
            diagnostic
        })?;

    Err(cook_error(
        BACKEND_EMISSION_FAILED,
        "backend module emission is not implemented",
        &command.source_uri,
    ))
}

fn run_legacy(args: Vec<String>) -> Result<(), String> {
    let mut args = args.into_iter();
    let command = args.next().ok_or(
        "usage: aether-naga-shader-validator <validate|glsl> <wgsl-file> [vertex|fragment] [entry]",
    )?;
    let path = args.next().ok_or("missing WGSL file path")?;
    let source =
        fs::read_to_string(&path).map_err(|error| format!("failed to read {path}: {error}"))?;
    let module = wgsl::parse_str(&source).map_err(|error| error.emit_to_string(&source))?;
    let info = Validator::new(ValidationFlags::all(), Capabilities::all())
        .validate(&module)
        .map_err(|error| format!("WGSL validation failed: {error}"))?;

    if command == "validate" {
        println!("ok");
        return Ok(());
    }
    if command != "glsl" {
        return Err(format!("unknown command {command}"));
    }

    let stage = match args.next().as_deref() {
        Some("vertex") => ShaderStage::Vertex,
        Some("fragment") => ShaderStage::Fragment,
        Some(value) => return Err(format!("unsupported GLSL stage {value}")),
        None => return Err("missing GLSL stage".into()),
    };
    let entry_point = args.next().ok_or("missing entry point")?;
    let mut output = String::new();
    let options = glsl::Options {
        version: glsl::Version::new_gles(300),
        ..Default::default()
    };
    let pipeline = glsl::PipelineOptions {
        shader_stage: stage,
        entry_point,
        multiview: None,
    };
    glsl::Writer::new(
        &mut output,
        &module,
        &info,
        &options,
        &pipeline,
        BoundsCheckPolicies::default(),
    )
    .map_err(|error| format!("GLSL writer creation failed: {error}"))?
    .write()
    .map_err(|error| format!("GLSL emission failed: {error}"))?;
    print!("{output}");
    Ok(())
}
