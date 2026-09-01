mod protocol;
mod version;

use std::{env, fs, process};

use naga::{
    back::glsl,
    front::wgsl,
    proc::BoundsCheckPolicies,
    valid::{Capabilities, ValidationFlags, Validator},
    ShaderStage,
};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut args = env::args().skip(1);
    let command = args.next().ok_or("usage: aether-naga-shader-validator <validate|glsl> <wgsl-file> [vertex|fragment] [entry]")?;
    let path = args.next().ok_or("missing WGSL file path")?;
    let source = fs::read_to_string(&path).map_err(|error| format!("failed to read {path}: {error}"))?;
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
