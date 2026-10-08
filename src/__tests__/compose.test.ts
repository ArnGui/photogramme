import { describe, expect, it } from "vitest";
import { expandTemplate, fontString, layout, makeTokens } from "../compose";
import { decodePacket, encodePacket } from "../packet";
import type { OverlayPreset, Swatch } from "../types";

// Mesure factice : 10 px par caractère à 20 px de corps (proportionnelle à la taille).
const measure = (text: string, font: string) => {
  const size = Number(/([\d.]+)px/.exec(font)![1]);
  return text.length * size * 0.5;
};

const sw = (hex: string): Swatch => ({ hex, rgb: [0, 0, 0], share: 0.25, lab: [0, 0, 0] });
const palette = ["#111111", "#222222", "#333333", "#444444"].map(sw);

function preset(): OverlayPreset {
  return {
    name: "T",
    frame: { padTop: 40, padRight: 40, padBottom: 40, padLeft: 40, background: "#000000" },
    palette: {
      enabled: true, placement: "below", style: "squares", size: 100, gap: 10, margin: 20, align: "left",
      showHex: false, hexFont: { family: "IBM Plex Mono", size: 16, weight: 400, italic: false }, hexColor: "#ffffff",
    },
    texts: [{
      id: "tc", enabled: true, template: "{tc}", font: { family: "Barlow", size: 20, weight: 500, italic: false },
      color: "#ffffff", opacity: 1, uppercase: false, letterSpacing: 0, anchor: "bottomRight", region: "image",
      offsetX: 30, offsetY: 30, shadow: false, boxEnabled: true, boxColor: "#000000", boxOpacity: 0.5, boxPadding: 5,
    }],
    scope: { enabled: false, kind: "waveform", anchor: "topRight", region: "image", size: 420, opacity: 0.75, offsetX: 32, offsetY: 32 },
  };
}

const tokens = makeTokens("Mon film.mp4", "00:01:02:03", 1490, 12, 23.976, 1920, 1080);

describe("layout", () => {
  it("ajoute marges et bande de palette sous l'image (base 1920)", () => {
    const L = layout(preset(), 1920, 1080, palette, tokens, measure);
    expect(L.scale).toBe(1);
    expect(L.image).toEqual({ x: 40, y: 40, w: 1920, h: 1080 });
    expect(L.width).toBe(2000);
    expect(L.height).toBe(40 + 1080 + 20 + 100 + 40);
    expect(L.swatches.map((s) => [s.x, s.y, s.w, s.h])).toEqual([
      [40, 1140, 100, 100], [150, 1140, 100, 100], [260, 1140, 100, 100], [370, 1140, 100, 100],
    ]);
  });

  it("suit la résolution : tout double en UHD", () => {
    const hd = layout(preset(), 1920, 1080, palette, tokens, measure);
    const uhd = layout(preset(), 3840, 2160, palette, tokens, measure);
    expect(uhd.width).toBe(hd.width * 2);
    expect(uhd.height).toBe(hd.height * 2);
    expect(uhd.swatches[1].x).toBe(hd.swatches[1].x * 2);
    expect(uhd.texts[0].x).toBe(hd.texts[0].x * 2);
  });

  it("ancre le texte en bas à droite de l'image avec son fond", () => {
    const L = layout(preset(), 1920, 1080, palette, tokens, measure);
    const t = L.texts[0];
    // "00:01:02:03" = 11 caractères × 10 px = 110 px.
    expect(t.align).toBe("right");
    expect(t.x).toBe(40 + 1920 - 30);
    expect(t.y).toBe(40 + 1080 - 30 - 24);
    expect(t.box).toEqual({ x: 40 + 1920 - 30 - 110 - 5, y: t.y - 5, w: 120, h: 34, color: "#000000", opacity: 0.5 });
  });

  it("remplit toute la largeur en style « fill », centre les carrés", () => {
    const p = preset();
    p.palette.style = "fill";
    p.palette.gap = 0;
    const L = layout(p, 1920, 1080, palette, tokens, measure);
    expect(L.swatches.map((s) => s.w)).toEqual([480, 480, 480, 480]);
    expect(L.swatches[3].x + L.swatches[3].w).toBe(40 + 1920);
    p.palette.style = "squares";
    p.palette.align = "center";
    const C = layout(p, 1920, 1080, palette, tokens, measure);
    expect(C.swatches[0].x).toBe(40 + (1920 - 400) / 2);
  });

  it("palette par-dessus l'image : pas de bande, hauteur inchangée", () => {
    const p = preset();
    p.palette.placement = "inside";
    const L = layout(p, 1920, 1080, palette, tokens, measure);
    expect(L.height).toBe(40 + 1080 + 40);
    expect(L.swatches[0].y).toBe(40 + 1080 - 20 - 100);
    expect(L.swatches[0].x).toBe(60);
  });

  it("sans palette (désactivée ou vide) : pas de bande", () => {
    const p = preset();
    expect(layout(p, 1920, 1080, [], tokens, measure).height).toBe(1160);
    p.palette.enabled = false;
    expect(layout(p, 1920, 1080, palette, tokens, measure).swatches).toEqual([]);
  });

  it("ignore les textes désactivés ou vides", () => {
    const p = preset();
    p.texts.push({ ...p.texts[0], id: "vide", template: "  " });
    p.texts.push({ ...p.texts[0], id: "off", enabled: false });
    expect(layout(p, 1920, 1080, palette, tokens, measure).texts).toHaveLength(1);
  });
});

describe("jetons et polices", () => {
  it("remplace les jetons connus", () => {
    expect(expandTemplate("{film} — {tc} · plan {shot} · {res} · {foo}", tokens)).toBe(
      "Mon film — 00:01:02:03 · plan 012 · 1920×1080 · {foo}",
    );
    expect(expandTemplate("{fps}", tokens)).toBe("23.976");
  });

  it("neutralise les caractères dangereux dans le nom de police", () => {
    expect(fontString({ family: 'Arial"; color:red', size: 20, weight: 700, italic: true }, 2)).toBe(
      'italic 700 40px "Arial color:red"',
    );
  });
});

describe("paquets binaires", () => {
  it("aller-retour identique au format Rust", () => {
    const px = new Uint8ClampedArray(2 * 1 * 4).fill(7);
    const bytes = encodePacket({ frame: 5, timecode: "00:00:00:05", width: 2, height: 1, palette: [], job: 3 }, px);
    expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(bytes.length - 4 - 8);
    const f = decodePacket(bytes.buffer as ArrayBuffer);
    expect(f.frame).toBe(5);
    expect(f.job).toBe(3);
    expect(Array.from(f.rgba)).toEqual(Array(8).fill(7));
  });

  it("refuse un paquet tronqué", () => {
    expect(() => decodePacket(new ArrayBuffer(2))).toThrow();
    const bytes = encodePacket({ frame: 1, width: 4, height: 4 }, new Uint8Array(3));
    expect(() => decodePacket(bytes.buffer as ArrayBuffer)).toThrow("Incomplete frame.");
  });
});

describe("scope incrusté", () => {
  it("placé selon l'ancre, mis à l'échelle et toujours dans l'image", () => {
    const p = preset();
    p.scope.enabled = true;
    const L = layout(p, 1920, 1080, palette, tokens, measure);
    expect(L.scope).toMatchObject({ x: 40 + 1920 - 32 - 420, y: 40 + 32, w: 420, h: 210, kind: "waveform" });
    const uhd = layout(p, 3840, 2160, palette, tokens, measure);
    expect(uhd.scope).toMatchObject({ w: 840, h: 420 });
    p.scope.kind = "vectorscope";
    p.scope.offsetX = -5000;
    const v = layout(p, 1920, 1080, palette, tokens, measure)!;
    expect(v.scope!.w).toBe(v.scope!.h);
    expect(v.scope!.x + v.scope!.w).toBeLessThanOrEqual(v.width);
  });

  it("jeton {clip}", () => {
    const t = makeTokens("F.mp4", "01:00:00:00", 0, null, 25, 1920, 1080, "A001_C003.mov");
    expect(expandTemplate("{clip} / {tc}", t)).toBe("A001_C003.mov / 01:00:00:00");
    expect(expandTemplate("[{clip}]", makeTokens("F.mp4", "x", 0, null, 25, 1, 1))).toBe("[]");
    expect(expandTemplate("{tc}  ·  {clip}", makeTokens("F.mp4", "01:00:00:00", 0, null, 25, 1, 1))).toBe("01:00:00:00");
    expect(expandTemplate("{film} — {tc}", makeTokens("F.mp4", "01:00:00:00", 0, null, 25, 1, 1))).toBe("F — 01:00:00:00");
  });
});
