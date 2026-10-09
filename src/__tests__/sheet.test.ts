import { describe, expect, it } from "vitest";
import { MAX_PIXELS, MAX_SIDE, captionLines, cellOrigin, expandTitle, pagePixels, sheetLayout } from "../sheet";
import type { SheetSettings } from "../types";

const base: SheetSettings = {
  columns: 4, page: "a4", landscape: true, format: "pdf", dpi: 200, imageWidth: 3840, theme: "dark",
  title: "{film}", showTc: true, showShot: true, showClip: true, showFrame: false, showPalette: false,
};

describe("planche contact", () => {
  it("taille des pages comme le Rust (A4 paysage, 200 dpi)", () => {
    expect(pagePixels(base)).toEqual([2339, 1654]);
    expect(pagePixels({ ...base, landscape: false })).toEqual([1654, 2339]);
    expect(pagePixels({ ...base, page: "image" })).toBeNull();
  });

  it("grille qui tient dans la page, pages comptées", () => {
    const L = sheetLayout(base, 1920, 1080, 50);
    expect(L.cols).toBe(4);
    expect(L.margin * 2 + L.cols * L.cellW + (L.cols - 1) * L.gap).toBeLessThanOrEqual(L.pageW);
    const [, lastY] = cellOrigin(L, L.perPage - 1);
    expect(lastY + L.cellH).toBeLessThanOrEqual(L.pageH - L.margin - L.footerH);
    expect(L.pages).toBe(Math.ceil(50 / L.perPage));
    expect(L.imgH).toBe(Math.round((L.cellW * 1080) / 1920));
  });

  it("image libre : une seule page à la hauteur du contenu", () => {
    const L = sheetLayout({ ...base, page: "image", imageWidth: 2000 }, 1998, 1080, 9);
    expect(L.pages).toBe(1);
    expect(L.rows).toBe(3);
    const [, y] = cellOrigin(L, 8);
    expect(y + L.cellH + L.footerH + L.margin).toBe(L.pageH);
  });

  it("image libre trop grande : coupée en plusieurs images, jamais au-delà des plafonds", () => {
    // Le cas qui faisait planter la v0.7 : 31 images 4K, une colonne (3840 × 74 604 px, 1,1 Go).
    for (const [imageWidth, columns] of [[3840, 1], [7680, 2], [16000, 1], [16000, 4], [16000, 12], [3840, 4]]) {
      const L = sheetLayout({ ...base, page: "image", imageWidth, columns }, 3840, 2160, 31);
      expect(L.pageW, `${imageWidth}/${columns}`).toBeLessThanOrEqual(MAX_SIDE);
      expect(L.pageH, `${imageWidth}/${columns}`).toBeLessThanOrEqual(MAX_SIDE);
      expect(L.pageW * L.pageH, `${imageWidth}/${columns}`).toBeLessThanOrEqual(MAX_PIXELS);
      expect(L.cellW, "jamais d'agrandissement").toBeLessThanOrEqual(3840);
      expect(L.pages * L.perPage).toBeGreaterThanOrEqual(31);
    }
    // Réglage raisonnable : toujours une seule image, à la largeur demandée.
    const ok = sheetLayout({ ...base, page: "image", imageWidth: 3840, columns: 4 }, 3840, 2160, 31);
    expect([ok.pages, ok.pageW]).toEqual([1, 3840]);
    // Pages imposées : l'A3 à 600 dpi reste possible.
    const a3 = sheetLayout({ ...base, page: "a3", dpi: 600 }, 3840, 2160, 31);
    expect(a3.pageW * a3.pageH).toBeLessThanOrEqual(MAX_PIXELS);
  });

  it("légendes et titre", () => {
    expect(captionLines(base)).toBe(2);
    expect(captionLines({ ...base, showTc: false, showShot: false, showClip: false })).toBe(0);
    expect(expandTitle("{film} — {count} frames — {x}", "Film", 12, new Date(2026, 9, 7))).toBe("Film — 12 frames — {x}");
    expect(expandTitle("{date}", "F", 1, new Date(2026, 9, 7))).toBe("2026-10-07");
  });
});
