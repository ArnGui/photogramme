//! Paquet binaire échangé avec l'interface : en-tête JSON + pixels bruts.
//!
//! Format : [longueur de l'en-tête, u32 petit-boutiste][en-tête JSON UTF-8][pixels]
//!
//! Pourquoi pas du JSON pur ? Une image 4K en RVBA fait 33 Mo ; en JSON
//! (tableau de nombres) elle en ferait ~120 et coûterait des secondes à
//! analyser. Le canal binaire de Tauri 2 la transfère telle quelle.

use serde::{de::DeserializeOwned, Serialize};

/// Taille maximale de l'en-tête : il ne contient que des métadonnées.
pub const MAX_HEADER: usize = 64 * 1024;

pub fn encode<H: Serialize>(header: &H, pixels: &[u8]) -> Result<Vec<u8>, String> {
    let json = serde_json::to_vec(header).map_err(|e| e.to_string())?;
    if json.len() > MAX_HEADER {
        return Err("Header too long.".into());
    }
    let mut out = Vec::with_capacity(4 + json.len() + pixels.len());
    out.extend_from_slice(&(json.len() as u32).to_le_bytes());
    out.extend_from_slice(&json);
    out.extend_from_slice(pixels);
    Ok(out)
}

pub fn decode<H: DeserializeOwned>(bytes: &[u8]) -> Result<(H, &[u8]), String> {
    if bytes.len() < 4 {
        return Err("Truncated packet.".into());
    }
    let n = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    if n > MAX_HEADER || bytes.len() < 4 + n {
        return Err("Invalid packet header.".into());
    }
    let header = serde_json::from_slice(&bytes[4..4 + n]).map_err(|e| format!("Unreadable header: {e}"))?;
    Ok((header, &bytes[4 + n..]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct H {
        frame: u64,
        name: String,
    }

    #[test]
    fn aller_retour() {
        let h = H { frame: 42, name: "Été".into() };
        let p = encode(&h, &[1, 2, 3]).unwrap();
        let (h2, px): (H, &[u8]) = decode(&p).unwrap();
        assert_eq!(h2, h);
        assert_eq!(px, &[1, 2, 3]);
    }

    #[test]
    fn refuse_les_paquets_abimes() {
        assert!(decode::<H>(&[1, 0]).is_err());
        assert!(decode::<H>(&[255, 255, 255, 255, 0]).is_err());
        assert!(decode::<H>(&[2, 0, 0, 0, b'{', b'}']).is_err(), "champs manquants");
    }
}
