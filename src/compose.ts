// Composition de l'image exportée : image du film + marges + bande de
// palette + textes.
//
// Une seule fonction de dessin (`render`) sert à l'aperçu ET à l'export :
// mêmes pixels source (fournis par FFmpeg), même code, même moteur Canvas.
// C'est ce qui garantit que l'aperçu est identique au fichier.
//
// `layout` est pure (aucun accès au Canvas sauf la mesure du texte, injectée) :
// elle est testée sans navigateur.

import { drawScope, scopeAspect } from "./scopes";
import type { Anchor, Font, OverlayPreset, ScopeKind, Swatch, TextItem } from "./types";

/** Les tailles des préréglages sont en « px base 1920 ». */
export const BASE_WIDTH = 1920;

export interface Rect { x: number; y: number; w: number; h: number }

export interface SwatchBox extends Rect {
  color: string;
  label: { text: string; x: number; y: number; font: string; color: string } | null;
}

export interface TextBox {
  lines: string[];
  font: string;
  x: number;
  y: number;
  lineHeight: number;
  align: CanvasTextAlign;
  color: string;
  opacity: number;
  letterSpacing: number;
  shadow: number;
  box: (Rect & { color: string; opacity: number }) | null;
}

export interface ScopeBox extends Rect {
  kind: ScopeKind;
  opacity: number;
}

export interface Layout {
  width: number;
  height: number;
  scale: number;
  background: string;
  image: Rect;
  swatches: SwatchBox[];
  texts: TextBox[];
  scope: ScopeBox | null;
}

export interface Tokens {
  film: string;
  file: string;
  tc: string;
  frame: number;
  shot: number | null;
  clip: string | null;
  fps: number;
  width: number;
  height: number;
  date: string;
}

export type Measure = (text: string, font: string, letterSpacing: number) => number;

/** Déclaration CSS de police pour `ctx.font`. */
export function fontString(f: Font, scale: number): string {
  const family = f.family.replace(/["';{}\\<>]/g, "").trim() || "Barlow";
  const size = Math.max(1, Math.round(f.size * scale * 100) / 100);
  return `${f.italic ? "italic " : ""}${f.weight} ${size}px "${family}"`;
}

/** Remplace les jetons {film} {tc}… ; un jeton inconnu reste tel quel. */
export function expandTemplate(template: string, t: Tokens): string {
  const values: Record<string, string> = {
    film: t.film,
    file: t.file,
    tc: t.tc,
    frame: String(t.frame),
    shot: t.shot == null ? "" : String(t.shot).padStart(3, "0"),
    clip: t.clip ?? "",
    fps: (Math.round(t.fps * 1000) / 1000).toString(),
    res: `${t.width}×${t.height}`,
    date: t.date,
  };
  const out = template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? values[k] : m));
  // Un jeton vide ({clip} sans liste de montage) ne laisse pas de séparateur orphelin.
  return out
    .split("\n")
    .map((l) => l.replace(/^(\s*[·|•/–—-]\s*)+/, "").replace(/(\s*[·|•/–—-]\s*)+$/, ""))
    .join("\n");
}

export const TOKEN_HELP = "{film} {file} {tc} {frame} {shot} {clip} {fps} {res} {date}";

function anchorParts(a: Anchor): { h: "left" | "center" | "right"; v: "top" | "middle" | "bottom" } {
  const h = a.endsWith("Left") || a === "left" ? "left" : a.endsWith("Right") || a === "right" ? "right" : "center";
  const v = a.startsWith("top") ? "top" : a.startsWith("bottom") ? "bottom" : "middle";
  return { h, v };
}

/** Disposition complète, en pixels de l'image exportée. */
export function layout(
  preset: OverlayPreset,
  imgW: number,
  imgH: number,
  palette: Swatch[],
  tokens: Tokens,
  measure: Measure,
): Layout {
  const s = imgW / BASE_WIDTH;
  const px = (v: number) => Math.round(v * s);
  const f = preset.frame;
  const pad = { t: px(f.padTop), r: px(f.padRight), b: px(f.padBottom), l: px(f.padLeft) };
  const image: Rect = { x: pad.l, y: pad.t, w: imgW, h: imgH };

  // ── Bande de palette ──
  const p = preset.palette;
  const showPalette = p.enabled && palette.length > 0;
  const size = px(p.size);
  const gap = px(p.gap);
  const margin = px(p.margin);
  const hexFont = fontString(p.hexFont, s);
  const hexH = p.showHex ? Math.round(p.hexFont.size * s * 1.7) : 0;
  const bandH = showPalette && p.placement === "below" ? margin + size + hexH : 0;

  const width = imgW + pad.l + pad.r;
  const height = pad.t + imgH + bandH + pad.b;

  const swatches: SwatchBox[] = [];
  if (showPalette) {
    const n = palette.length;
    const inside = p.placement === "inside";
    const areaX = inside ? image.x + margin : image.x;
    const areaW = inside ? image.w - 2 * margin : image.w;
    const y = inside ? image.y + image.h - margin - size - hexH : image.y + image.h + margin;
    let w: number;
    let x0: number;
    if (p.style === "fill") {
      w = (areaW - (n - 1) * gap) / n;
      x0 = areaX;
    } else {
      w = size;
      const total = n * size + (n - 1) * gap;
      x0 = p.align === "left" ? areaX : p.align === "right" ? areaX + areaW - total : areaX + (areaW - total) / 2;
    }
    palette.forEach((sw, i) => {
      const x = Math.round(x0 + i * (w + gap));
      const next = Math.round(x0 + (i + 1) * (w + gap) - gap);
      swatches.push({
        x,
        y,
        w: next - x,
        h: size,
        color: sw.hex,
        label: p.showHex ? { text: sw.hex, x, y: y + size + Math.round(p.hexFont.size * s * 0.35), font: hexFont, color: p.hexColor } : null,
      });
    });
  }

  // ── Textes ──
  const canvasRect: Rect = { x: 0, y: 0, w: width, h: height };
  const texts: TextBox[] = [];
  for (const t of preset.texts) {
    if (!t.enabled) continue;
    const raw = expandTemplate(t.template, tokens);
    const text = t.uppercase ? raw.toUpperCase() : raw;
    if (!text.trim()) continue;
    texts.push(placeText(t, text, t.region === "canvas" ? canvasRect : image, s, measure));
  }

  // ── Scope incrusté ──
  let scope: ScopeBox | null = null;
  const sc = preset.scope;
  if (sc && sc.enabled) {
    const w = Math.min(Math.round(sc.size * s), Math.round(imgW * 0.9));
    const h = Math.round(w * scopeAspect(sc.kind));
    const r = sc.region === "canvas" ? canvasRect : image;
    const { h: ha, v } = anchorParts(sc.anchor);
    const ox = Math.round(sc.offsetX * s);
    const oy = Math.round(sc.offsetY * s);
    const x = ha === "left" ? r.x + ox : ha === "right" ? r.x + r.w - ox - w : Math.round(r.x + (r.w - w) / 2 + ox);
    const y = v === "top" ? r.y + oy : v === "bottom" ? r.y + r.h - oy - h : Math.round(r.y + (r.h - h) / 2 + oy);
    // Toujours entièrement dans la composition (sinon getImageData lirait hors champ).
    scope = {
      x: Math.max(0, Math.min(width - w, x)),
      y: Math.max(0, Math.min(height - h, y)),
      w,
      h,
      kind: sc.kind,
      opacity: sc.opacity,
    };
  }

  return { width, height, scale: s, background: f.background, image, swatches, texts, scope };
}

function placeText(t: TextItem, text: string, r: Rect, s: number, measure: Measure): TextBox {
  const font = fontString(t.font, s);
  const size = t.font.size * s;
  const lineHeight = Math.round(size * 1.2);
  const lines = text.split("\n");
  const ls = t.letterSpacing * s;
  const textW = Math.max(...lines.map((l) => measure(l, font, ls)));
  const textH = lineHeight * lines.length;
  const { h, v } = anchorParts(t.anchor);
  const ox = t.offsetX * s;
  const oy = t.offsetY * s;

  // Coin haut-gauche du bloc de texte.
  const left = h === "left" ? r.x + ox : h === "right" ? r.x + r.w - ox - textW : r.x + (r.w - textW) / 2 + ox;
  const top = v === "top" ? r.y + oy : v === "bottom" ? r.y + r.h - oy - textH : r.y + (r.h - textH) / 2 + oy;
  const x = h === "left" ? left : h === "right" ? left + textW : left + textW / 2;
  const padBox = t.boxPadding * s;

  return {
    lines,
    font,
    x: Math.round(x),
    y: Math.round(top),
    lineHeight,
    align: h,
    color: t.color,
    opacity: t.opacity,
    letterSpacing: ls,
    shadow: t.shadow ? Math.max(1, size * 0.12) : 0,
    box: t.boxEnabled
      ? {
          x: Math.round(left - padBox),
          y: Math.round(top - padBox),
          w: Math.round(textW + 2 * padBox),
          h: Math.round(textH + 2 * padBox),
          color: t.boxColor,
          opacity: t.boxOpacity,
        }
      : null,
  };
}

/* ───────────── Dessin ───────────── */

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function setSpacing(ctx: Ctx2D, px: number) {
  // `letterSpacing` existe dans Chromium/WebView2 ; ignoré ailleurs.
  if ("letterSpacing" in ctx) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${px}px`;
}

/** Mesure de texte réelle, sur le contexte donné. */
export function canvasMeasure(ctx: Ctx2D): Measure {
  return (text, font, ls) => {
    ctx.font = font;
    setSpacing(ctx, ls);
    return ctx.measureText(text).width;
  };
}

/** Charge les polices utilisées avant de dessiner (sinon repli silencieux du Canvas). */
export async function loadFonts(preset: OverlayPreset): Promise<void> {
  const fonts = [preset.palette.hexFont, ...preset.texts.filter((t) => t.enabled).map((t) => t.font)];
  await Promise.all(
    fonts.map((f) => document.fonts.load(fontString(f, 1).replace(/[\d.]+px/, "32px")).catch(() => [])),
  );
}

/**
 * Dessine la composition complète sur `canvas` (redimensionné au besoin).
 * `image` : pixels RVBA exacts de l'image du film.
 */
export function render(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  image: ImageData,
  preset: OverlayPreset,
  palette: Swatch[],
  tokens: Tokens,
): Layout {
  const ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: false }) as Ctx2D | null;
  if (!ctx) throw new Error("Canvas unavailable.");
  const L = layout(preset, image.width, image.height, palette, tokens, canvasMeasure(ctx));
  if (canvas.width !== L.width) canvas.width = L.width;
  if (canvas.height !== L.height) canvas.height = L.height;

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.shadowColor = "transparent";
  ctx.fillStyle = L.background;
  ctx.fillRect(0, 0, L.width, L.height);
  // putImageData ignore les transformations et l'alpha global : copie exacte.
  ctx.putImageData(image, L.image.x, L.image.y);

  for (const sw of L.swatches) {
    ctx.fillStyle = sw.color;
    ctx.fillRect(sw.x, sw.y, sw.w, sw.h);
    if (sw.label) {
      ctx.font = sw.label.font;
      setSpacing(ctx, 0);
      ctx.fillStyle = sw.label.color;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(sw.label.text, sw.label.x, sw.label.y);
    }
  }

  if (L.scope) {
    drawScope(ctx, L.scope.kind, { rgba: image.data, width: image.width, height: image.height }, L.scope, L.scope.opacity);
  }

  for (const t of L.texts) {
    if (t.box) {
      ctx.globalAlpha = t.box.opacity;
      ctx.fillStyle = t.box.color;
      ctx.fillRect(t.box.x, t.box.y, t.box.w, t.box.h);
    }
    ctx.globalAlpha = t.opacity;
    ctx.font = t.font;
    setSpacing(ctx, t.letterSpacing);
    ctx.textAlign = t.align;
    ctx.textBaseline = "top";
    ctx.fillStyle = t.color;
    if (t.shadow) {
      ctx.shadowColor = "rgba(0,0,0,0.65)";
      ctx.shadowBlur = t.shadow * 2;
      ctx.shadowOffsetY = t.shadow / 2;
    } else {
      ctx.shadowColor = "transparent";
    }
    t.lines.forEach((line, i) => ctx.fillText(line, t.x, t.y + i * t.lineHeight));
  }
  ctx.restore();
  return L;
}

/** Composition hors écran, renvoie les pixels RVBA à encoder en JPEG. */
export function composeToPixels(
  image: ImageData,
  preset: OverlayPreset,
  palette: Swatch[],
  tokens: Tokens,
): { width: number; height: number; rgba: Uint8ClampedArray } {
  const c = new OffscreenCanvas(1, 1);
  const L = render(c, image, preset, palette, tokens);
  const ctx = c.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  return { width: L.width, height: L.height, rgba: ctx.getImageData(0, 0, L.width, L.height).data };
}

export function makeTokens(
  fileName: string, tc: string, frame: number, shot: number | null, fps: number, w: number, h: number, clip: string | null = null,
): Tokens {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    film: fileName.replace(/\.[^.]+$/, ""),
    file: fileName,
    tc,
    frame,
    shot,
    clip,
    fps,
    width: w,
    height: h,
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
  };
}
