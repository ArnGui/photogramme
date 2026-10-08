import { describe, expect, it } from "vitest";
import { formatCount, frameToTc, tcLabel } from "../timecode";

// Mêmes valeurs que les tests Rust (photogramme-core/src/timecode.rs) :
// l'interface et les fichiers doivent afficher le même timecode.
describe("timecode, miroir du Rust", () => {
  it("non-drop et départ du fichier", () => {
    expect(frameToTc(24, 23.976)).toBe("00:00:01:00");
    expect(frameToTc(24 * 3600 + 24 * 61 + 5, 24)).toBe("01:01:01:05");
    const tc = { rate: 25, drop: false, start: 90000 };
    expect(tcLabel(tc, 0)).toBe("01:00:00:00");
    expect(tcLabel(tc, 26)).toBe("01:00:01:01");
  });

  it("drop-frame 29,97", () => {
    const tc = { rate: 30, drop: true, start: 0 };
    expect(tcLabel(tc, 1799)).toBe("00:00:59;29");
    expect(tcLabel(tc, 1800)).toBe("00:01:00;02");
    expect(tcLabel(tc, 17_982)).toBe("00:10:00;00");
    expect(tcLabel(tc, 107_892)).toBe("01:00:00;00");
    expect(formatCount(215_784, 60, true)).toBe("01:00:00;00");
  });

  it("revient à zéro après 24 heures", () => {
    expect(tcLabel({ rate: 25, drop: false, start: 25 * 86400 - 1 }, 1)).toBe("00:00:00:00");
  });
});
