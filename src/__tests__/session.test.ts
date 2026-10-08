import { describe, expect, it } from "vitest";
import { parseSession, snapshot } from "../session";
import type { CaptureResult } from "../types";

const cap: CaptureResult = {
  path: "D:\\out\\a.jpg", fileName: "a.jpg", frame: 10, timecode: "00:00:00:10", bytes: 1000,
  width: 1920, height: 1080, quality: 92, shot: 2,
};

describe("session", () => {
  it("round-trips what the app saves", () => {
    const s = snapshot({
      frame: 42, source: "imported", removedCuts: new Set([30, 10]), addedCuts: new Set([50]), unchecked: new Set([0]),
      marks: { start: 5, end: 80 }, captures: [cap], output: "sheet", tab: "captures",
    });
    expect(s.removedCuts).toEqual([10, 30]);
    expect(parseSession(JSON.parse(JSON.stringify(s)), 100)).toEqual(s);
  });

  it("rejects what it cannot read", () => {
    for (const bad of [null, 3, "x", [], {}, { v: 2 }]) expect(parseSession(bad, 100)).toBeNull();
    expect(parseSession({ v: 1 }, 0)).toBeNull();
  });

  it("keeps the usable parts of a damaged or outdated file", () => {
    const s = parseSession({
      v: 1, frame: 500, source: "evil", removedCuts: [1, -2, 1.5, "3", 99, 100], addedCuts: "no", unchecked: null,
      marks: { start: 200, end: 50 }, captures: [cap, { path: 1 }, null, { ...cap, shot: "x" }], output: 7, tab: "nope",
    }, 100);
    expect(s).toEqual({
      v: 1, frame: 0, source: "detect", removedCuts: [1, 99], addedCuts: [], unchecked: [],
      marks: { start: null, end: 50 }, captures: [cap], output: "stills", tab: "extract",
    });
  });

  it("drops frames beyond a film that got shorter", () => {
    const s = parseSession({ v: 1, frame: 90, unchecked: [10, 90], marks: { start: 95 } }, 50);
    expect(s?.frame).toBe(0);
    expect(s?.unchecked).toEqual([10]);
    expect(s?.marks).toEqual({ start: null, end: null });
  });
});
