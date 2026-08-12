//! Tauri build script: codegen, resource bundling, and platform hooks for `tauri_build::build()`.
//!
//! Invoked automatically by Cargo before compiling the library; keep this file free of heavy
//! logic so configure-time stays fast.
//!
//! After `tauri_build::build()`, writes `OUT_DIR/tauri_invoke_handler_expr.rs` from
//! `src/commands/handler_list.inc` so `lib.rs` can `include!` the `tauri::generate_handler![...]`
//! invocation without a 900+ line macro in source control.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const OPTIONAL_SIDECAR_PLACEHOLDER_MARKER: &str = "ORGII_GENERATED_OPTIONAL_SIDECAR_PLACEHOLDER";

// Peekaboo and agent-browser are installed lazily into ~/.orgii/bin/ and are
// no longer bundled inside the .app. No placeholder generation is needed.
const OPTIONAL_SIDECAR_RESOURCES: &[&str] = &[];

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    ensure_optional_sidecar_resources(&manifest_dir);
    configure_windows_main_stack();
    configure_build_provenance(&manifest_dir);

    tauri_build::build();

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR must be set"));
    let handler_list_path = manifest_dir.join("src/commands/handler_list.inc");

    println!("cargo:rerun-if-changed={}", handler_list_path.display());

    let fragment = fs::read_to_string(&handler_list_path).unwrap_or_else(|err| {
        panic!("failed to read {}: {}", handler_list_path.display(), err);
    });

    let generated = format!("tauri::generate_handler![\n{}]\n", fragment.trim_end());

    let out_path = out_dir.join("tauri_invoke_handler_expr.rs");
    fs::write(&out_path, generated).unwrap_or_else(|err| {
        panic!("failed to write {}: {}", out_path.display(), err);
    });
}

/// Stamp one authoritative build identity into the native binary.
///
/// Official release workflows must opt in with `ORGII_BUILD_KIND=release`.
/// Every other build is local by default, which is the fail-safe choice for
/// update installation: an unclassified artifact must never replace itself
/// with a published release.
fn configure_build_provenance(manifest_dir: &Path) {
    for key in ["ORGII_BUILD_KIND", "ORGII_BUILD_REF", "ORGII_BUILD_SHA"] {
        println!("cargo:rerun-if-env-changed={key}");
    }

    let kind = match env::var("ORGII_BUILD_KIND").ok().as_deref() {
        Some("release") => "release",
        Some("local") | None => "local",
        Some(value) => panic!("unsupported ORGII_BUILD_KIND: {value}"),
    };
    let git_ref = env::var("ORGII_BUILD_REF")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| git_output(manifest_dir, &["symbolic-ref", "--short", "HEAD"]))
        .or_else(|| git_output(manifest_dir, &["describe", "--tags", "--exact-match"]))
        .unwrap_or_else(|| "unknown".to_string());
    let git_sha = env::var("ORGII_BUILD_SHA")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| git_output(manifest_dir, &["rev-parse", "HEAD"]))
        .unwrap_or_else(|| "unknown".to_string());

    println!(
        "cargo:rustc-env=ORGII_BUILD_KIND={}",
        sanitize_rustc_env(kind)
    );
    println!(
        "cargo:rustc-env=ORGII_BUILD_REF={}",
        sanitize_rustc_env(&git_ref)
    );
    println!(
        "cargo:rustc-env=ORGII_BUILD_SHA={}",
        sanitize_rustc_env(&git_sha)
    );

    for git_path in [
        git_output(manifest_dir, &["rev-parse", "--git-path", "HEAD"]),
        git_output(manifest_dir, &["rev-parse", "--git-path", "packed-refs"]),
        git_output(
            manifest_dir,
            &["rev-parse", "--git-path", &format!("refs/heads/{git_ref}")],
        ),
    ]
    .into_iter()
    .flatten()
    {
        println!("cargo:rerun-if-changed={git_path}");
    }
}

fn git_output(manifest_dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(manifest_dir)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn sanitize_rustc_env(value: &str) -> String {
    value.replace(['\r', '\n'], " ")
}

/// The generated Tauri invoke handler and setup closure share the Windows
/// process main thread. The PE default reserves only 1 MiB, which is too
/// narrow for debug builds as the command registry grows and can terminate
/// startup with `STATUS_STACK_OVERFLOW` before Rust can run the panic hook.
///
/// Reserve additional virtual address space for the desktop binary only.
/// Windows commits stack pages on demand, so this does not add 8 MiB of
/// resident memory to every process.
fn configure_windows_main_stack() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let link_arg = match env::var("CARGO_CFG_TARGET_ENV").as_deref() {
        Ok("msvc") => "/STACK:8388608",
        _ => "-Wl,--stack,8388608",
    };
    println!("cargo:rustc-link-arg-bin=org2={link_arg}");
}

fn ensure_optional_sidecar_resources(manifest_dir: &Path) {
    for resource in OPTIONAL_SIDECAR_RESOURCES {
        println!(
            "cargo:rerun-if-changed={}",
            manifest_dir.join(resource).display()
        );
        let path = manifest_dir.join(resource);
        if path.exists() {
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap_or_else(|err| {
                panic!(
                    "failed to create optional sidecar resource directory {}: {}",
                    parent.display(),
                    err
                );
            });
        }
        fs::write(&path, optional_sidecar_placeholder(resource)).unwrap_or_else(|err| {
            panic!(
                "failed to create optional sidecar placeholder {}: {}",
                path.display(),
                err
            );
        });
        println!(
            "cargo:warning=created optional sidecar placeholder {}; install the real binary to enable that capability",
            path.display()
        );
    }
}

fn optional_sidecar_placeholder(resource: &str) -> String {
    format!(
        "{}\nresource={}\nThis placeholder only satisfies Tauri resource validation. Replace it with the real sidecar binary/metadata to enable the capability.\n",
        OPTIONAL_SIDECAR_PLACEHOLDER_MARKER,
        resource
    )
}
