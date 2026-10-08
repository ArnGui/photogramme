// Instruments de mesure : forme d'onde, parade RVB, vectorscope, histogramme.
//
// Calculés sur les pixels exacts fournis par FFmpeg (ceux qui seront écrits
// dans le fichier). Une seule routine de dessin sert au panneau de la
// visionneuse, à l'aperçu d'export et à l'incrustation dans l'image : le
// tracé est composé pixel par pixel (getImageData/putImageData), donc
// identique partout. Seuls les traits de graduation passent par le Canvas.
//
// Conventions (comme un moniteur d'étalonnage) :
// - luminance Y' = 0,2126 R' + 0,7152 G' + 0,0722 B' (BT.709) ;
// - vectorscope : Cb en abscisse, Cr en ordonnée, cibles des barres 75 %,
//   ligne des tons chair à 123° (axe I) ;
// - échelle verticale 0–100 % = codes 0–255 (pleine plage, après conversion).

import type { ScopeKind } from "./types";

export interface Src {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Rapport hauteur/largeur de chaque instrument. */
export function scopeAspect(kind: ScopeKind): number {
  return kind === "vectorscope" ? 1 : 0.5;
}

/** Marge intérieure (graduations), en pixels, pour un instrument de largeur `w`. */
export function scopePad(w: number): number {
  return Math.max(4, Math.round(w * 0.04));
}

const LUMA = [0.2126, 0.7152, 0.0722] as const;

/** Cb, Cr (−0,5 … 0,5) d'une couleur RVB 0–255 (BT.709). */
export function cbcr(r: number, g: number, b: number): [number, number] {
  const y = (LUMA[0] * r + LUMA[1] * g + LUMA[2] * b) / 255;
  return [(b / 255 - y) / 1.8556, (r / 255 - y) / 1.5748];
}

/** Pas d'échantillonnage pour rester sous ~ 350 000 points. */
function stride(src: Src): number {
  return Math.max(1, Math.ceil(Math.sqrt((src.width * src.height) / 350_000)));
}

/**
 * Accumule les points de l'instrument dans une grille `w`×`h` à trois canaux
 * (R, V, B), valeurs 0–1 prêtes à être ajoutées à l'image. Pure : testée
 * sans navigateur.
 */
export function accumulate(kind: ScopeKind, src: Src, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 3);
  const pad = scopePad(w);
  const iw = Math.max(1, w - 2 * pad);
  const ih = Math.max(1, h - 2 * pad);
  const step = stride(src);
  const { rgba, width, height } = src;
  const counts = new Uint32Array(w * h * 3);
  const yOf = (v: number) => pad + Math.round((1 - v / 255) * (ih - 1));

  if (kind === "histogram") {
    const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const i = (y * width + x) * 4;
        bins[0][rgba[i]]++;
        bins[1][rgba[i + 1]]++;
        bins[2][rgba[i + 2]]++;
      }
    }
    // Normalisé sur le plus haut bac hors extrêmes (0 et 255 écrêtés dominent sinon).
    let max = 1;
    for (const b of bins) for (let v = 1; v < 255; v++) max = Math.max(max, b[v]);
    for (let c = 0; c < 3; c++) {
      for (let px = 0; px < iw; px++) {
        const v = Math.min(255, Math.floor((px / iw) * 256));
        const top = Math.min(1, bins[c][v] / max);
        const hgt = Math.round(top * ih);
        for (let k = 0; k < hgt; k++) {
          const yy = pad + ih - 1 - k;
          out[(yy * w + pad + px) * 3 + c] = 0.55;
        }
      }
    }
    return out;
  }

  let samples = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      samples++;
      if (kind === "waveform") {
        const col = pad + Math.min(iw - 1, Math.floor((x / width) * iw));
        const lum = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
        const k = (yOf(lum) * w + col) * 3;
        counts[k]++;
        counts[k + 1]++;
        counts[k + 2]++;
      } else if (kind === "parade") {
        const third = iw / 3;
        const rel = Math.min(third - 1, Math.floor((x / width) * third));
        const vals = [r, g, b];
        for (let c = 0; c < 3; c++) {
          const col = pad + Math.floor(c * third) + rel;
          counts[(yOf(vals[c]) * w + col) * 3 + c]++;
        }
      } else {
        const [cb, cr] = cbcr(r, g, b);
        const radius = Math.min(iw, ih) / 2;
        const cx = Math.round(pad + iw / 2 + cb * 2 * radius * 0.95);
        const cy = Math.round(pad + ih / 2 - cr * 2 * radius * 0.95);
        // Point de 3×3 pixels (1 sur un petit instrument) : une couleur unie
        // reste lisible. Il prend la couleur du pixel, éclaircie.
        const rad = w >= 160 ? 1 : 0;
        for (let dy = -rad; dy <= rad; dy++) {
          for (let dx = -rad; dx <= rad; dx++) {
            const px = cx + dx;
            const py = cy + dy;
            if (px < 0 || px >= w || py < 0 || py >= h) continue;
            const k = (py * w + px) * 3;
            counts[k] += 1 + (r >> 6);
            counts[k + 1] += 1 + (g >> 6);
            counts[k + 2] += 1 + (b >> 6);
          }
        }
      }
    }
  }
  // Intensité logarithmique : les zones denses saturent doucement, un point
  // isolé reste visible. Référence : densité moyenne par colonne.
  const per = kind === "vectorscope" ? samples / (iw * ih) * 40 : samples / iw / 6;
  const k = 1 / Math.max(1, per);
  const tint = kind === "waveform" ? [0.72, 0.95, 0.74] : [1, 1, 1];
  for (let p = 0; p < w * h; p++) {
    for (let c = 0; c < 3; c++) {
      const n = counts[p * 3 + c];
      if (n) out[p * 3 + c] = (1 - Math.exp(-n * k * 3)) * tint[c];
    }
  }
  return out;
}

/** Barres 75 % : cibles du vectorscope (R, Mg, B, Cy, G, Yl). */
export const TARGETS_75: [string, [number, number, number]][] = [
  ["R", [191, 0, 0]], ["Mg", [191, 0, 191]], ["B", [0, 0, 191]],
  ["Cy", [0, 191, 191]], ["G", [0, 191, 0]], ["Yl", [191, 191, 0]],
];

/**
 * Dessine l'instrument dans `box` : fond assombri (opacité), tracé ajouté,
 * graduations. Le tracé est composé en pixels exacts.
 */
export function drawScope(ctx: Ctx2D, kind: ScopeKind, src: Src, box: Box, opacity: number, labels = true): void {
  const w = Math.max(16, Math.round(box.w));
  const h = Math.max(16, Math.round(box.h));
  const x0 = Math.round(box.x);
  const y0 = Math.round(box.y);
  const trace = accumulate(kind, src, w, h);
  const dst = ctx.getImageData(x0, y0, w, h);
  const d = dst.data;
  const keep = 1 - Math.min(1, Math.max(0, opacity));
  for (let p = 0, q = 0; p < w * h; p++, q += 4) {
    for (let c = 0; c < 3; c++) {
      const v = d[q + c] * keep + trace[p * 3 + c] * 255;
      d[q + c] = v > 255 ? 255 : v;
    }
    d[q + 3] = 255;
  }
  ctx.putImageData(dst, x0, y0);

  // Graduations.
  const pad = scopePad(w);
  const iw = w - 2 * pad;
  const ih = h - 2 * pad;
  const fs = Math.max(8, Math.round(w * 0.026));
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.shadowColor = "transparent";
  ctx.lineWidth = Math.max(1, Math.round(w / 600));
  ctx.strokeStyle = "rgba(224, 164, 59, 0.45)";
  ctx.fillStyle = "rgba(224, 164, 59, 0.85)";
  ctx.font = `500 ${fs}px "IBM Plex Mono", monospace`;
  ctx.textBaseline = "middle";
  if (kind === "vectorscope") {
    const cx = x0 + pad + iw / 2;
    const cy = y0 + pad + ih / 2;
    const r = (Math.min(iw, ih) / 2) * 0.95;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.moveTo(cx - r, cy);
    ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx, cy + r);
    ctx.stroke();
    // Ligne des tons chair (axe I, 123°).
    const a = (123 * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * r, cy - Math.sin(a) * r);
    ctx.stroke();
    const s = Math.max(3, Math.round(w * 0.018));
    for (const [name, rgb] of TARGETS_75) {
      const [cb, cr] = cbcr(...rgb);
      const tx = cx + cb * 2 * r;
      const ty = cy - cr * 2 * r;
      ctx.strokeRect(tx - s, ty - s, 2 * s, 2 * s);
      if (labels) ctx.fillText(name, tx + s + 2, ty);
    }
  } else {
    const sections = kind === "parade" ? 3 : 1;
    ctx.beginPath();
    for (const v of [0, 25, 50, 75, 100]) {
      const yy = y0 + pad + Math.round((1 - v / 100) * (ih - 1)) + 0.5;
      ctx.moveTo(x0 + pad, yy);
      ctx.lineTo(x0 + pad + iw, yy);
    }
    for (let k = 1; k < sections; k++) {
      const xx = x0 + pad + Math.round((k * iw) / 3) + 0.5;
      ctx.moveTo(xx, y0 + pad);
      ctx.lineTo(xx, y0 + pad + ih);
    }
    ctx.stroke();
    if (labels && kind !== "histogram") {
      ctx.textAlign = "left";
      for (const v of [0, 50, 100]) {
        const yy = y0 + pad + Math.round((1 - v / 100) * (ih - 1));
        ctx.fillText(String(v), x0 + pad + 2, yy + (v === 100 ? fs * 0.6 : v === 0 ? -fs * 0.6 : 0));
      }
    }
  }
  ctx.restore();
}
