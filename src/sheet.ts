// Planche contact : mise en page (pure, testée) et dessin d'une page.
//
// Unité : 1 u = 1 % de la largeur de la page. Les images sont décodées par
// FFmpeg à la largeur exacte d'une case et posées pixel pour pixel (aucune
// mise à l'échelle par le Canvas) : elles restent nettes à l'impression.

import type { SheetSettings, Swatch } from "./types";

export interface SheetLayout {
  pageW: number;
  pageH: number;
  margin: number;
  headerH: number;
  footerH: number;
  cols: number;
  rows: number;
  perPage: number;
  pages: number;
  gap: number;
  cellW: number;
  imgH: number;
  captionH: number;
  paletteH: number;
  cellH: number;
  fontSize: number;
  titleSize: number;
}

/** Taille d'une page en pixels, paysage appliqué (même arrondi que le Rust). */
export function pagePixels(s: SheetSettings): [number, number] | null {
  const mm: Record<string, [number, number]> = {
    a4: [210, 297], a3: [297, 420], letter: [215.9, 279.4], tabloid: [279.4, 431.8],
  };
  const p = mm[s.page];
  if (!p) return null;
  const [w, h] = s.landscape ? [p[1], p[0]] : p;
  const px = (v: number) => Math.round((v / 25.4) * s.dpi);
  return [px(w), px(h)];
}

/** Lignes de légende demandées. */
export function captionLines(s: SheetSettings): number {
  const first = s.showTc || s.showShot || s.showFrame ? 1 : 0;
  return first + (s.showClip ? 1 : 0);
}

/**
 * Plafonds d'une page : au-delà, le moteur de l'interface (WebView2) peut manquer de
 * mémoire et s'arrêter (écran noir). 80 Mpx couvre l'A3 à 600 dpi.
 */
export const MAX_SIDE = 16384;
export const MAX_PIXELS = 80e6;

export function sheetLayout(s: SheetSettings, frameW: number, frameH: number, count: number): SheetLayout {
  const fixed = pagePixels(s);
  const cols = Math.max(1, Math.min(12, Math.round(s.columns)));
  // Image libre : jamais plus large que MAX_SIDE, ni que ce qui agrandirait les images du film.
  const share = (1 - 0.06 - (cols - 1) * 0.014) / cols;
  const pageW = fixed
    ? fixed[0]
    : Math.min(MAX_SIDE, Math.max(640, Math.round(s.imageWidth)), Math.max(640, Math.ceil(frameW / share)));
  const u = pageW / 100;
  const margin = Math.round(3 * u);
  const titleSize = Math.max(10, Math.round(2.1 * u));
  const fontSize = Math.max(8, Math.round((cols <= 3 ? 1.25 : cols <= 6 ? 1.05 : 0.85) * u));
  const headerH = Math.round(titleSize * 2.6);
  const footerH = Math.round(fontSize * 2);
  const gap = Math.round(1.4 * u);
  const cellW = Math.max(16, Math.min(fixed ? Infinity : frameW, Math.floor((pageW - 2 * margin - (cols - 1) * gap) / cols)));
  const imgH = Math.round((cellW * frameH) / Math.max(1, frameW));
  const lines = captionLines(s);
  const captionH = lines ? Math.round(fontSize * (0.5 + 1.35 * lines)) : Math.round(fontSize * 0.4);
  const paletteH = s.showPalette ? Math.max(4, Math.round(cellW * 0.06)) : 0;
  const cellH = imgH + paletteH + captionH;
  const chrome = 2 * margin + headerH + footerH;
  const rowsIn = (h: number) => Math.max(1, Math.floor((h - chrome + gap) / (cellH + gap)));
  // Page imposée : autant de lignes qu'elle en contient. Image libre : aussi haute que
  // nécessaire, mais coupée en plusieurs images au-delà des plafonds.
  const rows = fixed
    ? rowsIn(fixed[1])
    : Math.min(Math.ceil(count / cols), rowsIn(Math.min(MAX_SIDE, Math.floor(MAX_PIXELS / pageW))));
  const pageH = fixed ? fixed[1] : chrome + rows * cellH + (rows - 1) * gap;
  const perPage = rows * cols;
  return {
    pageW, pageH, margin, headerH, footerH, cols, rows, perPage, pages: Math.max(1, Math.ceil(count / perPage)),
    gap, cellW, imgH, captionH, paletteH, cellH, fontSize, titleSize,
  };
}

/** Position de la case `i` d'une page. */
export function cellOrigin(L: SheetLayout, i: number): [number, number] {
  const col = i % L.cols;
  const row = Math.floor(i / L.cols);
  return [L.margin + col * (L.cellW + L.gap), L.margin + L.headerH + row * (L.cellH + L.gap)];
}

export interface SheetCell {
  image: ImageData;
  tc: string;
  frame: number;
  shot: number | null;
  clip: string | null;
  palette: Swatch[];
}

export interface PageText {
  title: string;
  subtitle: string;
  page: number;
  pages: number;
}

/** Titre : jetons {film} {date} {count}. */
export function expandTitle(template: string, film: string, count: number, date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const d = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => ({ film, date: d, count: String(count) } as Record<string, string>)[k] ?? m);
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Texte tronqué avec « … » pour tenir dans `max` pixels. */
function fit(ctx: Ctx2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + "…").width <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

/** Dessine une page complète. */
export function drawPage(canvas: OffscreenCanvas | HTMLCanvasElement, L: SheetLayout, s: SheetSettings, cells: SheetCell[], text: PageText): void {
  if (canvas.width !== L.pageW) canvas.width = L.pageW;
  if (canvas.height !== L.pageH) canvas.height = L.pageH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: false }) as Ctx2D | null;
  if (!ctx) throw new Error("Canvas unavailable.");
  const dark = s.theme === "dark";
  const bg = dark ? "#0B0B0C" : "#F2EFE9";
  const ink = dark ? "#E9E4DA" : "#141210";
  const ink2 = dark ? "#8E897F" : "#5A564F";
  const accent = dark ? "#E0A43B" : "#9A6510";
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, L.pageW, L.pageH);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  // En-tête.
  ctx.fillStyle = ink;
  ctx.font = `600 ${L.titleSize}px "Barlow Condensed", sans-serif`;
  ctx.fillText(fit(ctx, text.title.toUpperCase(), L.pageW * 0.6), L.margin, L.margin + L.titleSize);
  ctx.fillStyle = ink2;
  ctx.font = `400 ${L.fontSize}px "IBM Plex Mono", monospace`;
  ctx.fillText(fit(ctx, text.subtitle, L.pageW - 2 * L.margin), L.margin, L.margin + L.titleSize + L.fontSize * 1.6);
  if (text.pages > 1) {
    ctx.textAlign = "right";
    ctx.fillText(`${text.page} / ${text.pages}`, L.pageW - L.margin, L.margin + L.titleSize);
    ctx.textAlign = "left";
  }

  cells.forEach((c, i) => {
    const [x, y] = cellOrigin(L, i);
    // Image : posée telle quelle, centrée si la taille décodée diffère d'un pixel.
    ctx.fillStyle = "#000";
    ctx.fillRect(x, y, L.cellW, L.imgH);
    const ox = x + Math.floor((L.cellW - c.image.width) / 2);
    const oy = y + Math.floor((L.imgH - c.image.height) / 2);
    ctx.putImageData(c.image, ox, oy);
    let cy = y + L.imgH;
    if (L.paletteH && c.palette.length) {
      const n = c.palette.length;
      c.palette.forEach((sw, k) => {
        const x1 = x + Math.round((k * L.cellW) / n);
        const x2 = x + Math.round(((k + 1) * L.cellW) / n);
        ctx.fillStyle = sw.hex;
        ctx.fillRect(x1, cy, x2 - x1, L.paletteH);
      });
    }
    cy += L.paletteH;
    const lh = L.fontSize * 1.35;
    let line = cy + L.fontSize * 0.5 + L.fontSize;
    ctx.font = `500 ${L.fontSize}px "IBM Plex Mono", monospace`;
    if (s.showTc || s.showShot || s.showFrame) {
      const left = s.showShot && c.shot != null ? `#${String(c.shot).padStart(3, "0")}` : "";
      const right = [s.showTc ? c.tc : "", s.showFrame ? `F${c.frame}` : ""].filter(Boolean).join("  ");
      if (left) {
        ctx.fillStyle = accent;
        ctx.fillText(left, x, line);
      }
      ctx.fillStyle = ink;
      ctx.textAlign = "right";
      ctx.fillText(right, x + L.cellW, line);
      ctx.textAlign = "left";
      line += lh;
    }
    if (s.showClip && c.clip) {
      ctx.fillStyle = ink2;
      ctx.font = `400 ${L.fontSize}px "IBM Plex Mono", monospace`;
      ctx.fillText(fit(ctx, c.clip, L.cellW), x, line);
    }
  });

  // Pied de page.
  ctx.fillStyle = ink2;
  ctx.font = `400 ${Math.round(L.fontSize * 0.85)}px "IBM Plex Mono", monospace`;
  ctx.textAlign = "right";
  ctx.fillText("Photogramme", L.pageW - L.margin, L.pageH - L.margin * 0.6);
}
