import { describe, expect, it } from "vitest";
import { shortcutBlocked } from "../keys";

// Éléments minimaux : seuls tagName, type et isContentEditable comptent.
const el = (tagName: string, type = "", editable = false) => ({ tagName, type, isContentEditable: editable }) as unknown as EventTarget;

describe("shortcutBlocked", () => {
  it("blocks every key while typing text", () => {
    for (const t of [el("INPUT", "text"), el("INPUT", "number"), el("INPUT", "search"), el("TEXTAREA"), el("SELECT"), el("DIV", "", true)]) {
      for (const key of ["c", " ", "ArrowLeft", "p"]) expect(shortcutBlocked({ key, target: t })).toBe(true);
    }
  });

  it("keeps letters as shortcuts on a checkbox, leaves Space to it", () => {
    expect(shortcutBlocked({ key: "c", target: el("INPUT", "checkbox") })).toBe(false);
    expect(shortcutBlocked({ key: "p", target: el("INPUT", "radio") })).toBe(false);
    expect(shortcutBlocked({ key: " ", target: el("INPUT", "checkbox") })).toBe(true);
  });

  it("leaves the arrows to a slider (the timeline steps one frame itself)", () => {
    const r = el("INPUT", "range");
    expect(shortcutBlocked({ key: "ArrowRight", target: r })).toBe(true);
    expect(shortcutBlocked({ key: "Home", target: r })).toBe(true);
    expect(shortcutBlocked({ key: "c", target: r })).toBe(false);
    expect(shortcutBlocked({ key: " ", target: r })).toBe(false);
  });

  it("a field of a closed window is not typing (the focus has not come back to the page yet)", () => {
    const inDialog = (open: boolean) => ({ tagName: "INPUT", type: "text", isContentEditable: false, closest: (s: string) => (s === "dialog" ? { open } : null) }) as unknown as EventTarget;
    expect(shortcutBlocked({ key: "k", target: inDialog(false) })).toBe(false);
    expect(shortcutBlocked({ key: "k", target: inDialog(true) })).toBe(true);
  });

  it("never blocks on buttons, the color picker or the page", () => {
    for (const t of [el("BUTTON"), el("INPUT", "color"), el("BODY"), null]) expect(shortcutBlocked({ key: "c", target: t })).toBe(false);
  });
});
