// Vérification de la synchro visionneuse ↔ capture.
//
// La visionneuse est la balise <video> de WebView2 ; les captures viennent
// de FFmpeg. Les deux devraient montrer la même image pour un numéro
// donné, mais un fichier au début décalé (édit-list MP4, délai d'images B)
// pourrait les décaler d'une image. On compare donc, sur une image arrêtée,
// ce que montre la visionneuse aux images N−1, N et N+1 de FFmpeg.

import { api } from "./api";
import type { Src } from "./scopes";

const W = 96;

/** Luminance réduite (moyenne par pixel), pour comparer des images. */
export function lumaOf(src: Src): Float32Array {
  const out = new Float32Array(src.width * src.height);
  for (let i = 0, p = 0; p < out.length; p++, i += 4) {
    out[p] = 0.2126 * src.rgba[i] + 0.7152 * src.rgba[i + 1] + 0.0722 * src.rgba[i + 2];
  }
  return out;
}

/** Écart moyen après retrait de la moyenne (insensible à un léger écart de niveau). */
export function distance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return Infinity;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= a.length;
  mb /= b.length;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - ma - (b[i] - mb));
  return d / a.length;
}

/**
 * Décalage le plus probable parmi `candidates` ; `null` si la mesure ne
 * permet pas de trancher (plan fixe : les images voisines se ressemblent).
 */
export function bestOffset(shown: Float32Array, candidates: [number, Float32Array][]): number | null {
  const scored = candidates.map(([o, f]) => [o, distance(shown, f)] as [number, number]).sort((a, b) => a[1] - b[1]);
  if (scored.length < 2) return null;
  const [best, second] = scored;
  // Il faut une différence nette entre la meilleure et la suivante.
  return second[1] - best[1] > Math.max(1.5, best[1] * 0.5) ? best[0] : null;
}

export type SyncResult = { kind: "ok" } | { kind: "offset"; offset: number } | { kind: "unknown"; reason: string };

/**
 * Mesure sur l'image arrêtée `frame` de la visionneuse. Résultat `offset` :
 * l'image affichée sous le numéro N est en réalité l'image N + offset.
 */
export async function checkSync(video: HTMLVideoElement, frame: number, frameCount: number): Promise<SyncResult> {
  const offsets = [-1, 0, 1].filter((o) => frame + o >= 0 && frame + o < frameCount);
  const probes: [number, Float32Array][] = [];
  let size: [number, number] | null = null;
  for (const o of offsets) {
    const p = await api.grabProbe(frame + o, W);
    size = [p.width, p.height];
    probes.push([o, lumaOf(p)]);
  }
  if (!size) return { kind: "unknown", reason: "No frame." };
  const [w, h] = size;
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { kind: "unknown", reason: "Canvas unavailable." };
  let shown: Float32Array;
  try {
    ctx.drawImage(video, 0, 0, w, h);
    shown = lumaOf({ rgba: ctx.getImageData(0, 0, w, h).data, width: w, height: h });
  } catch {
    return { kind: "unknown", reason: "The viewer image cannot be read back on this system." };
  }
  const best = bestOffset(shown, probes);
  if (best === null) return { kind: "unknown", reason: "Static shot: move to a frame with motion and check again." };
  return best === 0 ? { kind: "ok" } : { kind: "offset", offset: best };
}
