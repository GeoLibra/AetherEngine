mod cli;
mod cook;
mod diagnostics;
mod protocol;
mod reflection;
mod version;

use cli::{Command, CookArgumentError, CookCommand};
use cook::{cook, emit_glsl, parse_and_validate, ParseValidationError};
use diagnostics::{
    error as cook_error, write_diagnostic, INVALID_ARGUMENTS, INVALID_SOURCE_URI,
    SOURCE_READ_FAILED,
};
use protocol::{CookDiagnostic, CookRequest};
use std::{
    env, fs,
    io::{self, Write},
    process,
};

use naga::{valid::Capabilities, ShaderStage};

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
    let bytes = fs::read(&command.input_path).map_err(|_| {
        cook_error(
            SOURCE_READ_FAILED,
            "failed to read WGSL source",
            &command.source_uri,
        )
    })?;
    let source = String::from_utf8(bytes).map_err(|_| {
        cook_error(
            SOURCE_READ_FAILED,
            "WGSL source is not valid UTF-8",
            &command.source_uri,
        )
    })?;
    let source = source.replace("\r\n", "\n").replace('\r', "\n");
    let result = cook(CookRequest {
        schema_version: version::COOK_SCHEMA_VERSION,
        source_kind: "wgsl".to_owned(),
        source_uri: command.source_uri,
        source,
    })?;
    let stdout = io::stdout();
    let mut writer = stdout.lock();
    serde_json::to_writer(&mut writer, &result).map_err(|_| {
        cook_error(
            diagnostics::BACKEND_EMISSION_FAILED,
            "failed to serialize cook result",
            &result.source.source_uri,
        )
    })?;
    writer.write_all(b"\n").map_err(|_| {
        cook_error(
            diagnostics::BACKEND_EMISSION_FAILED,
            "failed to write cook result",
            &result.source.source_uri,
        )
    })?;
    Ok(())
}

fn run_legacy(args: Vec<String>) -> Result<(), String> {
    let mut args = args.into_iter();
    let command = args.next().ok_or(
        "usage: aether-naga-shader-validator <validate|glsl> <wgsl-file> [vertex|fragment] [entry]",
    )?;
    let path = args.next().ok_or("missing WGSL file path")?;
    let source =
        fs::read_to_string(&path).map_err(|error| format!("failed to read {path}: {error}"))?;
    let (module, info) =
        parse_and_validate(&source, Capabilities::all()).map_err(|error| match error {
            ParseValidationError::Parse(error) => error.emit_to_string(&source),
            ParseValidationError::Validation(error) => format!("WGSL validation failed: {error}"),
        })?;

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
    let (output, _) = emit_glsl(&module, &info, stage, &entry_point)?;
    print!("{output}");
    Ok(())
}
