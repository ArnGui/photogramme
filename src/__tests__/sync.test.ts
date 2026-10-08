import { describe, expect, it } from "vitest";
import { bestOffset, distance } from "../sync";

const ramp = (shift: number) => Float32Array.from({ length: 64 }, (_, i) => ((i * 7 + shift * 40) % 255));

describe("synchro visionneuse", () => {
  it("retrouve l'image affichée parmi les voisines", () => {
    const shown = ramp(1);
    expect(bestOffset(shown, [[-1, ramp(0)], [0, ramp(1)], [1, ramp(2)]])).toBe(0);
    expect(bestOffset(shown, [[-1, ramp(1)], [0, ramp(2)], [1, ramp(3)]])).toBe(-1);
  });

  it("refuse de trancher sur un plan fixe", () => {
    const still = new Float32Array(64).fill(100);
    expect(bestOffset(still, [[-1, still], [0, still], [1, still]])).toBeNull();
  });

  it("insensible à un léger écart de niveau", () => {
    const a = ramp(0);
    const b = a.map((v) => v + 3);
    expect(distance(a, b)).toBeLessThan(0.001);
  });
});
