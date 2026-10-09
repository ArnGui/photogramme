//! Choix des images à exporter : par plan, par intervalle, ou réparties.

use serde::{Deserialize, Serialize};

/// Nombre maximal d'images d'un export en lot (garde-fou disque et mémoire).
pub const MAX_BATCH: usize = 20_000;

/// Image(s) retenue(s) dans un plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum Pick {
    First,
    #[default]
    Middle,
    Last,
    /// N images réparties dans le plan.
    Spread { count: u32 },
}

/// Plan envoyé par l'interface (après fusions et décochages).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotSpan {
    pub index: u32,
    pub start: u64,
    pub end: u64,
}

/// Demande d'export en lot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BatchRequest {
    Shots { shots: Vec<ShotSpan>, pick: Pick },
    Interval { seconds: f64 },
    Spread { count: u32 },
}

impl BatchRequest {
    /// Nom court pour le sous-dossier d'export.
    pub fn slug(&self) -> &'static str {
        match self {
            BatchRequest::Shots { .. } => "shots",
            BatchRequest::Interval { .. } => "interval",
            BatchRequest::Spread { .. } => "spread",
        }
    }
}

/// Une image à exporter, avec le plan d'origine éventuel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItem {
    pub frame: u64,
    pub shot: Option<u32>,
}

/// N positions réparties dans [start, end) : milieu de N tranches égales.
fn spread(start: u64, end: u64, n: u64) -> Vec<u64> {
    let len = end.saturating_sub(start);
    if len == 0 || n == 0 {
        return Vec::new();
    }
    let n = n.min(len);
    let mut v: Vec<u64> = (0..n).map(|i| start + ((2 * i + 1) * len) / (2 * n)).collect();
    v.dedup();
    v
}

/// Images retenues dans un plan [start, end).
pub fn pick_in_span(start: u64, end: u64, pick: Pick) -> Vec<u64> {
    if end <= start {
        return Vec::new();
    }
    match pick {
        Pick::First => vec![start],
        Pick::Middle => vec![start + (end - start - 1) / 2],
        Pick::Last => vec![end - 1],
        Pick::Spread { count } => spread(start, end, count.clamp(1, 100) as u64),
    }
}

/// Plage de travail (points d'entrée et de sortie), bornes incluses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameRange {
    pub start: u64,
    /// Dernière image incluse.
    pub end: u64,
}

/// Liste triée et dédoublonnée des images à exporter, limitée à `range`
/// (points d'entrée et de sortie) si elle est donnée.
pub fn plan_items(
    req: &BatchRequest,
    range: Option<FrameRange>,
    frame_count: u64,
    fps_num: u32,
    fps_den: u32,
) -> Result<Vec<BatchItem>, String> {
    if frame_count == 0 {
        return Err("Empty film.".into());
    }
    // [lo, hi) : toute la plage utile.
    let (lo, hi) = match range {
        Some(r) if r.start <= r.end && r.start < frame_count => (r.start, (r.end + 1).min(frame_count)),
        Some(_) => return Err("The in and out points are outside the film.".into()),
        None => (0, frame_count),
    };
    let mut items: Vec<BatchItem> = match req {
        BatchRequest::Shots { shots, pick } => {
            if shots.is_empty() {
                return Err("No shot selected.".into());
            }
            shots
                .iter()
                .flat_map(|s| {
                    // Plan à cheval sur un point d'entrée/sortie : on garde sa partie intérieure.
                    let (a, b) = (s.start.max(lo), s.end.min(hi));
                    pick_in_span(a, b.max(a), *pick)
                        .into_iter()
                        .map(move |frame| BatchItem { frame, shot: Some(s.index) })
                })
                .collect()
        }
        BatchRequest::Interval { seconds } => {
            if !seconds.is_finite() || *seconds <= 0.0 {
                return Err("Invalid interval.".into());
            }
            let fps = fps_num as f64 / fps_den as f64;
            let step = (seconds * fps).max(1.0);
            let n = (((hi - lo) as f64) / step).ceil() as u64;
            if n as usize > MAX_BATCH {
                return Err(too_many(n as usize));
            }
            (0..n)
                .map(|k| lo + (k as f64 * step).round() as u64)
                .filter(|f| *f < hi)
                .map(|frame| BatchItem { frame, shot: None })
                .collect()
        }
        BatchRequest::Spread { count } => {
            if *count == 0 {
                return Err("Frame count is zero.".into());
            }
            spread(lo, hi, *count as u64)
                .into_iter()
                .map(|frame| BatchItem { frame, shot: None })
                .collect()
        }
    };
    items.sort_by_key(|i| i.frame);
    items.dedup_by_key(|i| i.frame);
    if items.is_empty() {
        return Err("No frame to export.".into());
    }
    if items.len() > MAX_BATCH {
        return Err(too_many(items.len()));
    }
    Ok(items)
}

fn too_many(n: usize) -> String {
    format!("{n} frames requested: maximum {MAX_BATCH} per export. Increase the interval or lower the count.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_retenue_dans_un_plan() {
        assert_eq!(pick_in_span(10, 20, Pick::First), vec![10]);
        assert_eq!(pick_in_span(10, 20, Pick::Middle), vec![14]);
        assert_eq!(pick_in_span(10, 21, Pick::Middle), vec![15]);
        assert_eq!(pick_in_span(10, 20, Pick::Last), vec![19]);
        assert_eq!(pick_in_span(0, 12, Pick::Spread { count: 3 }), vec![2, 6, 10]);
        assert_eq!(pick_in_span(0, 2, Pick::Spread { count: 5 }), vec![0, 1], "pas plus que d'images");
        assert!(pick_in_span(5, 5, Pick::First).is_empty());
    }

    #[test]
    fn par_plans_trie_et_borne() {
        let req = BatchRequest::Shots {
            shots: vec![
                ShotSpan { index: 3, start: 72, end: 200 },
                ShotSpan { index: 1, start: 0, end: 48 },
            ],
            pick: Pick::Last,
        };
        let items = plan_items(&req, None, 120, 24, 1).unwrap();
        assert_eq!(
            items,
            vec![BatchItem { frame: 47, shot: Some(1) }, BatchItem { frame: 119, shot: Some(3) }]
        );
    }

    #[test]
    fn par_intervalle() {
        let items = plan_items(&BatchRequest::Interval { seconds: 2.0 }, None, 120, 24, 1).unwrap();
        assert_eq!(items.iter().map(|i| i.frame).collect::<Vec<_>>(), vec![0, 48, 96]);
        // 23,976 i/s : 1 s = 23,976 images, arrondi à l'image la plus proche.
        let items = plan_items(&BatchRequest::Interval { seconds: 1.0 }, None, 100, 24000, 1001).unwrap();
        assert_eq!(items.iter().map(|i| i.frame).take(4).collect::<Vec<_>>(), vec![0, 24, 48, 72]);
        assert!(plan_items(&BatchRequest::Interval { seconds: 0.0 }, None, 100, 24, 1).is_err());
        assert!(plan_items(&BatchRequest::Interval { seconds: 0.001 }, None, 10_000_000, 24, 1).is_err());
    }

    #[test]
    fn reparties_sur_le_film() {
        let items = plan_items(&BatchRequest::Spread { count: 4 }, None, 100, 24, 1).unwrap();
        assert_eq!(items.iter().map(|i| i.frame).collect::<Vec<_>>(), vec![12, 37, 62, 87]);
        assert!(plan_items(&BatchRequest::Spread { count: 0 }, None, 100, 24, 1).is_err());
    }

    #[test]
    fn limite_aux_points_d_entree_et_de_sortie() {
        let r = Some(FrameRange { start: 30, end: 89 });
        let items = plan_items(&BatchRequest::Interval { seconds: 1.0 }, r, 200, 24, 1).unwrap();
        assert_eq!(items.iter().map(|i| i.frame).collect::<Vec<_>>(), vec![30, 54, 78]);
        let items = plan_items(&BatchRequest::Spread { count: 3 }, r, 200, 24, 1).unwrap();
        assert_eq!(items.iter().map(|i| i.frame).collect::<Vec<_>>(), vec![40, 60, 80]);
        let req = BatchRequest::Shots {
            shots: vec![
                ShotSpan { index: 1, start: 0, end: 40 },
                ShotSpan { index: 2, start: 40, end: 100 },
                ShotSpan { index: 3, start: 100, end: 200 },
            ],
            pick: Pick::First,
        };
        let items = plan_items(&req, r, 200, 24, 1).unwrap();
        assert_eq!(items, vec![BatchItem { frame: 30, shot: Some(1) }, BatchItem { frame: 40, shot: Some(2) }]);
        assert!(plan_items(&req, Some(FrameRange { start: 500, end: 600 }), 200, 24, 1).is_err());
    }

    #[test]
    fn format_json_de_l_interface() {
        let r: BatchRequest = serde_json::from_str(
            r#"{"kind":"shots","shots":[{"index":1,"start":0,"end":10}],"pick":{"mode":"spread","count":3}}"#,
        )
        .unwrap();
        assert_eq!(r.slug(), "shots");
        let r: BatchRequest = serde_json::from_str(r#"{"kind":"interval","seconds":5}"#).unwrap();
        assert_eq!(r, BatchRequest::Interval { seconds: 5.0 });
        assert_eq!(serde_json::to_string(&Pick::Middle).unwrap(), r#"{"mode":"middle"}"#);
    }
}
