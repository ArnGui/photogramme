import { describe, expect, it } from "vitest";
import { effectiveTheme, parseAppearance, SKINS } from "../theme";

describe("appearance", () => {
  it("lets Studio follow the theme and the other skins impose their own", () => {
    expect(effectiveTheme({ theme: "light", skin: "studio", effects: true, accent: "gold" })).toBe("light");
    expect(effectiveTheme({ theme: "dark", skin: "studio", effects: true, accent: "gold" })).toBe("dark");
    expect(effectiveTheme({ theme: "light", skin: "atomic", effects: true, accent: "gold" })).toBe("dark");
    expect(effectiveTheme({ theme: "dark", skin: "mission", effects: true, accent: "gold" })).toBe("light");
  });

  it("ships exactly Studio, Atomic and Mission", () => {
    expect(SKINS.map((s) => s.id)).toEqual(["studio", "atomic", "mission"]);
  });

  it("reads a damaged or old local copy without failing", () => {
    expect(parseAppearance(null, null)).toEqual({ theme: "dark", skin: "studio", effects: true, accent: "gold" });
    // v0.6 kept only the theme, under another key.
    expect(parseAppearance(null, "light")).toEqual({ theme: "light", skin: "studio", effects: true, accent: "gold" });
    expect(parseAppearance("{not json", "light").theme).toBe("light");
    expect(parseAppearance('{"theme":"light","skin":"mission","effects":false}', null))
      .toEqual({ theme: "light", skin: "mission", effects: false, accent: "gold" });
    expect(parseAppearance('{"skin":"chrome","effects":"yes"}', null)).toEqual({ theme: "dark", skin: "studio", effects: true, accent: "gold" });
    expect(parseAppearance('{"skin":"atomic","accent":"teal"}', null).accent).toBe("teal");
    expect(parseAppearance('{"accent":"magenta"}', null).accent).toBe("gold");
    expect(parseAppearance("null", null)).toEqual({ theme: "dark", skin: "studio", effects: true, accent: "gold" });
  });
});
