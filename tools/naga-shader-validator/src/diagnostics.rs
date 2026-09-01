use crate::{protocol::CookDiagnostic, version::COOK_SCHEMA_VERSION};
use naga::front::wgsl::ParseError;
use std::io::{self, Write};

pub const INVALID_ARGUMENTS: &str = "invalid-arguments";
pub const INVALID_SOURCE_URI: &str = "invalid-source-uri";
pub const SOURCE_READ_FAILED: &str = "source-read-failed";
pub const WGSL_PARSE_FAILED: &str = "wgsl-parse-failed";
pub const WGSL_VALIDATION_FAILED: &str = "wgsl-validation-failed";
#[allow(dead_code)] // Reserved for Task 3's reflection boundary.
pub const REFLECTION_FAILED: &str = "reflection-failed";
pub const BACKEND_EMISSION_FAILED: &str = "backend-emission-failed";

pub fn error(code: &str, message: &str, source_uri: &str) -> CookDiagnostic {
    CookDiagnostic {
        schema_version: COOK_SCHEMA_VERSION,
        severity: "error".to_owned(),
        code: code.to_owned(),
        message: message.to_owned(),
        source_uri: source_uri.to_owned(),
        line: None,
        column: None,
        backend_stage: None,
    }
}

pub fn parse_error(error: &ParseError, source: &str, source_uri: &str) -> CookDiagnostic {
    let location = error.location(source);
    CookDiagnostic {
        schema_version: COOK_SCHEMA_VERSION,
        severity: "error".to_owned(),
        code: WGSL_PARSE_FAILED.to_owned(),
        message: error.message().to_owned(),
        source_uri: source_uri.to_owned(),
        line: location.map(|value| value.line_number),
        column: location.map(|value| value.line_position),
        backend_stage: Some("parse".to_owned()),
    }
}

pub fn write_diagnostic(diagnostic: &CookDiagnostic) -> io::Result<()> {
    let stderr = io::stderr();
    let mut writer = stderr.lock();
    serde_json::to_writer(&mut writer, diagnostic)?;
    writer.write_all(b"\n")
}
