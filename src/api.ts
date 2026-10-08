// Accès typé aux commandes Rust. L'interface n'a aucune autre porte vers
// le système : pas de shell, pas de lecture de fichiers, pas de sélecteur
// de fichiers, pas de chemin envoyé (le glisser-déposer est capté en Rust).

import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { decodePacket, decodeRaw, encodePacket } from "./packet";
import type {
  AnalysisSummary, AppInfo, BarcodeMode, BatchPlan, BatchRequest, BatchStarted, BatchTarget, CaptureResult, FilmEvent,
  FrameData, FrameRange, ImportedCuts, JobEvent, Link, OverlayPreset, Restored, Settings, ShotSource, ShotView, TabsView,
  UpdateEvent, UpdateInfo, VideoInfo,
} from "./types";

export const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "mkv"];

export interface ProbeFrame {
  frame: number;
  timecode: string;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export const api = {
  pickVideo: () => invoke<VideoInfo | null>("pick_video"),
  currentVideo: () => invoke<VideoInfo | null>("current_video"),

  /** Onglets : films récents, désignés par une clé (jamais par un chemin). */
  tabsList: () => invoke<TabsView>("tabs_list"),
  tabOpen: (key: string) => invoke<VideoInfo>("tab_open", { key }),
  tabClose: (key: string) => invoke<TabsView>("tab_close", { key }),
  /** Projet du film ouvert : état de l'interface, coupes importées, analyse. */
  projectRestore: () => invoke<Restored>("project_restore"),
  /** `path` : film auquel appartient cet état ; ignoré si un autre film a été ouvert entre-temps. */
  projectSave: (path: string, ui: unknown) => invoke<void>("project_save", { path, ui }),
  projectCacheSize: () => invoke<number>("project_cache_size"),
  projectCacheClear: () => invoke<number>("project_cache_clear"),
  /** Films déposés sur la fenêtre : ouverts côté Rust, résultat ici. */
  onFilm: (cb: (e: FilmEvent) => void) => listen<FilmEvent>("film", (e) => cb(e.payload)),

  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (next: Settings) => invoke<Settings>("update_settings", { new: next }),
  pickOutputDir: () => invoke<Settings | null>("pick_output_dir"),
  capture: (frame: number) => invoke<CaptureResult>("capture", { frame }),
  reveal: (path: string) => invoke<void>("reveal", { path }),
  /** Ouvre le dossier de sortie (`null`) ou un sous-dossier d'export dans l'Explorateur. */
  openFolder: (path: string | null = null) => invoke<void>("open_folder", { path }),
  savePalette: (frame: number) => invoke<string[]>("save_palette", { frame }),

  /** Image exacte (RVBA, convertie selon le profil d'export) + palette. */
  grabFrame: async (frame: number): Promise<FrameData> =>
    decodePacket(await invoke<ArrayBuffer>("grab_frame", { frame })),
  /** Petite image brute, pour vérifier la synchro de la visionneuse. */
  grabProbe: async (frame: number, width: number): Promise<ProbeFrame> => {
    const { header, rgba } = decodeRaw<Omit<ProbeFrame, "rgba">>(await invoke<ArrayBuffer>("grab_probe", { frame, width }));
    return { ...header, rgba };
  },

  /** Écrit une image composée ; le Rust choisit le nom et le dossier. */
  writeComposed: (header: { frame: number; width: number; height: number; job?: number | null; shot?: number | null }, rgba: Uint8ClampedArray) =>
    invoke<CaptureResult>("write_composed", encodePacket(header, rgba)),

  analyze: (onEvent: (e: JobEvent) => void) => {
    const ch = new Channel<JobEvent>();
    ch.onmessage = onEvent;
    return invoke<AnalysisSummary>("analyze", { onEvent: ch });
  },
  cancelAnalysis: () => invoke<void>("cancel_analysis"),
  listShots: (source: ShotSource, threshold: number, minSeconds: number, extraCuts: number[]) =>
    invoke<ShotView[]>("list_shots", { source, threshold, minSeconds, extraCuts }),
  importCuts: () => invoke<ImportedCuts | null>("import_cuts"),
  clearCuts: () => invoke<void>("clear_cuts"),

  barcodePreview: async (width: number, height: number, mode: BarcodeMode): Promise<Blob> =>
    new Blob([await invoke<ArrayBuffer>("barcode_preview", { width, height, mode })], { type: "image/jpeg" }),
  exportBarcode: () => invoke<CaptureResult>("export_barcode"),

  batchPlan: (request: BatchRequest, range: FrameRange | null) => invoke<BatchPlan>("batch_plan", { request, range }),
  batchStart: (request: BatchRequest, range: FrameRange | null, target: BatchTarget, onEvent: (e: JobEvent) => void) => {
    const ch = new Channel<JobEvent>();
    ch.onmessage = onEvent;
    return invoke<BatchStarted>("batch_start", { request, range, target, onEvent: ch });
  },
  /** Image suivante d'un export composé, ou `null` quand tout est décodé. */
  batchPull: async (job: number): Promise<FrameData | null> => {
    const buf = await invoke<ArrayBuffer>("batch_pull", { job });
    return buf.byteLength === 0 ? null : decodePacket(buf);
  },
  sheetPage: (job: number, width: number, height: number, rgba: Uint8ClampedArray) =>
    invoke<number>("sheet_page", encodePacket({ job, width, height }, rgba)),
  batchFinish: (job: number) => invoke<void>("batch_finish", { job }),
  batchCancel: () => invoke<void>("batch_cancel"),

  listPresets: () => invoke<OverlayPreset[]>("list_presets"),
  savePreset: (preset: OverlayPreset) => invoke<OverlayPreset[]>("save_preset", { preset }),
  deletePreset: (name: string) => invoke<OverlayPreset[]>("delete_preset", { name }),
  openPresetsFolder: () => invoke<void>("open_presets_folder"),

  appInfo: () => invoke<AppInfo>("app_info"),
  openLink: (link: Link) => invoke<void>("open_link", { link }),
  checkUpdate: () => invoke<UpdateInfo>("check_update"),
  installUpdate: (onEvent: (e: UpdateEvent) => void) => {
    const ch = new Channel<UpdateEvent>();
    ch.onmessage = onEvent;
    return invoke<void>("install_update", { onEvent: ch });
  },
};

/** URL d'une vignette de plan servie depuis la mémoire par le protocole `thumb`.
 * Séparateur « - » : `convertFileSrc` encoderait un « / » en %2F. */
export const thumbUrl = (analysisId: number, frame: number) => convertFileSrc(`${analysisId}-${frame}`, "thumb");
/** Vignette la plus proche de `frame` (bande d'images au-dessus de la timeline). */
export const nearThumbUrl = (analysisId: number, frame: number) => convertFileSrc(`${analysisId}-n${frame}`, "thumb");

export const CANCELLED = "Cancelled.";

/** Les erreurs Rust arrivent en chaîne ; tout le reste est normalisé. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Unexpected error.";
}
