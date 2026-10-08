//! Logique métier de Photogramme, sans aucune dépendance à Tauri.
//!
//! Tout ce qui peut être testé sans fenêtre ni WebView vit ici :
//! lecture du JSON de ffprobe, construction des arguments FFmpeg,
//! analyse des plans, listes de montage, palette, code-barre, timecode,
//! nommage des fichiers, encodage JPEG/PNG, profils ICC, planche contact,
//! préréglages et réglages.
//! La couche Tauri (`src-tauri/src`) ne fait qu'orchestrer.

pub mod analysis;
pub mod barcode;
pub mod batch;
pub mod capture;
pub mod color;
pub mod cuts;
pub mod ffargs;
pub mod jpeg;
pub mod naming;
pub mod overlay;
pub mod packet;
pub mod palette;
pub mod pick;
pub mod probe;
pub mod project;
pub mod settings;
pub mod sheet;
pub mod shots;
pub mod swatches;
pub mod timecode;

pub use analysis::{analysis_args, Analysis, Analyzer, Decoder};
pub use capture::{capture_converted, capture_from_raw, capture_from_raw_shot, capture_from_rgba, export_csv, CaptureResult, CsvRow};
pub use color::ColorProfile;
pub use ffargs::{capture_args, capture_args_fmt, capture_args_sized, seek_seconds};
pub use jpeg::{encode_image, encode_rgb, Chroma, ImageFormat};
pub use overlay::OverlayPreset;
pub use palette::{dominant_colors, PaletteOptions, Swatch};
pub use pick::{plan_items, BatchItem, BatchRequest, FrameRange, Pick, ShotSpan};
pub use probe::{parse_probe, probe_args, TimecodeMode, VideoInfo};
pub use settings::Settings;
pub use shots::Shot;
pub use timecode::{frame_to_tc, Timecode};
