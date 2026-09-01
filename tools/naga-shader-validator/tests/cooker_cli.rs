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
fn valid_cook_request_fails_closed_until_backend_emission_exists() {
    let path = basic_fixture();
    let output = run(&[
        "cook",
        path.to_str().unwrap(),
        "--source-uri",
        "asset://shader/basic.wgsl",
    ]);

    assert!(!output.status.success());
    assert_eq!(diagnostic(&output)["code"], "backend-emission-failed");
    assert!(output.stdout.is_empty());
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
