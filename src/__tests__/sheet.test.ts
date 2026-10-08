import { describe, expect, it } from "vitest";
import { captionLines, cellOrigin, expandTitle, pagePixels, sheetLayout } from "../sheet";
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

  it("légendes et titre", () => {
    expect(captionLines(base)).toBe(2);
    expect(captionLines({ ...base, showTc: false, showShot: false, showClip: false })).toBe(0);
    expect(expandTitle("{film} — {count} frames — {x}", "Film", 12, new Date(2026, 9, 7))).toBe("Film — 12 frames — {x}");
    expect(expandTitle("{date}", "F", 1, new Date(2026, 9, 7))).toBe("2026-10-07");
  });
});
