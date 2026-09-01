#![allow(dead_code)] // Protocol consumers are introduced by subsequent cooker tasks.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A source-based cook request independent of local filesystem paths.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookRequest {
    pub schema_version: u32,
    pub source_kind: String,
    pub source_uri: String,
    pub source: String,
}

/// The complete portable output of a successful shader cook.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookResult {
    pub schema_version: u32,
    pub shader_manifest_schema_version: u32,
    pub shader_module_schema_version: u32,
    pub source_kind: String,
    pub toolchain: CookToolchain,
    pub source: CookSourceProvenance,
    pub entry_points: Vec<CookEntryPoint>,
    pub bindings: Vec<CookBinding>,
    pub buffer_layouts: Vec<CookBufferLayout>,
    pub vertex_inputs: Vec<CookStageIo>,
    pub fragment_outputs: Vec<CookStageIo>,
    pub modules: CookBackendModules,
}

/// A structured cooker failure or warning mapped to authoring source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookDiagnostic {
    pub schema_version: u32,
    pub severity: String,
    pub code: String,
    pub message: String,
    pub source_uri: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub backend_stage: Option<String>,
}

/// Stable compiler identities participating in cooked artifact provenance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookToolchain {
    pub cooker_id: String,
    pub cooker_version: String,
    pub naga_version: String,
}

/// Content-derived source provenance without machine-local path data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookSourceProvenance {
    pub source_uri: String,
    pub content_hash: String,
    pub byte_length: u64,
}

/// A reflected shader entry point and its deterministically ordered bindings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookEntryPoint {
    pub name: String,
    pub stage: String,
    pub bindings: Vec<CookBinding>,
}

/// A reflected resource binding used by an entry point or module manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookBinding {
    pub group: u32,
    pub binding: u32,
    pub name: String,
    pub kind: String,
    pub address_space: String,
    pub access: String,
    pub type_name: String,
}

/// Canonical reflected layout for one bound uniform or storage buffer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookBufferLayout {
    pub group: u32,
    pub binding: u32,
    pub name: String,
    pub byte_size: u32,
    pub alignment: u32,
    pub fields: Vec<CookBufferField>,
}

/// Flattened leaf field in a reflected buffer layout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookBufferField {
    pub path: String,
    pub offset: u32,
    pub size: u32,
    pub alignment: u32,
    pub type_name: String,
}

/// Canonical location-bound shader stage input or output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookStageIo {
    pub location: u32,
    pub name: String,
    pub type_name: String,
}

/// Validated WGSL and optional GLSL ES 3.00 modules keyed by entry identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookBackendModules {
    pub wgsl: String,
    pub glsl_es300: BTreeMap<String, String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::version::{
        COOKER_ID, COOKER_VERSION, COOK_SCHEMA_VERSION, NAGA_VERSION,
        SHADER_MANIFEST_SCHEMA_VERSION, SHADER_MODULE_SCHEMA_VERSION,
    };
    use std::collections::BTreeMap;

    #[test]
    fn cook_result_serializes_the_versioned_public_contract_without_internal_ir() {
        let result = CookResult {
            schema_version: COOK_SCHEMA_VERSION,
            shader_manifest_schema_version: SHADER_MANIFEST_SCHEMA_VERSION,
            shader_module_schema_version: SHADER_MODULE_SCHEMA_VERSION,
            source_kind: "wgsl".to_owned(),
            toolchain: CookToolchain {
                cooker_id: COOKER_ID.to_owned(),
                cooker_version: COOKER_VERSION.to_owned(),
                naga_version: NAGA_VERSION.to_owned(),
            },
            source: CookSourceProvenance {
                source_uri: "asset://shaders/basic.wgsl".to_owned(),
                content_hash: "0123456789abcdef".repeat(4),
                byte_length: 42,
            },
            entry_points: vec![CookEntryPoint {
                name: "vertex_main".to_owned(),
                stage: "vertex".to_owned(),
                bindings: Vec::new(),
            }],
            bindings: Vec::new(),
            buffer_layouts: Vec::new(),
            vertex_inputs: Vec::new(),
            fragment_outputs: Vec::new(),
            modules: CookBackendModules {
                wgsl: "@vertex fn vertex_main() -> @builtin(position) vec4f { return vec4f(); }"
                    .to_owned(),
                glsl_es300: BTreeMap::new(),
            },
        };

        let json = serde_json::to_string(&result).unwrap();

        assert!(json.contains("\"schemaVersion\":1"));
        assert!(json.contains("\"sourceKind\":\"wgsl\""));
        assert!(json.contains("\"nagaVersion\":\"30.0.0\""));
        assert!(!json.contains("shaderIr"));
        assert!(!json.contains("nagaIr"));
    }

    #[test]
    fn cook_diagnostic_serializes_camel_case_location_and_backend_fields() {
        let diagnostic = CookDiagnostic {
            schema_version: COOK_SCHEMA_VERSION,
            severity: "error".to_owned(),
            code: "WGSL_PARSE".to_owned(),
            message: "expected expression".to_owned(),
            source_uri: "asset://shaders/basic.wgsl".to_owned(),
            line: Some(3),
            column: Some(7),
            backend_stage: Some("parse".to_owned()),
        };

        let json = serde_json::to_value(&diagnostic).unwrap();

        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["severity"], "error");
        assert_eq!(json["code"], "WGSL_PARSE");
        assert_eq!(json["message"], "expected expression");
        assert_eq!(json["sourceUri"], "asset://shaders/basic.wgsl");
        assert_eq!(json["line"], 3);
        assert_eq!(json["column"], 7);
        assert_eq!(json["backendStage"], "parse");
    }
}
