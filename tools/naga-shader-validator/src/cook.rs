use crate::{
    diagnostics::{
        error as cook_error, parse_error, BACKEND_EMISSION_FAILED, WGSL_VALIDATION_FAILED,
    },
    protocol::{
        CookBackendModules, CookDiagnostic, CookRequest, CookResult, CookSourceProvenance,
        CookToolchain,
    },
    reflection::{reflect_buffer_layouts, reflect_module, reflect_stage_io},
    version::{
        COOKER_ID, COOKER_VERSION, COOK_SCHEMA_VERSION, NAGA_VERSION,
        SHADER_MANIFEST_SCHEMA_VERSION, SHADER_MODULE_SCHEMA_VERSION,
    },
};
use naga::{
    back::glsl,
    front::wgsl,
    proc::BoundsCheckPolicies,
    valid::{Capabilities, ModuleInfo, ValidationFlags, Validator},
    Module, ShaderStage,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub enum ParseValidationError {
    Parse(wgsl::ParseError),
    Validation(Box<naga::WithSpan<naga::valid::ValidationError>>),
}

pub fn parse_and_validate(
    source: &str,
    capabilities: Capabilities,
) -> Result<(Module, ModuleInfo), ParseValidationError> {
    let module = wgsl::parse_str(source).map_err(ParseValidationError::Parse)?;
    let info = Validator::new(ValidationFlags::all(), capabilities)
        .validate(&module)
        .map_err(|error| ParseValidationError::Validation(Box::new(error)))?;
    Ok((module, info))
}

pub fn emit_glsl(
    module: &Module,
    info: &ModuleInfo,
    stage: ShaderStage,
    entry_point: &str,
) -> Result<String, String> {
    let mut output = String::new();
    let options = glsl::Options {
        version: glsl::Version::new_gles(300),
        ..Default::default()
    };
    let pipeline = glsl::PipelineOptions {
        shader_stage: stage,
        entry_point: entry_point.to_owned(),
        multiview: None,
    };
    glsl::Writer::new(
        &mut output,
        module,
        info,
        &options,
        &pipeline,
        BoundsCheckPolicies::default(),
    )
    .map_err(|error| format!("GLSL writer creation failed: {error}"))?
    .write()
    .map_err(|error| format!("GLSL emission failed: {error}"))?;
    Ok(output)
}

#[allow(clippy::result_large_err)]
pub fn cook(request: CookRequest) -> Result<CookResult, CookDiagnostic> {
    let (module, info) = parse_and_validate(&request.source, Capabilities::default()).map_err(
        |error| match error {
            ParseValidationError::Parse(error) => {
                parse_error(&error, &request.source, &request.source_uri)
            }
            ParseValidationError::Validation(error) => {
                let location = error.location(&request.source);
                let mut diagnostic = cook_error(
                    WGSL_VALIDATION_FAILED,
                    &format!("WGSL validation failed: {error}"),
                    &request.source_uri,
                );
                diagnostic.line = location.map(|value| value.line_number);
                diagnostic.column = location.map(|value| value.line_position);
                diagnostic.backend_stage = Some("validation".to_owned());
                diagnostic
            }
        },
    )?;
    let (entry_points, bindings) = reflect_module(&module, &info).map_err(|mut diagnostic| {
        diagnostic.source_uri = request.source_uri.clone();
        diagnostic
    })?;
    let buffer_layouts = reflect_buffer_layouts(&module).map_err(|mut diagnostic| {
        diagnostic.source_uri = request.source_uri.clone();
        diagnostic
    })?;
    let (vertex_inputs, fragment_outputs) =
        reflect_stage_io(&module).map_err(|mut diagnostic| {
            diagnostic.source_uri = request.source_uri.clone();
            diagnostic
        })?;
    let mut glsl_es300 = BTreeMap::new();
    for entry in &module.entry_points {
        let stage = match entry.stage {
            ShaderStage::Vertex => ShaderStage::Vertex,
            ShaderStage::Fragment => ShaderStage::Fragment,
            ShaderStage::Compute => continue,
            _ => continue,
        };
        let stage_name = if stage == ShaderStage::Vertex {
            "vertex"
        } else {
            "fragment"
        };
        let key = format!("{stage_name}:{}", entry.name);
        let output = emit_glsl(&module, &info, stage, &entry.name).map_err(|_| {
            let mut diagnostic = cook_error(
                BACKEND_EMISSION_FAILED,
                "failed to emit GLSL ES 300 backend module",
                &request.source_uri,
            );
            diagnostic.backend_stage = Some(key.clone());
            diagnostic
        })?;
        glsl_es300.insert(key, output);
    }

    let normalized_bytes = request.source.as_bytes();
    let content_hash = format!("{:x}", Sha256::digest(normalized_bytes));
    Ok(CookResult {
        schema_version: COOK_SCHEMA_VERSION,
        shader_manifest_schema_version: SHADER_MANIFEST_SCHEMA_VERSION,
        shader_module_schema_version: SHADER_MODULE_SCHEMA_VERSION,
        source_kind: request.source_kind,
        toolchain: CookToolchain {
            cooker_id: COOKER_ID.to_owned(),
            cooker_version: COOKER_VERSION.to_owned(),
            naga_version: NAGA_VERSION.to_owned(),
        },
        source: CookSourceProvenance {
            source_uri: request.source_uri,
            content_hash,
            byte_length: normalized_bytes.len() as u64,
        },
        entry_points,
        bindings,
        buffer_layouts,
        vertex_inputs,
        fragment_outputs,
        modules: CookBackendModules {
            wgsl: request.source,
            glsl_es300,
        },
    })
}
