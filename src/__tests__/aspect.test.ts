// Garde-fous : l'image du film garde toujours ses dimensions et son ratio,
// quels que soient le préréglage d'overlay, les marges, la palette ou le scope.
import { describe, expect, it } from "vitest";
import { layout, makeTokens } from "../compose";
import { fitBox } from "../hooks";
import type { OverlayPreset, Swatch } from "../types";

const measure = (text: string, font: string) => text.length * Number(/([\d.]+)px/.exec(font)![1]) * 0.5;
const palette: Swatch[] = ["#111111", "#222222", "#333333"].map((hex) => ({ hex, rgb: [0, 0, 0], share: 1 / 3, lab: [0, 0, 0] }));
const font = { family: "Barlow", size: 20, weight: 500, italic: false };

function preset(over: Partial<OverlayPreset> = {}): OverlayPreset {
  return {
    name: "T",
    frame: { padTop: 48, padRight: 48, padBottom: 40, padLeft: 48, background: "#000000" },
    palette: { enabled: true, placement: "below", style: "squares", size: 64, gap: 8, margin: 24, align: "left", showHex: true, hexFont: font, hexColor: "#ffffff" },
    texts: [{
      id: "tc", enabled: true, template: "{tc}", font, color: "#ffffff", opacity: 1, uppercase: false, letterSpacing: 0,
      anchor: "bottomRight", region: "canvas", offsetX: 48, offsetY: 40, shadow: false, boxEnabled: true, boxColor: "#000000", boxOpacity: 0.6, boxPadding: 6,
    }],
    scope: { enabled: false, kind: "parade", anchor: "topRight", region: "image", size: 420, opacity: 0.75, offsetX: 32, offsetY: 32 },
    ...over,
  };
}

const zero = { padTop: 0, padRight: 0, padBottom: 0, padLeft: 0, background: "#000000" };
const variants: [string, OverlayPreset][] = [
  ["marges + palette dessous", preset()],
  ["palette incrustée", preset({ palette: { ...preset().palette, placement: "inside", style: "fill" } })],
  ["type Grading check (scope, sans marge)", preset({ frame: zero, palette: { ...preset().palette, enabled: false }, scope: { ...preset().scope, enabled: true } })],
  ["marges asymétriques énormes", preset({ frame: { padTop: 400, padRight: 10, padBottom: 0, padLeft: 900, background: "#fff" } })],
];

describe("ratio de l'image du film", () => {
  for (const [w, h] of [[1920, 1080], [1920, 804], [3840, 1606], [1080, 1920], [1440, 1080]]) {
    for (const [name, p] of variants) {
      it(`${w}×${h} · ${name} : image copiée 1:1, jamais redimensionnée`, () => {
        const L = layout(p, w, h, palette, makeTokens("f.mp4", "00:00:00:00", 0, null, 24, w, h), measure);
        expect(L.image.w).toBe(w);
        expect(L.image.h).toBe(h);
        // L'image tient entièrement dans la composition.
        expect(L.image.x + L.image.w).toBeLessThanOrEqual(L.width);
        expect(L.image.y + L.image.h).toBeLessThanOrEqual(L.height);
      });
    }
  }
});

describe("fitBox (boîte d'affichage)", () => {
  it("garde le ratio demandé à moins d'un pixel près", () => {
    for (const [cw, ch] of [[1200, 700], [700, 1200], [333.7, 911.2], [1920, 80]]) {
      for (const a of [16 / 9, 2.39, 2016 / 980, 9 / 16, 1]) {
        const b = fitBox(cw, ch, a);
        expect(b.w).toBeLessThanOrEqual(Math.ceil(cw));
        expect(b.h).toBeLessThanOrEqual(Math.ceil(ch));
        // Écart de forme : au plus un pixel sur le côté calculé.
        expect(Math.abs(b.w - b.h * a)).toBeLessThanOrEqual(Math.max(1, a));
      }
    }
  });
  it("change de ratio sans attendre une nouvelle mesure du conteneur", () => {
    expect(fitBox(1200, 700, 1920 / 1080)).toEqual({ w: 1200, h: 675 });
    expect(fitBox(1200, 700, 2016 / 980)).toEqual({ w: 1200, h: 583 });
  });
  it("conteneur vide ou ratio invalide : boîte nulle", () => {
    expect(fitBox(0, 500, 1.5)).toEqual({ w: 0, h: 0 });
    expect(fitBox(500, 500, Number.NaN)).toEqual({ w: 0, h: 0 });
  });
});
