//! Script de compilation.
//!
//! Correctif Windows pour `cargo test` (erreur 0xc0000139,
//! STATUS_ENTRYPOINT_NOT_FOUND) :
//! le plugin dialog (via rfd) importe `TaskDialogIndirect`, qui n'existe que
//! dans Common Controls v6. Windows ne charge cette version que si
//! l'exécutable déclare la dépendance dans son manifeste. Or `tauri-build`
//! n'embarque le manifeste que dans l'exécutable de l'application
//! (`rustc-link-arg-bins`), pas dans les exécutables de test : Windows
//! refuse alors de les lancer avant même la première ligne.
//!
//! Solution, reprise du build.rs de Tauri lui-même (tauri 2.12.1, fonction
//! `embed_manifest_for_tests`) : pas de manifeste dans la ressource, et
//! l'éditeur de liens l'embarque dans TOUS les exécutables (appli + tests).
//! Le manifeste est celui de tauri-build, copié tel quel.

fn main() {
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");

    let attributes = if windows_msvc {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    } else {
        tauri_build::Attributes::new()
    };
    tauri_build::try_build(attributes).expect("tauri-build failed");
}
