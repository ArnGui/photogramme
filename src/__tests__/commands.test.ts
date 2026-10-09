import { describe, expect, it } from "vitest";
import { filterCommands, score } from "../commands";

const cmd = (label: string, group = "Commands", keywords = "") => ({ label, group, keywords });

describe("command search", () => {
  const list = [
    cmd("Capture the displayed frame", "Frames", "still screenshot"),
    cmd("Save this frame's palette", "Gallery", "colors swatches"),
    cmd("Look › Palette band", "Look", "colors"),
    cmd("Skin: Mission", "Appearance", "theme"),
    cmd("Export the barcode", "Extract", "colors"),
  ];

  it("matches every word, in the label, the group or the keywords", () => {
    expect(filterCommands(list, "pal").map((c) => c.label)).toEqual(["Save this frame's palette", "Look › Palette band"]);
    expect(filterCommands(list, "skin mis").map((c) => c.label)).toEqual(["Skin: Mission"]);
    expect(filterCommands(list, "screenshot").map((c) => c.label)).toEqual(["Capture the displayed frame"]);
    expect(filterCommands(list, "appearance").map((c) => c.label)).toEqual(["Skin: Mission"]);
    expect(filterCommands(list, "xyz")).toEqual([]);
  });

  it("prefers the start of a word in the label, keeps the original order otherwise", () => {
    expect(score(cmd("Palette band"), "pal")!).toBeGreaterThan(score(cmd("Save palette"), "pal")! - 0.01);
    expect(filterCommands(list, "colors").map((c) => c.label)).toEqual(["Save this frame's palette", "Look › Palette band", "Export the barcode"]);
  });

  it("ignores case and accents, and shows everything for an empty query", () => {
    expect(filterCommands([cmd("Réglages")], "REGL")).toHaveLength(1);
    const many = Array.from({ length: 120 }, (_, i) => cmd(`Command ${i}`));
    expect(filterCommands(many, "")).toHaveLength(120);
    expect(filterCommands(many, "   ")).toHaveLength(120);
  });
});
