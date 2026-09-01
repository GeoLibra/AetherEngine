use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tempfile::TempDir;

const BINARY: &str = env!("CARGO_BIN_EXE_aether-naga-shader-validator");

fn run(args: &[&str]) -> std::process::Output {
    Command::new(BINARY).args(args).output().unwrap()
}

fn basic_fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("corpus/basic.wgsl")
}

fn multi_entry_fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("corpus/multi-entry.wgsl")
}

fn successful_cook(path: &Path, source_uri: &str) -> std::process::Output {
    let output = run(&["cook", path.to_str().unwrap(), "--source-uri", source_uri]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    assert_eq!(output.stdout.last(), Some(&b'\n'));
    assert_eq!(
        output.stdout.iter().filter(|byte| **byte == b'\n').count(),
        1
    );
    output
}

fn diagnostic(output: &std::process::Output) -> Value {
    assert_eq!(output.stderr.first(), Some(&b'{'));
    assert_eq!(output.stderr.last(), Some(&b'\n'));
    assert_eq!(
        output.stderr.iter().filter(|byte| **byte == b'\n').count(),
        1
    );
    assert_eq!(output.stderr.get(output.stderr.len() - 2), Some(&b'}'));
    serde_json::from_slice(&output.stderr[..output.stderr.len() - 1]).unwrap()
}

fn assert_path_is_sanitized(output: &std::process::Output, directory: &Path) {
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(!stderr.contains(directory.to_str().unwrap()));
}

#[test]
fn valid_cook_request_returns_complete_versioned_artifact() {
    let path = basic_fixture();
    let output = run(&[
        "cook",
        path.to_str().unwrap(),
        "--source-uri",
        "asset://shader/basic.wgsl",
    ]);

    assert!(output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["schemaVersion"], 1);
    assert_eq!(result["shaderManifestSchemaVersion"], 1);
    assert_eq!(result["shaderModuleSchemaVersion"], 1);
    assert_eq!(result["sourceKind"], "wgsl");
    assert_eq!(result["toolchain"]["cookerId"], "aether-native-wgsl-cooker");
    assert_eq!(result["toolchain"]["cookerVersion"], "0.0.0");
    assert_eq!(result["toolchain"]["nagaVersion"], "30.0.0");
    assert_eq!(result["source"]["sourceUri"], "asset://shader/basic.wgsl");
    assert_eq!(result["source"]["contentHash"].as_str().unwrap().len(), 64);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(!stdout.contains(path.parent().unwrap().to_str().unwrap()));
    assert!(!stdout.contains("nagaIr"));
    assert!(!stdout.contains("shaderIr"));
}

#[test]
fn multi_entry_cook_preserves_normalized_wgsl_and_emits_sorted_graphics_modules() {
    let path = multi_entry_fixture();
    let output = successful_cook(&path, "asset://shader/multi-entry.wgsl");
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let expected = fs::read_to_string(&path)
        .unwrap()
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    assert_eq!(result["modules"]["wgsl"], expected);
    let modules = result["modules"]["glslEs300"].as_object().unwrap();
    let keys = modules.keys().cloned().collect::<Vec<_>>();
    assert_eq!(
        keys,
        vec![
            "fragment:fragmentMain",
            "vertex:vertexAlpha",
            "vertex:vertexBeta"
        ]
    );
    assert!(!modules.contains_key("compute:computeMain"));
    for module in modules.values() {
        let module = module.as_str().unwrap();
        assert!(module.starts_with("#version 300 es"));
        assert!(module.contains("void main()"));
    }
}

#[test]
fn repeated_cooks_are_identical_and_source_uri_only_changes_provenance() {
    let path = multi_entry_fixture();
    let first = successful_cook(&path, "asset://shader/multi-entry.wgsl");
    let second = successful_cook(&path, "asset://shader/multi-entry.wgsl");
    assert_eq!(first.stdout, second.stdout);

    let package = successful_cook(&path, "package://shader/multi-entry.wgsl");
    let mut first_json: Value = serde_json::from_slice(&first.stdout).unwrap();
    let mut package_json: Value = serde_json::from_slice(&package.stdout).unwrap();
    assert_eq!(first_json["modules"], package_json["modules"]);
    assert_ne!(
        first_json["source"]["sourceUri"],
        package_json["source"]["sourceUri"]
    );
    first_json["source"]["sourceUri"] = Value::Null;
    package_json["source"]["sourceUri"] = Value::Null;
    assert_eq!(first_json, package_json);
}

#[test]
fn cook_normalizes_newlines_before_hashing_and_rejects_non_utf8() {
    let directory = TempDir::new().unwrap();
    let lf_path = directory.path().join("lf.wgsl");
    let crlf_path = directory.path().join("crlf.wgsl");
    let cr_path = directory.path().join("cr.wgsl");
    let source = fs::read_to_string(basic_fixture()).unwrap();
    fs::write(&lf_path, &source).unwrap();
    fs::write(&crlf_path, source.replace('\n', "\r\n")).unwrap();
    fs::write(&cr_path, source.replace('\n', "\r")).unwrap();
    let lf = successful_cook(&lf_path, "asset://shader/basic.wgsl");
    let crlf = successful_cook(&crlf_path, "asset://shader/basic.wgsl");
    let cr = successful_cook(&cr_path, "asset://shader/basic.wgsl");
    assert_eq!(lf.stdout, crlf.stdout);
    assert_eq!(lf.stdout, cr.stdout);

    let invalid_path = directory.path().join("invalid.wgsl");
    fs::write(&invalid_path, [0xff, 0xfe]).unwrap();
    let invalid = run(&[
        "cook",
        invalid_path.to_str().unwrap(),
        "--source-uri",
        "asset://shader/invalid.wgsl",
    ]);
    assert!(!invalid.status.success());
    assert_eq!(diagnostic(&invalid)["code"], "source-read-failed");
    assert_path_is_sanitized(&invalid, directory.path());
}

#[test]
fn legacy_validate_and_glsl_output_contracts_are_preserved() {
    let path = basic_fixture();
    let validate = run(&["validate", path.to_str().unwrap()]);
    assert!(validate.status.success());
    assert_eq!(validate.stdout, b"ok\n");
    assert!(validate.stderr.is_empty());

    let glsl = run(&["glsl", path.to_str().unwrap(), "vertex", "vertexMain"]);
    assert!(glsl.status.success());
    assert!(glsl.stderr.is_empty());
    let output = String::from_utf8(glsl.stdout).unwrap();
    assert!(output.starts_with("#version 300 es"));
    assert!(output.contains("void main()"));
    assert!(!output.starts_with('{'));
}

#[test]
fn missing_source_uri_is_an_invalid_argument() {
    let path = basic_fixture();
    let output = run(&["cook", path.to_str().unwrap()]);

    assert!(!output.status.success());
    assert_eq!(diagnostic(&output)["code"], "invalid-arguments");
}

#[test]
fn invalid_source_uris_are_rejected() {
    let path = basic_fixture();
    for source_uri in [
        "",
        "/absolute/file.wgsl",
        "asset://",
        "asset://shader\\basic.wgsl",
        "asset://shader/../basic.wgsl",
        "asset://shader/basic.wgsl#fragment",
        "https://example.com/basic.wgsl",
    ] {
        let output = run(&["cook", path.to_str().unwrap(), "--source-uri", source_uri]);

        assert!(
            !output.status.success(),
            "URI unexpectedly accepted: {source_uri}"
        );
        assert_eq!(
            diagnostic(&output)["code"],
            "invalid-source-uri",
            "wrong diagnostic for URI: {source_uri}"
        );
    }
}

#[test]
fn invalid_source_uri_does_not_echo_an_unvalidated_absolute_path() {
    let directory = TempDir::new().unwrap();
    let path = basic_fixture();
    let source_uri = directory.path().join("not-a-source-uri.wgsl");
    let output = run(&[
        "cook",
        path.to_str().unwrap(),
        "--source-uri",
        source_uri.to_str().unwrap(),
    ]);

    assert!(!output.status.success());
    let diagnostic = diagnostic(&output);
    assert_eq!(diagnostic["code"], "invalid-source-uri");
    assert_eq!(diagnostic["sourceUri"], "");
    assert_path_is_sanitized(&output, directory.path());
}

#[test]
fn extra_cook_arguments_are_rejected() {
    let path = basic_fixture();
    let output = run(&[
        "cook",
        path.to_str().unwrap(),
        "--source-uri",
        "package://shader/basic.wgsl",
        "extra",
    ]);

    assert!(!output.status.success());
    assert_eq!(diagnostic(&output)["code"], "invalid-arguments");
}

#[test]
fn missing_source_reports_sanitized_read_failure() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("missing.wgsl");
    let output = run(&[
        "cook",
        path.to_str().unwrap(),
        "--source-uri",
        "asset://shader/missing.wgsl",
    ]);

    assert!(!output.status.success());
    let diagnostic = diagnostic(&output);
    assert_eq!(diagnostic["code"], "source-read-failed");
    assert_eq!(diagnostic["sourceUri"], "asset://shader/missing.wgsl");
    assert_path_is_sanitized(&output, directory.path());
}

#[test]
fn invalid_wgsl_reports_authored_location_without_local_path() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("invalid.wgsl");
    fs::write(&path, "@vertex\nfn main( -> @builtin(position) vec4f {\n").unwrap();
    let output = run(&[
        "cook",
        path.to_str().unwrap(),
        "--source-uri",
        "package://shader/invalid.wgsl",
    ]);

    assert!(!output.status.success());
    let diagnostic = diagnostic(&output);
    assert_eq!(diagnostic["code"], "wgsl-parse-failed");
    assert_eq!(diagnostic["sourceUri"], "package://shader/invalid.wgsl");
    assert!(diagnostic["line"].as_u64().unwrap() >= 1);
    assert!(diagnostic["column"].as_u64().unwrap() >= 1);
    assert_path_is_sanitized(&output, directory.path());
}

#[test]
fn invalid_wgsl_semantics_reports_validation_failure_without_local_path() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("invalid-semantics.wgsl");
    fs::write(
        &path,
        "@vertex fn main() -> @builtin(position) f32 { return 0.0; }\n",
    )
    .unwrap();
    let output = run(&[
        "cook",
        path.to_str().unwrap(),
        "--source-uri",
        "asset://shader/invalid-semantics.wgsl",
    ]);

    assert!(!output.status.success());
    let diagnostic = diagnostic(&output);
    assert_eq!(diagnostic["code"], "wgsl-validation-failed");
    assert_eq!(
        diagnostic["sourceUri"],
        "asset://shader/invalid-semantics.wgsl"
    );
    assert_path_is_sanitized(&output, directory.path());
}

#[test]
fn unsupported_bound_resource_reports_sanitized_reflection_failure() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("unsupported-resource.wgsl");
    fs::write(
        &path,
        "@group(0) @binding(0) var image: texture_storage_2d<rgba8unorm, write>;\n\
         @compute @workgroup_size(1) fn main() {\n\
             textureStore(image, vec2<i32>(0), vec4<f32>(0.0));\n\
         }\n",
    )
    .unwrap();
    let output = run(&[
        "cook",
        path.to_str().unwrap(),
        "--source-uri",
        "asset://shader/unsupported-resource.wgsl",
    ]);

    assert!(!output.status.success());
    let diagnostic = diagnostic(&output);
    assert_eq!(diagnostic["code"], "reflection-failed");
    assert_eq!(
        diagnostic["sourceUri"],
        "asset://shader/unsupported-resource.wgsl"
    );
    assert_eq!(diagnostic["backendStage"], "reflection");
    assert_path_is_sanitized(&output, directory.path());
}
