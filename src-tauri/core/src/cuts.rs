//! Import des coupes depuis une liste de montage.
//!
//! Quand on a la timeline (Resolve, Premiere, Final Cut, Avid), la liste de
//! montage donne les coupes EXACTES : plus besoin de deviner avec `scdet`.
//! Formats lus :
//! - EDL CMX 3600 (`.edl`) ;
//! - OpenTimelineIO (`.otio`, JSON) ;
//! - Final Cut Pro 7 XML (`.xml`, « xmeml », exporté par Resolve et Premiere) ;
//! - FCPXML (`.fcpxml`, Final Cut Pro X et Resolve).
//!
//! Chaque lecteur produit une `EditList` : la position (en images de la
//! timeline, timecode de départ compris) du début de chaque plan de la piste
//! vidéo, avec le nom du clip. `map_to_film` la cale ensuite sur le film
//! ouvert grâce au timecode du fichier : un film exporté de la timeline
//! commence au même timecode qu'elle (souvent 01:00:00:00).

use crate::probe::VideoInfo;
use crate::timecode::{nominal_rate, parse_label, Timecode};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// Taille maximale d'une liste de montage lue (une EDL de long métrage fait ~200 Ko).
pub const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;

/// Début d'un plan dans la timeline.
#[derive(Debug, Clone, PartialEq)]
pub struct EditEvent {
    /// Position en images de la timeline, timecode de départ compris.
    pub start: u64,
    /// EDL seulement : timecode d'enregistrement pas encore converti.
    pub label: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EditList {
    pub format: &'static str,
    /// Cadence de la timeline (images par seconde), 0 si inconnue (EDL).
    pub rate: f64,
    pub drop: bool,
    /// Timecode de départ de la timeline (en images), s'il est connu.
    pub start: Option<u64>,
    /// Triés, sans doublon.
    pub events: Vec<EditEvent>,
    /// Fin du dernier plan (en images de la timeline), si connue.
    pub end: Option<u64>,
    pub warnings: Vec<String>,
}

/// Coupes calées sur le film : ce que garde l'application.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedCuts {
    pub format: String,
    pub file_name: String,
    /// Débuts de plan (numéros d'image du film), triés, > 0.
    pub cuts: Vec<u64>,
    /// Nom du clip de chaque plan, par image de début (0 compris).
    #[serde(skip)]
    pub names: BTreeMap<u64, String>,
    pub shots: usize,
    pub warnings: Vec<String>,
}

impl ImportedCuts {
    /// Nom du clip qui commence à `frame`, ou du plan qui le contient.
    pub fn name_at(&self, frame: u64) -> Option<&str> {
        self.names.range(..=frame).next_back().map(|(_, n)| n.as_str()).filter(|n| !n.is_empty())
    }
}

fn finish(mut l: EditList) -> Result<EditList, String> {
    l.events.sort_by_key(|e| e.start);
    // Même position : on garde le premier nom non vide.
    let mut out: Vec<EditEvent> = Vec::with_capacity(l.events.len());
    for e in l.events {
        match out.last_mut() {
            Some(last) if last.start == e.start => {
                if last.name.is_empty() {
                    last.name = e.name;
                }
            }
            _ => out.push(e),
        }
    }
    l.events = out;
    if l.events.is_empty() {
        return Err(format!("No video event found in this {} file.", l.format));
    }
    Ok(l)
}

/* ───────────── EDL CMX 3600 ───────────── */

/// Une EDL n'indique pas sa cadence : les timecodes d'enregistrement sont
/// gardés tels quels (`label`) et convertis avec la cadence du film.
pub fn parse_edl(text: &str) -> Result<EditList, String> {
    let mut drop = false;
    let mut events: Vec<EditEvent> = Vec::new();
    let mut last_no: Option<String> = None;

    for raw in text.lines() {
        let line = raw.trim();
        let upper = line.to_uppercase();
        if upper.starts_with("FCM:") {
            drop = upper.contains("DROP") && !upper.contains("NON");
            continue;
        }
        if let Some(rest) = line.strip_prefix('*') {
            let rest = rest.trim();
            let up = rest.to_uppercase();
            if up.starts_with("FROM CLIP NAME") {
                let n = rest.split_once(':').map(|(_, n)| n.trim()).unwrap_or("");
                if let Some(e) = events.last_mut() {
                    if e.name.is_empty() {
                        e.name = n.to_string();
                    }
                }
            }
            continue;
        }
        let tok: Vec<&str> = line.split_whitespace().collect();
        if tok.len() < 8 || !tok[0].bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let tcs = &tok[tok.len() - 4..];
        if !tcs.iter().all(|t| t.len() >= 11 && t.bytes().filter(u8::is_ascii_digit).count() >= 8) {
            continue;
        }
        // Piste : V, V2, A/V, B (image et son)… mais pas A, A2, AA.
        let track = tok[2].to_uppercase();
        if !(track.contains('V') || track == "B") {
            continue;
        }
        if tcs[2].contains(';') {
            drop = true;
        }
        // Fondu (D) : deux lignes portent le même numéro ; la seconde donne
        // le début du fondu (retenu comme coupe) et le clip entrant.
        if last_no.as_deref() == Some(tok[0]) {
            events.pop();
        }
        last_no = Some(tok[0].to_string());
        events.push(EditEvent { start: 0, label: Some(tcs[2].to_string()), name: String::new() });
    }
    if events.is_empty() {
        return Err("No video event found in this EDL file.".into());
    }
    Ok(EditList { format: "EDL", rate: 0.0, drop, start: None, events, end: None, warnings: Vec::new() })
}

/// Convertit les timecodes d'une EDL avec la cadence du film.
fn resolve_edl(mut l: EditList, rate: u32, film_drop: bool) -> Result<EditList, String> {
    let drop = l.drop || film_drop;
    let mut bad = 0usize;
    let mut events = Vec::with_capacity(l.events.len());
    for e in l.events {
        match e.label.as_deref().and_then(|t| parse_label(t, rate, drop)) {
            Some(start) => events.push(EditEvent { start, label: None, name: e.name }),
            None => bad += 1,
        }
    }
    if bad > 0 {
        l.warnings.push(format!("{bad} EDL events have a timecode that does not fit the film's frame rate and were skipped."));
    }
    l.events = events;
    l.drop = drop;
    finish(l)
}

/* ───────────── OpenTimelineIO ───────────── */

fn rational(v: &Value) -> Option<(f64, f64)> {
    let value = v.get("value")?.as_f64()?;
    let rate = v.get("rate")?.as_f64()?;
    (rate > 0.0 && value.is_finite()).then_some((value, rate))
}

fn otio_duration(item: &Value) -> Option<(f64, f64)> {
    item.get("source_range").and_then(|r| r.get("duration")).and_then(rational).or_else(|| {
        // Clip sans source_range : durée de son média.
        item.get("media_reference")
            .and_then(|m| m.get("available_range"))
            .and_then(|r| r.get("duration"))
            .and_then(rational)
    })
}

pub fn parse_otio(text: &str) -> Result<EditList, String> {
    let root: Value = serde_json::from_str(text).map_err(|e| format!("Unreadable OTIO file: {e}"))?;
    let schema = |v: &Value| v.get("OTIO_SCHEMA").and_then(|s| s.as_str()).unwrap_or("").to_string();
    // Le fichier peut être une timeline, ou une collection contenant une timeline.
    let timeline = if schema(&root).starts_with("Timeline") {
        &root
    } else {
        root.get("children")
            .and_then(|c| c.as_array())
            .and_then(|a| a.iter().find(|c| schema(c).starts_with("Timeline")))
            .ok_or("No timeline in this OTIO file.")?
    };
    let start_rt = timeline.get("global_start_time").and_then(rational);
    let tracks = timeline
        .get("tracks")
        .and_then(|t| t.get("children"))
        .and_then(|c| c.as_array())
        .ok_or("No tracks in this OTIO file.")?;

    let mut rate = start_rt.map(|r| r.1).unwrap_or(0.0);
    let mut events = Vec::new();
    let mut end: u64 = 0;
    let mut video_tracks = 0;
    for track in tracks.iter().filter(|t| t.get("kind").and_then(|k| k.as_str()) == Some("Video")) {
        video_tracks += 1;
        let mut pos = 0.0f64;
        for item in track.get("children").and_then(|c| c.as_array()).into_iter().flatten() {
            let s = schema(item);
            if s.starts_with("Transition") {
                continue; // une transition n'occupe pas de place dans la piste
            }
            let Some((dur, r)) = otio_duration(item) else { continue };
            if rate == 0.0 {
                rate = r;
            }
            // Valeurs exprimées en images à la cadence `r` : ramenées à la cadence de la timeline.
            let frames = |v: f64| if (r - rate).abs() < 1e-6 { v } else { v / r * rate };
            if s.starts_with("Clip") {
                let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                events.push((pos, name));
            } else if s.starts_with("Gap") && video_tracks == 1 {
                events.push((pos, String::new()));
            }
            pos += frames(dur);
        }
        end = end.max(pos.round() as u64);
    }
    if video_tracks == 0 {
        return Err("No video track in this OTIO file.".into());
    }
    let start = start_rt.map(|(v, r)| if (r - rate).abs() < 1e-6 { v } else { v / r * rate }.round() as u64);
    let base = start.unwrap_or(0);
    let mut warnings = Vec::new();
    if video_tracks > 1 {
        warnings.push(format!("{video_tracks} video tracks: the cuts of every track were combined."));
    }
    finish(EditList {
        format: "OTIO",
        rate,
        drop: false,
        start,
        events: events.into_iter().map(|(p, name)| EditEvent { start: base + p.round() as u64, label: None, name }).collect(),
        end: Some(base + end),
        warnings,
    })
}

/* ───────────── Final Cut Pro 7 XML (xmeml) ───────────── */

fn child<'a>(n: roxmltree::Node<'a, 'a>, name: &str) -> Option<roxmltree::Node<'a, 'a>> {
    n.children().find(|c| c.has_tag_name(name))
}

fn child_text<'a>(n: roxmltree::Node<'a, 'a>, name: &str) -> Option<&'a str> {
    child(n, name).and_then(|c| c.text()).map(str::trim)
}

fn parse_xml_doc(text: &str) -> Result<roxmltree::Document<'_>, String> {
    // Pas de DTD : une entité définie dans le fichier ne peut rien faire gonfler.
    let opts = roxmltree::ParsingOptions { allow_dtd: false, ..Default::default() };
    roxmltree::Document::parse_with_options(text, opts).map_err(|e| format!("Unreadable XML file: {e}"))
}

pub fn parse_fcp7_xml(text: &str) -> Result<EditList, String> {
    let doc = parse_xml_doc(text)?;
    let seq = doc
        .descendants()
        .find(|n| n.has_tag_name("sequence"))
        .ok_or("No sequence in this XML file (FCP 7 XML expected).")?;
    let rate_node = child(seq, "rate");
    let timebase: f64 = rate_node.and_then(|r| child_text(r, "timebase")).and_then(|t| t.parse().ok()).unwrap_or(0.0);
    let ntsc = rate_node.and_then(|r| child_text(r, "ntsc")).is_some_and(|t| t.eq_ignore_ascii_case("true"));
    if timebase <= 0.0 {
        return Err("No frame rate in this XML sequence.".into());
    }
    let rate = if ntsc { timebase * 1000.0 / 1001.0 } else { timebase };

    let tc = child(seq, "timecode");
    let drop = tc.and_then(|t| child_text(t, "displayformat")).is_some_and(|d| d.eq_ignore_ascii_case("DF"));
    let start = tc.and_then(|t| child_text(t, "frame")).and_then(|f| f.parse::<u64>().ok()).or_else(|| {
        tc.and_then(|t| child_text(t, "string")).and_then(|s| parse_label(s, nominal_rate(rate), drop))
    });

    let video = child(seq, "media").and_then(|m| child(m, "video")).ok_or("No video in this XML sequence.")?;
    let base = start.unwrap_or(0);
    let mut events = Vec::new();
    let mut end = 0u64;
    let mut tracks = 0;
    for track in video.children().filter(|c| c.has_tag_name("track")) {
        tracks += 1;
        let mut last_transition_start: Option<i64> = None;
        for item in track.children().filter(|c| c.is_element()) {
            let num = |name: &str| child_text(item, name).and_then(|t| t.parse::<i64>().ok());
            if item.has_tag_name("transitionitem") {
                last_transition_start = num("start");
                continue;
            }
            if !item.has_tag_name("clipitem") || child_text(item, "enabled").is_some_and(|e| e.eq_ignore_ascii_case("false")) {
                continue;
            }
            // -1 : le plan commence pendant un fondu ; la coupe est au début du fondu.
            let s = match num("start") {
                Some(s) if s >= 0 => s,
                _ => match last_transition_start.take() {
                    Some(t) if t >= 0 => t,
                    _ => continue,
                },
            };
            if let Some(e) = num("end").filter(|e| *e > 0) {
                end = end.max(e as u64);
            }
            let name = child_text(item, "name").unwrap_or("").to_string();
            events.push(EditEvent { start: base + s as u64, label: None, name });
        }
    }
    let mut warnings = Vec::new();
    if tracks > 1 {
        warnings.push(format!("{tracks} video tracks: the cuts of every track were combined."));
    }
    finish(EditList { format: "FCP 7 XML", rate, drop, start, events, end: Some(base + end), warnings })
}

/* ───────────── FCPXML ───────────── */

/// « 1001/24000s », « 3600s », « 0s » → secondes.
fn fcpx_time(s: &str) -> Option<f64> {
    let t = s.trim().strip_suffix('s')?;
    match t.split_once('/') {
        Some((n, d)) => {
            let (n, d): (f64, f64) = (n.parse().ok()?, d.parse().ok()?);
            (d > 0.0).then_some(n / d)
        }
        None => t.parse().ok(),
    }
}

pub fn parse_fcpxml(text: &str) -> Result<EditList, String> {
    let doc = parse_xml_doc(text)?;
    let seq = doc
        .descendants()
        .find(|n| n.has_tag_name("sequence"))
        .ok_or("No sequence in this FCPXML file.")?;
    let format_id = seq.attribute("format").unwrap_or("");
    let fd = doc
        .descendants()
        .find(|n| n.has_tag_name("format") && n.attribute("id") == Some(format_id))
        .and_then(|f| f.attribute("frameDuration"))
        .and_then(fcpx_time)
        .filter(|d| *d > 0.0)
        .ok_or("No frame duration in this FCPXML file.")?;
    let rate = 1.0 / fd;
    let frames = |t: f64| (t / fd).round() as u64;
    let start = seq.attribute("tcStart").and_then(fcpx_time).map(frames);
    let drop = seq.attribute("tcFormat") == Some("DF");
    let spine = seq.children().find(|c| c.has_tag_name("spine")).ok_or("No spine in this FCPXML sequence.")?;

    let mut events = Vec::new();
    let mut end = 0u64;
    let mut lanes = false;
    for item in spine.children().filter(|c| c.is_element()) {
        let tag = item.tag_name().name();
        if tag == "transition" {
            continue;
        }
        let (Some(off), Some(dur)) = (
            item.attribute("offset").and_then(fcpx_time),
            item.attribute("duration").and_then(fcpx_time),
        ) else {
            continue;
        };
        if item.children().any(|c| c.attribute("lane").is_some()) {
            lanes = true;
        }
        end = end.max(frames(off + dur));
        let name = if tag == "gap" { String::new() } else { item.attribute("name").unwrap_or("").to_string() };
        events.push(EditEvent { start: frames(off), label: None, name });
    }
    let mut warnings = Vec::new();
    if lanes {
        warnings.push("Connected clips (upper lanes) were ignored: only the main storyline is used.".into());
    }
    finish(EditList { format: "FCPXML", rate, drop, start, events, end: Some(end), warnings })
}

/* ───────────── Lecture et calage ───────────── */

/// Lit une liste de montage d'après son extension.
pub fn parse_edit_list(file_name: &str, text: &str) -> Result<EditList, String> {
    let ext = file_name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "edl" => parse_edl(text),
        "otio" => parse_otio(text),
        "fcpxml" => parse_fcpxml(text),
        "xml" => {
            if text.contains("<fcpxml") {
                parse_fcpxml(text)
            } else {
                parse_fcp7_xml(text)
            }
        }
        _ => Err("Unsupported edit list: .edl, .otio, .xml or .fcpxml expected.".into()),
    }
}

/// Cale une liste de montage sur le film ouvert.
///
/// Règle : le film commence au timecode de son fichier (`file_timecode`),
/// la timeline au sien ; une coupe à 01:00:10:00 dans la timeline tombe à
/// l'image `01:00:10:00 − départ du film`. Si le film n'a pas de timecode
/// compatible (la plupart des coupes tomberaient hors du film), on aligne le
/// premier plan de la timeline sur la première image du film.
pub fn map_to_film(list: EditList, info: &VideoInfo, file_name: &str) -> Result<ImportedCuts, String> {
    let film_rate = nominal_rate(info.fps);
    let list = if list.format == "EDL" {
        resolve_edl(list, film_rate, info.file_timecode.drop)?
    } else {
        list
    };
    let mut warnings = list.warnings.clone();

    let tl_rate = if list.rate > 0.0 { list.rate } else { info.fps };
    let same_rate = nominal_rate(tl_rate) == film_rate;
    if !same_rate {
        warnings.push(format!(
            "The timeline runs at {:.3} fps and the film at {:.3} fps: positions were converted, check a few cuts.",
            tl_rate, info.fps
        ));
    }
    // Position timeline (images) → image du film, à partir d'une origine commune.
    let convert = |tl_frames: i64| -> i64 {
        if same_rate { tl_frames } else { (tl_frames as f64 / tl_rate * info.fps).round() as i64 }
    };

    let film_tc: Timecode = info.file_timecode;
    let first = list.events.first().map(|e| e.start).unwrap_or(0);
    let by_tc: Vec<i64> = list.events.iter().map(|e| convert(e.start as i64) - convert(film_tc.start as i64)).collect();
    let inside = |v: &[i64]| v.iter().filter(|f| **f >= 0 && (**f as u64) < info.frame_count).count();
    let (positions, aligned) = if inside(&by_tc) * 2 >= list.events.len() {
        (by_tc, false)
    } else {
        let origin = list.start.unwrap_or(first) as i64;
        (list.events.iter().map(|e| convert(e.start as i64 - origin)).collect(), true)
    };
    if aligned {
        warnings.push(format!(
            "The film's timecode ({}) does not match the timeline: its first frame was aligned with the start of the timeline.",
            film_tc.start_label()
        ));
    }

    let mut names = BTreeMap::new();
    let mut cuts = Vec::new();
    let mut outside = 0usize;
    for (pos, e) in positions.iter().zip(&list.events) {
        if *pos < 0 || *pos as u64 >= info.frame_count {
            outside += 1;
            continue;
        }
        let f = *pos as u64;
        names.insert(f, e.name.clone());
        if f > 0 {
            cuts.push(f);
        }
    }
    if outside > 0 {
        warnings.push(format!("{outside} events fall outside the film and were ignored."));
    }
    if names.is_empty() {
        return Err("None of the events of this edit list fall inside the film.".into());
    }
    // Avant le premier événement (amorce) : plan sans nom.
    names.entry(0).or_default();
    cuts.sort_unstable();
    cuts.dedup();
    Ok(ImportedCuts {
        format: list.format.to_string(),
        file_name: file_name.to_string(),
        shots: cuts.len() + 1,
        cuts,
        names,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::tests::sample_info;

    fn film(fps_num: u32, fps_den: u32, frames: u64, tc: &str) -> VideoInfo {
        let mut i = sample_info(1920, 1080, fps_num, fps_den, frames);
        i.file_timecode = Timecode::from_tag(Some(tc), i.fps);
        i.timecode = i.file_timecode;
        i
    }

    const EDL: &str = "TITLE: Timeline 1
FCM: NON-DROP FRAME

001  AX       V     C        00:00:00:00 00:00:04:12 01:00:00:00 01:00:04:12
* FROM CLIP NAME: A001_C003.mov

002  AX       AA    C        00:00:10:00 00:00:14:12 01:00:04:12 01:00:09:00
003  AX       V     C        00:00:02:00 00:00:02:00 01:00:04:12 01:00:04:12
003  BL       V     D    024 00:00:00:00 00:00:06:00 01:00:04:12 01:00:10:12
* FROM CLIP NAME: B002_C010.mov
004  AX       V     C        00:01:00:00 00:01:03:00 01:00:10:12 01:00:13:12
* FROM CLIP NAME: C003.mov
";

    #[test]
    fn edl_cmx3600() {
        let info = film(25, 1, 25 * 60, "01:00:00:00");
        let c = map_to_film(parse_edl(EDL).unwrap(), &info, "t.edl").unwrap();
        // 01:00:04:12 → 112, 01:00:10:12 → 262 ; la piste audio (AA) est ignorée.
        assert_eq!(c.cuts, vec![112, 262]);
        assert_eq!(c.shots, 3);
        assert_eq!(c.name_at(0), Some("A001_C003.mov"));
        assert_eq!(c.name_at(150), Some("B002_C010.mov"), "fondu : le nom de la ligne D");
        assert_eq!(c.name_at(300), Some("C003.mov"));
        assert!(c.warnings.is_empty(), "{:?}", c.warnings);
    }

    #[test]
    fn edl_sur_un_film_sans_timecode_est_alignee() {
        let info = film(25, 1, 25 * 60, "00:00:00:00");
        let c = map_to_film(parse_edl(EDL).unwrap(), &info, "t.edl").unwrap();
        assert_eq!(c.cuts, vec![112, 262]);
        assert!(c.warnings.iter().any(|w| w.contains("aligned")));
    }

    #[test]
    fn edl_drop_frame() {
        let edl = "FCM: DROP FRAME\n001  AX V C 00:00:00;00 00:01:00;02 01:00:00;00 01:01:00;02\n002  AX V C 00:00:00;00 00:00:01;00 01:01:00;02 01:01:01;02\n";
        let info = film(30000, 1001, 30 * 120, "01:00:00;00");
        let c = map_to_film(parse_edl(edl).unwrap(), &info, "t.edl").unwrap();
        assert_eq!(c.cuts, vec![1800], "01:01:00;02 = 1 800 images après 01:00:00;00");
    }

    #[test]
    fn otio() {
        let otio = r#"{"OTIO_SCHEMA":"Timeline.1","name":"T",
          "global_start_time":{"OTIO_SCHEMA":"RationalTime.1","rate":24.0,"value":86400.0},
          "tracks":{"OTIO_SCHEMA":"Stack.1","children":[
            {"OTIO_SCHEMA":"Track.1","kind":"Video","children":[
              {"OTIO_SCHEMA":"Clip.2","name":"A","source_range":{"start_time":{"rate":24.0,"value":10},"duration":{"rate":24.0,"value":48}}},
              {"OTIO_SCHEMA":"Transition.1","name":"x"},
              {"OTIO_SCHEMA":"Gap.1","source_range":{"start_time":{"rate":24.0,"value":0},"duration":{"rate":24.0,"value":24}}},
              {"OTIO_SCHEMA":"Clip.2","name":"B","source_range":{"start_time":{"rate":24.0,"value":0},"duration":{"rate":24.0,"value":100}}}
            ]},
            {"OTIO_SCHEMA":"Track.1","kind":"Audio","children":[
              {"OTIO_SCHEMA":"Clip.2","name":"snd","source_range":{"start_time":{"rate":24.0,"value":0},"duration":{"rate":24.0,"value":7}}}
            ]}]}}"#;
        let l = parse_otio(otio).unwrap();
        assert_eq!(l.start, Some(86_400));
        assert_eq!(l.events.iter().map(|e| e.start - 86_400).collect::<Vec<_>>(), vec![0, 48, 72]);
        let c = map_to_film(l, &film(24, 1, 200, "01:00:00:00"), "t.otio").unwrap();
        assert_eq!(c.cuts, vec![48, 72]);
        assert_eq!(c.name_at(100), Some("B"));
        assert_eq!(c.name_at(50), None, "plan noir (gap) sans nom");
    }

    #[test]
    fn fcp7_xml() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="5"><sequence><name>T</name>
  <rate><timebase>24</timebase><ntsc>TRUE</ntsc></rate>
  <timecode><rate><timebase>24</timebase><ntsc>TRUE</ntsc></rate><string>01:00:00:00</string><frame>86400</frame><displayformat>NDF</displayformat></timecode>
  <media><video><track>
    <clipitem id="1"><name>A001.mov</name><start>0</start><end>50</end></clipitem>
    <transitionitem><start>40</start><end>60</end></transitionitem>
    <clipitem id="2"><name>B001.mov</name><start>-1</start><end>120</end></clipitem>
    <clipitem id="3"><name>off</name><enabled>FALSE</enabled><start>120</start><end>130</end></clipitem>
    <clipitem id="4"><name>C001.mov</name><start>130</start><end>200</end></clipitem>
  </track></video></media></sequence></xmeml>"#;
        let l = parse_fcp7_xml(xml).unwrap();
        assert!((l.rate - 23.976).abs() < 0.001);
        let c = map_to_film(l, &film(24000, 1001, 240, "01:00:00:00"), "t.xml").unwrap();
        assert_eq!(c.cuts, vec![40, 130], "fondu : coupe au début du fondu ; clip désactivé ignoré");
        assert_eq!(c.name_at(41), Some("B001.mov"));
        assert!(parse_xml_doc("<!DOCTYPE x [<!ENTITY a \"aaaa\">]><x>&a;</x>").is_err(), "DTD refusée");
    }

    #[test]
    fn fcpxml() {
        let xml = r#"<?xml version="1.0"?><fcpxml version="1.10">
<resources><format id="r1" frameDuration="1001/24000s" width="1920" height="1080"/></resources>
<library><event><project name="P"><sequence format="r1" tcStart="3603.6s" tcFormat="NDF"><spine>
  <asset-clip name="A" offset="3603.6s" duration="2002/24000s"/>
  <transition name="Cross" offset="3603.6834s" duration="1001/24000s"/>
  <gap name="Gap" offset="86488402/24000s" duration="22022/24000s"/>
  <asset-clip name="B" offset="86510424/24000s" duration="10010/24000s"><asset-clip lane="1" name="top" offset="0s" duration="1s"/></asset-clip>
</spine></sequence></project></event></library></fcpxml>"#;
        let l = parse_fcpxml(xml).unwrap();
        assert_eq!(l.start, Some(86_400));
        let c = map_to_film(l, &film(24000, 1001, 100, "01:00:00:00"), "t.fcpxml").unwrap();
        assert_eq!(c.cuts, vec![2, 24], "gap à 2 images, B à 24");
        assert!(c.warnings.iter().any(|w| w.contains("lanes")));
    }

    #[test]
    fn cadences_differentes_et_erreurs() {
        let otio = r#"{"OTIO_SCHEMA":"Timeline.1","tracks":{"children":[{"kind":"Video","children":[
            {"OTIO_SCHEMA":"Clip.2","name":"A","source_range":{"duration":{"rate":50.0,"value":100}}},
            {"OTIO_SCHEMA":"Clip.2","name":"B","source_range":{"duration":{"rate":50.0,"value":100}}}]}]}}"#;
        let c = map_to_film(parse_otio(otio).unwrap(), &film(25, 1, 500, "00:00:00:00"), "t.otio").unwrap();
        assert_eq!(c.cuts, vec![50], "100 images à 50 i/s = 50 images à 25 i/s");
        assert!(c.warnings.iter().any(|w| w.contains("fps")));
        assert!(parse_edit_list("a.txt", "").is_err());
        assert!(parse_edl("TITLE: vide\n").is_err());
        assert!(parse_otio("{").is_err());
        let far = "001  AX V C 00:00:00:00 00:00:01:00 05:00:00:00 05:00:01:00\n";
        let info = film(25, 1, 10, "01:00:00:00");
        assert!(map_to_film(parse_edl(far).unwrap(), &info, "t.edl").is_ok(), "un seul événement : aligné");
    }
}
