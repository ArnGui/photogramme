// État de l'interface gardé dans le projet de chaque film.
//
// Le Rust l'écrit tel quel (borné, écriture atomique) ; c'est ici qu'on le
// relit avec méfiance : un fichier d'une ancienne version, abîmé ou modifié
// à la main ne doit jamais casser l'ouverture d'un film.

import type { CaptureResult, ShotSource } from "./types";

export type SessionTab = "extract" | "captures" | "settings";
export type SessionOutput = "stills" | "sheet";

export interface SessionUi {
  v: 1;
  frame: number;
  source: ShotSource;
  removedCuts: number[];
  addedCuts: number[];
  unchecked: number[];
  marks: { start: number | null; end: number | null };
  captures: CaptureResult[];
  output: SessionOutput;
  tab: SessionTab;
}

/** Captures gardées dans le projet (les plus récentes). */
export const MAX_SESSION_CAPTURES = 2000;
const MAX_FRAMES_LIST = 20000;

export function snapshot(s: {
  frame: number; source: ShotSource; removedCuts: Set<number>; addedCuts: Set<number>; unchecked: Set<number>;
  marks: { start: number | null; end: number | null }; captures: CaptureResult[]; output: SessionOutput; tab: SessionTab;
}): SessionUi {
  const sorted = (x: Set<number>) => [...x].sort((a, b) => a - b);
  return {
    v: 1,
    frame: s.frame,
    source: s.source,
    removedCuts: sorted(s.removedCuts),
    addedCuts: sorted(s.addedCuts),
    unchecked: sorted(s.unchecked),
    marks: s.marks,
    captures: s.captures.slice(0, MAX_SESSION_CAPTURES),
    output: s.output,
    tab: s.tab,
  };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isFrame = (x: unknown, frames: number): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) < frames;

function frameList(x: unknown, frames: number): number[] {
  if (!Array.isArray(x)) return [];
  return x.slice(0, MAX_FRAMES_LIST).filter((f): f is number => isFrame(f, frames));
}

function capture(x: unknown): CaptureResult | null {
  if (!isObj(x)) return null;
  const str = (k: string) => typeof x[k] === "string";
  const num = (k: string) => typeof x[k] === "number" && Number.isFinite(x[k]);
  if (!str("path") || !str("fileName") || !str("timecode") || !num("frame") || !num("bytes")) return null;
  if (!num("width") || !num("height") || !num("quality")) return null;
  if (x.shot !== null && !num("shot")) return null;
  return {
    path: x.path as string, fileName: x.fileName as string, frame: x.frame as number, timecode: x.timecode as string,
    bytes: x.bytes as number, width: x.width as number, height: x.height as number, quality: x.quality as number,
    shot: (x.shot as number | null) ?? null,
  };
}

/** Relit un état enregistré pour un film de `frames` images ; `null` s'il est inutilisable. */
export function parseSession(x: unknown, frames: number): SessionUi | null {
  if (!isObj(x) || x.v !== 1 || frames <= 0) return null;
  const marks = isObj(x.marks) ? x.marks : {};
  const mark = (m: unknown) => (isFrame(m, frames) ? m : null);
  return {
    v: 1,
    frame: isFrame(x.frame, frames) ? x.frame : 0,
    source: x.source === "imported" ? "imported" : "detect",
    removedCuts: frameList(x.removedCuts, frames),
    addedCuts: frameList(x.addedCuts, frames),
    unchecked: frameList(x.unchecked, frames),
    marks: { start: mark(marks.start), end: mark(marks.end) },
    captures: Array.isArray(x.captures)
      ? x.captures.slice(0, MAX_SESSION_CAPTURES).map(capture).filter((c): c is CaptureResult => c !== null)
      : [],
    output: x.output === "sheet" ? "sheet" : "stills",
    tab: x.tab === "captures" || x.tab === "settings" ? x.tab : "extract",
  };
}
