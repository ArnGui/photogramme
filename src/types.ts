// Miroir des structures Rust (photogramme-core), sérialisées en camelCase.

export interface Timecode {
  /** Cadence nominale (24, 25, 30…). */
  rate: number;
  drop: boolean;
  /** Numéro (en images comptées) du timecode de la première image. */
  start: number;
}

export interface VideoInfo {
  path: string;
  fileName: string;
  width: number;
  height: number;
  sarNum: number;
  sarDen: number;
  rotation: number;
  /** Taille des photogrammes exportés : pixels carrés, rotation appliquée. */
  outWidth: number;
  outHeight: number;
  fpsNum: number;
  fpsDen: number;
  fps: number;
  duration: number;
  frameCount: number;
  codec: string;
  profile: string;
  pixFmt: string;
  colorMatrix: string;
  colorRange: string;
  colorTransfer: string;
  /** Timecode affiché et écrit (selon le réglage). */
  timecode: Timecode;
  fileTimecode: Timecode;
  nvdecCompatible: boolean;
  warnings: string[];
}

export type Chroma = "4:4:4" | "4:2:0";
export type ImageFormat = "jpeg" | "png";
export type ColorProfile = "untagged" | "rec709" | "srgb";
export type TimecodeMode = "file" | "zero";

export type Pick =
  | { mode: "first" }
  | { mode: "middle" }
  | { mode: "last" }
  | { mode: "spread"; count: number };

export type DecoderPref = "auto" | "gpu" | "cpu";
export type BatchMode = "shots" | "interval" | "spread";
export type PaletteSort = "share" | "hue" | "lightness";
export type PaletteWeighting = "area" | "accents";
export type BarcodeMode = "vertical" | "average";
export type ScopeKind = "waveform" | "parade" | "vectorscope" | "histogram";
export type StripMode = "barcode" | "frames" | "off";
export type Theme = "dark" | "light";
/** Habillage de l'interface ; ne touche jamais la visionneuse, les scopes ni les fichiers. */
export type Skin = "studio" | "atomic" | "mission";
/** Couleur d'accent du skin Studio ; l'or est celui des versions 0.5. */
export type Accent = "gold" | "coral" | "teal" | "blue";

export type Anchor =
  | "topLeft" | "top" | "topRight"
  | "left" | "center" | "right"
  | "bottomLeft" | "bottom" | "bottomRight";

export interface Font {
  family: string;
  size: number;
  weight: number;
  italic: boolean;
}

export interface TextItem {
  id: string;
  enabled: boolean;
  template: string;
  font: Font;
  color: string;
  opacity: number;
  uppercase: boolean;
  letterSpacing: number;
  anchor: Anchor;
  region: "image" | "canvas";
  offsetX: number;
  offsetY: number;
  shadow: boolean;
  boxEnabled: boolean;
  boxColor: string;
  boxOpacity: number;
  boxPadding: number;
}

export interface PaletteBand {
  enabled: boolean;
  placement: "below" | "inside";
  style: "squares" | "fill";
  size: number;
  gap: number;
  margin: number;
  align: "left" | "center" | "right";
  showHex: boolean;
  hexFont: Font;
  hexColor: string;
}

export interface ScopeInset {
  enabled: boolean;
  kind: ScopeKind;
  anchor: Anchor;
  region: "image" | "canvas";
  size: number;
  opacity: number;
  offsetX: number;
  offsetY: number;
}

export interface OverlayPreset {
  name: string;
  frame: {
    padTop: number;
    padRight: number;
    padBottom: number;
    padLeft: number;
    background: string;
  };
  palette: PaletteBand;
  texts: TextItem[];
  scope: ScopeInset;
}

export type SheetPage = "a4" | "a3" | "letter" | "tabloid" | "image";
export type SheetFormat = "pdf" | "jpeg" | "png";

export interface SheetSettings {
  columns: number;
  page: SheetPage;
  landscape: boolean;
  format: SheetFormat;
  dpi: number;
  imageWidth: number;
  theme: "dark" | "light";
  title: string;
  showTc: boolean;
  showShot: boolean;
  showClip: boolean;
  showFrame: boolean;
  showPalette: boolean;
}

export interface Settings {
  quality: number;
  chroma: Chroma;
  outputDir: string | null;
  export: {
    subfolder: boolean;
    overlay: boolean;
    csv: boolean;
    csvPalette: boolean;
    format: ImageFormat;
    color: ColorProfile;
    timecode: TimecodeMode;
  };
  shots: { threshold: number; minSeconds: number; pick: Pick; decoder: DecoderPref };
  batch: { mode: BatchMode; intervalSeconds: number; spreadCount: number };
  palette: { count: number; sort: PaletteSort; ignoreBars: boolean; weighting: PaletteWeighting };
  barcode: { width: number; height: number; mode: BarcodeMode };
  overlay: OverlayPreset;
  sheet: SheetSettings;
  updates: { checkAtStartup: boolean; skipped: string | null };
  ui: { scopesOpen: boolean; scope: ScopeKind; strip: StripMode; theme: Theme; skin: Skin; effects: boolean; accent: Accent; muted: boolean };
}

export interface CaptureResult {
  path: string;
  fileName: string;
  frame: number;
  timecode: string;
  bytes: number;
  width: number;
  height: number;
  quality: number;
  shot: number | null;
}

export interface Swatch {
  hex: string;
  rgb: [number, number, number];
  share: number;
  lab: [number, number, number];
}

export interface AnalysisSummary {
  id: number;
  frames: number;
  decoder: "gpu" | "cpu";
  note: string | null;
  seconds: number;
  thumbs: number;
  thumbWidth: number;
  thumbHeight: number;
  memoryMb: number;
}

export type ShotSource = "detect" | "imported";

export interface ShotView {
  index: number;
  start: number;
  end: number;
  /** −1 : coupe ajoutée à la main ou importée. */
  score: number;
  thumb: number | null;
  clip: string | null;
}

export interface TabView {
  key: string;
  fileName: string;
  folder: string;
  /** Fichier introuvable à son emplacement (déplacé, disque débranché). */
  missing: boolean;
}

export interface TabsView {
  active: string | null;
  tabs: TabView[];
}

/** Projet rechargé à l'ouverture d'un film. */
export interface Restored {
  ui: unknown;
  analysis: AnalysisSummary | null;
  imported: ImportedCuts | null;
  filmChanged: boolean;
}

export interface ImportedCuts {
  format: string;
  fileName: string;
  cuts: number[];
  shots: number;
  warnings: string[];
}

export interface ShotSpan {
  index: number;
  start: number;
  end: number;
}

export type BatchRequest =
  | { kind: "shots"; shots: ShotSpan[]; pick: Pick }
  | { kind: "interval"; seconds: number }
  | { kind: "spread"; count: number };

/** Points d'entrée et de sortie (bornes incluses). */
export interface FrameRange {
  start: number;
  end: number;
}

export type BatchTarget = { kind: "stills"; compose: boolean } | { kind: "sheet"; cellWidth: number };

export interface BatchPlan {
  count: number;
  first: number[];
}

export interface BatchStarted {
  job: number;
  total: number;
  dir: string;
  width: number;
  height: number;
}

export type JobEvent =
  | { kind: "progress"; phase: string; done: number; total: number }
  | { kind: "written"; capture: CaptureResult }
  | { kind: "done"; written: number; dir: string; csv: string | null; file: string | null }
  | { kind: "failed"; message: string }
  | { kind: "cancelled" };

/** Image exacte reçue du Rust pour composition (paquet binaire décodé). */
export interface FrameData {
  frame: number;
  timecode: string;
  width: number;
  height: number;
  palette: Swatch[];
  shot: number | null;
  clip: string | null;
  job: number | null;
  total: number | null;
  rgba: Uint8ClampedArray;
  /** Dessinée depuis la visionneuse en attendant l'image exacte de FFmpeg. */
  provisional?: boolean;
}

export type FilmEvent = { kind: "opened"; info: VideoInfo } | { kind: "failed"; message: string };

export interface AppInfo {
  version: string;
  repo: string;
  kofi: string | null;
  updatesEnabled: boolean;
}

export interface UpdateInfo {
  current: string;
  version: string | null;
  notes: string | null;
  date: string | null;
}

export type UpdateEvent = { kind: "progress"; downloaded: number; total: number | null } | { kind: "installing" };

export type Link = "repo" | "releases" | "issues" | "kofi";
