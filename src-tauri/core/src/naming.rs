//! Nommage des fichiers exportés, sûr sous Windows.

use std::path::{Path, PathBuf};

const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Nettoie un nom de base : caractères interdits sous Windows retirés,
/// espaces remplacés, longueur bornée, noms réservés évités.
pub fn sanitize_stem(stem: &str) -> String {
    let mut s: String = stem
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            ' ' => '_',
            c => c,
        })
        .collect();
    s = s.trim_matches(|c| c == '.' || c == '_').to_string();
    if s.chars().count() > 80 {
        s = s.chars().take(80).collect();
    }
    if s.is_empty() {
        s = "capture".into();
    }
    if RESERVED.contains(&s.to_uppercase().as_str()) {
        s = format!("_{s}");
    }
    s
}

/// Timecode utilisable dans un nom de fichier : « : » et « ; » (drop-frame) → « - ».
pub fn tc_for_file(timecode: &str) -> String {
    timecode.replace([':', ';', '.'], "-")
}

/// "mon_film_00-42-17-12.jpg" à partir du nom de la vidéo et du timecode.
pub fn capture_file_name(video_file_name: &str, timecode: &str) -> String {
    shot_file_name(video_file_name, timecode, None, "jpg")
}

/// "mon_film_P0012_00-42-17-12.jpg" : numéro de plan sur 4 chiffres pour
/// que l'Explorateur trie les fichiers dans l'ordre du film.
pub fn shot_file_name(
    video_file_name: &str,
    timecode: &str,
    shot: Option<u32>,
    ext: &str,
) -> String {
    let stem = film_stem(video_file_name);
    match shot {
        None => format!("{stem}_{}.{ext}", tc_for_file(timecode)),
        Some(n) => format!("{stem}_P{n:04}_{}.{ext}", tc_for_file(timecode)),
    }
}

/// Nom de base du film, nettoyé (« Le_Film_(master) »).
pub fn film_stem(video_file_name: &str) -> String {
    let stem = Path::new(video_file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    sanitize_stem(&stem)
}

/// Sous-dossier d'export nouveau : « film_plans », puis « film_plans_2 »…
pub fn unique_dir(parent: &Path, name: &str) -> PathBuf {
    let first = parent.join(name);
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|i| parent.join(format!("{name}_{i}")))
        .find(|c| !c.exists())
        .expect("suite infinie")
}

/// Ne jamais écraser une capture existante : ajoute _2, _3…
pub fn unique_path(dir: &Path, file_name: &str) -> PathBuf {
    let first = dir.join(file_name);
    if !first.exists() {
        return first;
    }
    let p = Path::new(file_name);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = p
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    (2..)
        .map(|i| dir.join(format!("{stem}_{i}.{ext}")))
        .find(|c| !c.exists())
        .expect("suite infinie")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retire_les_caracteres_interdits() {
        assert_eq!(
            sanitize_stem(r#"Mon film: "final" v2?"#),
            "Mon_film___final__v2"
        );
        assert_eq!(sanitize_stem("con"), "_con");
        assert_eq!(sanitize_stem("..."), "capture");
        assert_eq!(sanitize_stem("Été à Lodève"), "Été_à_Lodève");
    }

    #[test]
    fn nom_de_capture() {
        assert_eq!(
            capture_file_name("Le Film (master).mp4", "00:42:17:12"),
            "Le_Film_(master)_00-42-17-12.jpg"
        );
    }

    #[test]
    fn nom_avec_plan_et_dossier() {
        assert_eq!(
            shot_file_name("Film.mov", "00:00:01:00", Some(12), "jpg"),
            "Film_P0012_00-00-01-00.jpg"
        );
        assert_eq!(
            shot_file_name("Film.mov", "00:00:01:00", None, "png"),
            "Film_00-00-01-00.png"
        );
        assert_eq!(
            shot_file_name("Film.mov", "01:00:00;02", None, "jpg"),
            "Film_01-00-00-02.jpg",
            "drop-frame"
        );
        assert_eq!(film_stem("Le Film.mp4"), "Le_Film");
        let dir = std::env::temp_dir().join(format!("photogramme-dir-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("f_plans")).unwrap();
        assert_eq!(
            unique_dir(&dir, "f_plans").file_name().unwrap(),
            "f_plans_2"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn n_ecrase_jamais() {
        let dir = std::env::temp_dir().join(format!("photogramme-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = unique_path(&dir, "x.jpg");
        std::fs::write(&a, b"1").unwrap();
        let b = unique_path(&dir, "x.jpg");
        assert_eq!(b.file_name().unwrap(), "x_2.jpg");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
