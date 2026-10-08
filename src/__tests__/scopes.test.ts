import { describe, expect, it } from "vitest";
import { accumulate, cbcr, scopePad, TARGETS_75 } from "../scopes";

function flat(w: number, h: number, rgb: [number, number, number]) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([...rgb, 255], i * 4);
  return { rgba, width: w, height: h };
}

/** Lignes non vides de la grille (canal vert). */
function rows(out: Float32Array, w: number, h: number) {
  const r: number[] = [];
  for (let y = 0; y < h; y++) {
    let any = false;
    for (let x = 0; x < w; x++) if (out[(y * w + x) * 3 + 1] > 0) any = true;
    if (any) r.push(y);
  }
  return r;
}

describe("scopes", () => {
  it("forme d'onde : un gris uni = une seule ligne, à la bonne hauteur", () => {
    const w = 200, h = 100;
    const out = accumulate("waveform", flat(64, 36, [128, 128, 128]), w, h);
    const pad = scopePad(w);
    const r = rows(out, w, h);
    expect(r).toHaveLength(1);
    expect(r[0]).toBe(pad + Math.round((1 - 128 / 255) * (h - 2 * pad - 1)));
    const black = rows(accumulate("waveform", flat(8, 8, [0, 0, 0]), w, h), w, h);
    expect(black[0]).toBe(h - pad - 1);
  });

  it("vectorscope : le gris au centre, le rouge 75 % sur sa cible", () => {
    const w = 120, h = 120;
    expect(cbcr(128, 128, 128).map((v) => Math.abs(v) < 1e-9)).toEqual([true, true]);
    const out = accumulate("vectorscope", flat(16, 16, [191, 0, 0]), w, h);
    let pos: [number, number] | null = null;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (out[(y * w + x) * 3] > 0) pos = [x, y];
    const pad = scopePad(w);
    const r = ((w - 2 * pad) / 2) * 0.95;
    const [cb, cr] = cbcr(...TARGETS_75[0][1]);
    expect(pos).not.toBeNull();
    expect(Math.abs(pos![0] - Math.round(pad + (w - 2 * pad) / 2 + cb * 2 * r))).toBeLessThanOrEqual(1);
    expect(Math.abs(pos![1] - Math.round(pad + (h - 2 * pad) / 2 - cr * 2 * r))).toBeLessThanOrEqual(1);
    expect(cr).toBeGreaterThan(0);
  });

  it("parade : trois colonnes, chaque canal dans la sienne", () => {
    const w = 300, h = 100;
    const out = accumulate("parade", flat(600, 10, [255, 0, 0]), w, h);
    const pad = scopePad(w);
    // Rouge à 100 % dans le premier tiers (canal R), vert à 0 dans le deuxième (canal V).
    expect(out[(pad * w + pad + 5) * 3]).toBeGreaterThan(0);
    const g0 = (h - pad - 1) * w + pad + Math.floor((w - 2 * pad) / 3) + 5;
    expect(out[g0 * 3 + 1]).toBeGreaterThan(0);
    expect(out[g0 * 3]).toBe(0);
  });

  it("déterministe", () => {
    const src = flat(50, 20, [10, 200, 90]);
    expect(accumulate("histogram", src, 100, 50)).toEqual(accumulate("histogram", src, 100, 50));
  });
});
