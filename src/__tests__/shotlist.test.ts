import { describe, expect, it } from "vitest";
import { buildShots, cutAt, mergeWithNext, selectedSpans, shotAt } from "../shotlist";
import type { ShotView } from "../types";

const shots: ShotView[] = [
  { index: 1, start: 0, end: 48, score: 0, thumb: 24, clip: null },
  { index: 2, start: 48, end: 72, score: 26, thumb: 48, clip: "B.mov" },
  { index: 3, start: 72, end: 120, score: 25, thumb: 96, clip: null },
];

describe("liste des plans", () => {
  it("sans fusion ni décochage", () => {
    const l = buildShots(shots, new Set(), new Set());
    expect(l.map((s) => [s.index, s.start, s.end, s.checked])).toEqual([[1, 0, 48, true], [2, 48, 72, true], [3, 72, 120, true]]);
  });

  it("fusionne et renumérote", () => {
    let l = buildShots(shots, new Set(), new Set());
    const removed = mergeWithNext(l, 0, new Set());
    l = buildShots(shots, removed, new Set());
    expect(l.map((s) => [s.index, s.start, s.end, s.parts, s.thumb])).toEqual([[1, 0, 72, 2, 24], [2, 72, 120, 1, 96]]);
    expect(mergeWithNext(l, 1, removed)).toBe(removed);
  });

  it("n'exporte que les plans cochés", () => {
    const l = buildShots(shots, new Set(), new Set([48]));
    expect(selectedSpans(l)).toEqual([{ index: 1, start: 0, end: 48 }, { index: 3, start: 72, end: 120 }]);
  });

  it("trouve le plan d'une image", () => {
    const l = buildShots(shots, new Set(), new Set());
    expect([0, 47, 48, 119, 120, -1].map((f) => shotAt(l, f))).toEqual([0, 0, 1, 2, -1, -1]);
  });
});

describe("coupes à la main", () => {
  it("ajoute une coupe, ou rétablit une coupe fusionnée", () => {
    const r1 = cutAt(30, new Set(), new Set());
    expect([...r1.added]).toEqual([30]);
    const r2 = cutAt(48, new Set(), new Set([48]));
    expect([...r2.removed]).toEqual([]);
    expect(r2.added.size).toBe(0);
  });

  it("marque les plans ouverts à la main et garde le nom du clip", () => {
    const withManual = [...shots.slice(0, 1).map((s) => ({ ...s, end: 30 })), { index: 2, start: 30, end: 48, score: -1, thumb: 24, clip: null }, ...shots.slice(1)];
    const l = buildShots(withManual, new Set(), new Set(), new Set([30]));
    expect(l.map((s) => s.manual)).toEqual([false, true, false, false]);
    expect(l[2].clip).toBe("B.mov");
  });
});
