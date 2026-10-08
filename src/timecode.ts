// Miroir exact de photogramme-core/src/timecode.rs : cadence nominale,
// non-drop (HH:MM:SS:FF) et drop-frame 29,97 / 59,94 (HH:MM:SS;FF).

import type { Timecode, VideoInfo } from "./types";

const dropCount = (rate: number) => (rate >= 60 ? 4 : 2);

/** Nombre d'images comptées → libellé. */
export function formatCount(count: number, rate: number, drop: boolean): string {
  const r = Math.max(1, Math.round(rate));
  let n = Math.max(0, Math.floor(count));
  if (drop) {
    const d = dropCount(r);
    const perMin = r * 60 - d;
    const per10 = r * 600 - d * 9;
    const tens = Math.floor(n / per10);
    const rem = n % per10;
    n += d * 9 * tens;
    if (rem > d) n += d * Math.floor((rem - d) / perMin);
  }
  const ff = n % r;
  const totalS = Math.floor(n / r);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${p(Math.floor(totalS / 3600))}:${p(Math.floor(totalS / 60) % 60)}:${p(totalS % 60)}${drop ? ";" : ":"}${p(ff)}`;
}

function day(tc: Timecode): number {
  const r = tc.rate;
  return tc.drop ? r * 86400 - dropCount(r) * (24 * 60 - 24 * 6) : r * 86400;
}

/** Timecode de l'image `frame` du film (départ du fichier compris). */
export function tcLabel(tc: Timecode, frame: number): string {
  return formatCount((tc.start + Math.max(0, Math.floor(frame))) % day(tc), tc.rate, tc.drop);
}

/** Timecode d'une image du film ouvert. */
export const tcOf = (info: VideoInfo, frame: number) => tcLabel(info.timecode, frame);

/** Durée (depuis 00:00:00:00, non-drop) : longueur d'un plan, d'un film. */
export function frameToTc(frame: number, fps: number): string {
  return formatCount(frame, Math.max(1, Math.round(fps)), false);
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatFps(fps: number): string {
  return `${Math.round(fps * 1000) / 1000} fps`;
}
