#![allow(dead_code)] // Version metadata is consumed by subsequent cooker tasks.

pub const COOK_SCHEMA_VERSION: u32 = 1;
pub const COOKER_ID: &str = "aether-native-wgsl-cooker";
pub const COOKER_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const NAGA_VERSION: &str = "30.0.0";
pub const SHADER_MANIFEST_SCHEMA_VERSION: u32 = 1;
pub const SHADER_MODULE_SCHEMA_VERSION: u32 = 1;
