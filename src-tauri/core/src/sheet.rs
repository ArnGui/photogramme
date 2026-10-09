//! Planche contact : assemblage des pages.
//!
//! La mise en page (grille, légendes, polices) est dessinée par l'interface
//! avec le même moteur Canvas que l'overlay ; le Rust reçoit chaque page en
//! pixels, l'encode et l'écrit :
//! - en PDF : une page = une image JPEG intégrée telle quelle (filtre
//!   DCTDecode), à la taille physique du format choisi. Pas de bibliothèque :
//!   le format PDF d'une page-image tient en quelques objets (ISO 32000-1) ;
//! - en JPEG ou PNG : un fichier par page.

use std::fmt::Write as _;

/// Pages au plus dans une planche (garde-fou mémoire : ~1 Mo par page).
pub const MAX_PAGES: usize = 400;

/// Une page prête : JPEG et sa taille en pixels.
#[derive(Debug, Clone)]
pub struct JpegPage {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

fn pdf_string(s: &str) -> String {
    // Chaîne littérale PDF : on ne garde que l'ASCII imprimable, échappé.
    let mut out = String::from("(");
    for c in s.chars().filter(|c| c.is_ascii() && !c.is_ascii_control()) {
        if matches!(c, '(' | ')' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push(')');
    out
}

/// PDF d'une suite de pages-images. `page_mm` : taille de page en
/// millimètres ; `None` = page à la taille de l'image à 72 dpi.
pub fn pdf(pages: &[JpegPage], page_mm: Option<(f64, f64)>, title: &str) -> Result<Vec<u8>, String> {
    if pages.is_empty() {
        return Err("No page to write.".into());
    }
    let n = pages.len();
    // Objets : 1 catalogue, 2 arbre des pages, 3 infos, puis par page :
    // page, contenu, image.
    let total = 3 + 3 * n;
    let mut out: Vec<u8> = Vec::new();
    let mut offsets = vec![0usize; total + 1];
    out.extend(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

    let mut obj = |out: &mut Vec<u8>, id: usize, head: &str, stream: Option<&[u8]>| {
        offsets[id] = out.len();
        out.extend(format!("{id} 0 obj\n{head}\n").as_bytes());
        if let Some(s) = stream {
            out.extend(b"stream\n");
            out.extend(s);
            out.extend(b"\nendstream\n");
        }
        out.extend(b"endobj\n");
    };

    let kids: String = (0..n).map(|i| format!("{} 0 R", 4 + 3 * i)).collect::<Vec<_>>().join(" ");
    obj(&mut out, 1, "<< /Type /Catalog /Pages 2 0 R >>", None);
    obj(&mut out, 2, &format!("<< /Type /Pages /Kids [{kids}] /Count {n} >>"), None);
    obj(
        &mut out,
        3,
        &format!("<< /Title {} /Producer (Photogramme) /Creator (Photogramme) >>", pdf_string(title)),
        None,
    );
    for (i, p) in pages.iter().enumerate() {
        if p.width == 0 || p.height == 0 || p.jpeg.len() < 4 || p.jpeg[..2] != [0xFF, 0xD8] {
            return Err(format!("Page {} is not a valid JPEG.", i + 1));
        }
        let (w_pt, h_pt) = match page_mm {
            Some((w, h)) => (w / 25.4 * 72.0, h / 25.4 * 72.0),
            None => (p.width as f64, p.height as f64),
        };
        let (page_id, content_id, image_id) = (4 + 3 * i, 5 + 3 * i, 6 + 3 * i);
        let mut content = String::new();
        let _ = write!(content, "q {w_pt:.3} 0 0 {h_pt:.3} 0 0 cm /Im0 Do Q");
        obj(
            &mut out,
            page_id,
            &format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w_pt:.3} {h_pt:.3}] \
                 /Resources << /XObject << /Im0 {image_id} 0 R >> >> /Contents {content_id} 0 R >>"
            ),
            None,
        );
        obj(&mut out, content_id, &format!("<< /Length {} >>", content.len()), Some(content.as_bytes()));
        obj(
            &mut out,
            image_id,
            &format!(
                "<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /DeviceRGB \
                 /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>",
                p.width,
                p.height,
                p.jpeg.len()
            ),
            Some(&p.jpeg),
        );
    }

    let xref = out.len();
    let mut table = format!("xref\n0 {}\n0000000000 65535 f \n", total + 1);
    for off in offsets.iter().skip(1) {
        let _ = writeln!(table, "{off:010} 00000 n ");
    }
    out.extend(table.as_bytes());
    out.extend(format!("trailer\n<< /Size {} /Root 1 0 R /Info 3 0 R >>\nstartxref\n{xref}\n%%EOF\n", total + 1).as_bytes());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jpeg::{encode_rgb, Chroma};

    fn page(w: u32, h: u32) -> JpegPage {
        JpegPage { jpeg: encode_rgb(&vec![90u8; (w * h * 3) as usize], w, h, 85, Chroma::C420, false).unwrap(), width: w, height: h }
    }

    #[test]
    fn pdf_bien_forme() {
        let pages = vec![page(32, 24), page(32, 24)];
        let doc = pdf(&pages, Some((297.0, 210.0)), "Le film (v2)").unwrap();
        let text = String::from_utf8_lossy(&doc);
        assert!(text.starts_with("%PDF-1.4"));
        assert!(text.contains("/Count 2"));
        assert!(text.contains("/MediaBox [0 0 841.890 595.276]"), "A4 paysage en points");
        assert!(text.contains("/Title (Le film \\(v2\\))"));
        assert!(text.trim_end().ends_with("%%EOF"));
        // Chaque entrée de la table xref pointe sur « N 0 obj ».
        let xref_at: usize = text.rsplit("startxref\n").next().unwrap().lines().next().unwrap().parse().unwrap();
        let table = &doc[xref_at..];
        let table = String::from_utf8_lossy(table);
        for (id, line) in table.lines().skip(3).take(9).enumerate() {
            let off: usize = line[..10].parse().unwrap();
            assert!(doc[off..].starts_with(format!("{} 0 obj", id + 1).as_bytes()), "objet {}", id + 1);
        }
    }

    #[test]
    fn refuse_une_page_invalide() {
        assert!(pdf(&[], None, "x").is_err());
        let bad = JpegPage { jpeg: vec![1, 2, 3, 4], width: 2, height: 2 };
        assert!(pdf(&[bad], None, "x").is_err());
    }
}
