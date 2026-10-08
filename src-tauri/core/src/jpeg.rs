//! Encodage des images exportées : JPEG ou PNG, avec profil ICC éventuel.
//!
//! Choix de `jpeg-encoder` (pur Rust, SIMD AVX2) plutôt que libjpeg-turbo :
//! même échelle de qualité 1–100 et même contrôle du sous-échantillonnage,
//! sans imposer CMake + NASM pour compiler sous Windows. libjpeg-turbo reste
//! plus rapide, mais l'écart est invisible pour des captures à l'unité.

use jpeg_encoder::{ColorType, Encoder, SamplingFactor};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum Chroma {
    /// Pas de sous-échantillonnage : couleurs nettes, fichier ~30 % plus lourd.
    #[default]
    #[serde(rename = "4:4:4")]
    C444,
    /// Sous-échantillonnage standard des JPEG.
    #[serde(rename = "4:2:0")]
    C420,
}

impl Chroma {
    fn sampling(self) -> SamplingFactor {
        match self {
            Chroma::C444 => SamplingFactor::R_4_4_4,
            Chroma::C420 => SamplingFactor::R_4_2_0,
        }
    }
}

/// Format des fichiers exportés.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    #[default]
    Jpeg,
    /// Sans perte, 8 bits. 5 à 10 fois plus lourd qu'un JPEG q92.
    Png,
}

impl ImageFormat {
    pub fn extension(self) -> &'static str {
        match self {
            ImageFormat::Jpeg => "jpg",
            ImageFormat::Png => "png",
        }
    }
}

/// Encode une image RVB 8 bits (ou RVBA si `rgba`) en JPEG, en mémoire.
pub fn encode_rgb(
    data: &[u8],
    width: u32,
    height: u32,
    quality: u8,
    chroma: Chroma,
    rgba: bool,
) -> Result<Vec<u8>, String> {
    encode_jpeg(data, width, height, quality, chroma, rgba, None)
}

/// Encode au format demandé. `icc` : profil intégré au fichier (APP2 en
/// JPEG, chunk iCCP en PNG). L'alpha d'une image RVBA est ignoré (opaque).
#[allow(clippy::too_many_arguments)]
pub fn encode_image(
    data: &[u8],
    width: u32,
    height: u32,
    rgba: bool,
    format: ImageFormat,
    quality: u8,
    chroma: Chroma,
    icc: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    match format {
        ImageFormat::Jpeg => encode_jpeg(data, width, height, quality, chroma, rgba, icc),
        ImageFormat::Png => encode_png(data, width, height, rgba, icc),
    }
}

fn encode_png(data: &[u8], width: u32, height: u32, rgba: bool, icc: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let bpp = if rgba { 4 } else { 3 };
    if width == 0 || height == 0 || data.len() != width as usize * height as usize * bpp {
        return Err(format!("Incomplete frame: {} bytes for {width}×{height}.", data.len()));
    }
    // Le PNG n'a pas besoin de l'alpha (toujours opaque ici) : RVB, 25 % plus léger.
    let rgb: std::borrow::Cow<[u8]> = if rgba {
        std::borrow::Cow::Owned(data.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect())
    } else {
        std::borrow::Cow::Borrowed(data)
    };
    let mut out = Vec::with_capacity(rgb.len() / 2);
    {
        let mut info = png::Info::with_size(width, height);
        info.color_type = png::ColorType::Rgb;
        info.bit_depth = png::BitDepth::Eight;
        if let Some(p) = icc {
            info.icc_profile = Some(std::borrow::Cow::Owned(p.to_vec()));
        }
        let mut enc = png::Encoder::with_info(&mut out, info).map_err(|e| format!("PNG encoding failed: {e}"))?;
        enc.set_compression(png::Compression::Fast);
        let mut w = enc.write_header().map_err(|e| format!("PNG encoding failed: {e}"))?;
        w.write_image_data(&rgb).map_err(|e| format!("PNG encoding failed: {e}"))?;
        w.finish().map_err(|e| format!("PNG encoding failed: {e}"))?;
    }
    Ok(out)
}

fn encode_jpeg(
    data: &[u8],
    width: u32,
    height: u32,
    quality: u8,
    chroma: Chroma,
    rgba: bool,
    icc: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    if !(1..=100).contains(&quality) {
        return Err(format!("JPEG quality out of range: {quality} (1 to 100)."));
    }
    let w: u16 = width
        .try_into()
        .map_err(|_| "Width too large for a JPEG.".to_string())?;
    let h: u16 = height
        .try_into()
        .map_err(|_| "Height too large for a JPEG.".to_string())?;
    let (color, bpp) = if rgba {
        (ColorType::Rgba, 4)
    } else {
        (ColorType::Rgb, 3)
    };
    let expected = width as usize * height as usize * bpp;
    if data.len() != expected {
        return Err(format!(
            "Incomplete frame: {} bytes received, {} expected.",
            data.len(),
            expected
        ));
    }

    let mut out = Vec::with_capacity(expected / 6);
    let mut enc = Encoder::new(&mut out, quality);
    enc.set_sampling_factor(chroma.sampling());
    if let Some(p) = icc {
        enc.add_icc_profile(p).map_err(|e| format!("ICC profile: {e}"))?;
    }
    enc.encode(data, w, h, color)
        .map_err(|e| format!("JPEG encoding failed: {e}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dégradé coloré bruité : assez de détail pour que la qualité compte.
    fn image(w: u32, h: u32) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 3) as usize);
        let mut seed: u32 = 12345;
        for y in 0..h {
            for x in 0..w {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
                let n = (seed >> 24) as u8 / 4;
                v.push(((x * 255 / w) as u8).wrapping_add(n));
                v.push(((y * 255 / h) as u8).wrapping_add(n));
                v.push((((x + y) * 127 / (w + h)) as u8).wrapping_add(n));
            }
        }
        v
    }

    #[test]
    fn produit_un_jpeg_valide() {
        let jpg = encode_rgb(&image(64, 32), 64, 32, 92, Chroma::C444, false).unwrap();
        assert_eq!(&jpg[..2], &[0xFF, 0xD8], "marqueur SOI");
        assert_eq!(&jpg[jpg.len() - 2..], &[0xFF, 0xD9], "marqueur EOI");
    }

    #[test]
    fn la_qualite_change_le_poids() {
        let img = image(256, 144);
        let low = encode_rgb(&img, 256, 144, 50, Chroma::C444, false).unwrap().len();
        let high = encode_rgb(&img, 256, 144, 98, Chroma::C444, false).unwrap().len();
        assert!(high > low * 2, "q50={low} q98={high}");
    }

    #[test]
    fn le_444_pese_plus_que_le_420() {
        let img = image(256, 144);
        let a = encode_rgb(&img, 256, 144, 92, Chroma::C444, false).unwrap().len();
        let b = encode_rgb(&img, 256, 144, 92, Chroma::C420, false).unwrap().len();
        assert!(a > b, "444={a} 420={b}");
    }

    #[test]
    fn accepte_le_rvba() {
        let rgba: Vec<u8> = image(16, 16).chunks(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect();
        assert!(encode_rgb(&rgba, 16, 16, 90, Chroma::C420, true).is_ok());
    }

    #[test]
    fn refuse_les_entrees_invalides() {
        assert!(encode_rgb(&image(8, 8), 8, 8, 0, Chroma::C444, false).is_err());
        assert!(encode_rgb(&image(8, 8), 8, 8, 101, Chroma::C444, false).is_err());
        assert!(encode_rgb(&[0; 10], 8, 8, 90, Chroma::C444, false).is_err());
    }

    #[test]
    fn png_sans_perte_avec_profil() {
        let img = image(32, 16);
        let icc = crate::color::icc_profile(crate::color::ColorProfile::Srgb).unwrap();
        let png = encode_image(&img, 32, 16, false, ImageFormat::Png, 0, Chroma::C444, Some(&icc)).unwrap();
        assert_eq!(&png[1..4], b"PNG");
        assert!(png.windows(4).any(|w| w == b"iCCP"));
        let dec = png::Decoder::new(std::io::Cursor::new(&png));
        let mut r = dec.read_info().unwrap();
        let mut buf = vec![0; r.output_buffer_size().unwrap()];
        r.next_frame(&mut buf).unwrap();
        assert_eq!(buf, img, "sans perte");
        let jpg = encode_image(&img, 32, 16, false, ImageFormat::Jpeg, 90, Chroma::C444, Some(&icc)).unwrap();
        assert!(jpg.windows(12).any(|w| w == b"ICC_PROFILE\0"));
    }

    #[test]
    fn serialise_comme_l_interface() {
        assert_eq!(serde_json::to_string(&Chroma::C444).unwrap(), "\"4:4:4\"");
        assert_eq!(serde_json::from_str::<Chroma>("\"4:2:0\"").unwrap(), Chroma::C420);
    }
}
