import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("supplies full six-digit hex native palettes in light and dark mode", () => {
  const css = readFileSync(new URL("../style.css",import.meta.url),"utf8");
  const palettes = [...css.matchAll(/:root[^}]*\}/g)].map(x=>x[0]);
  expect(palettes).toHaveLength(2);
  for (const palette of palettes) {
    for (const key of ["paper-bg","paper-surface","hover-surface","line","ink","muted-ink","diode-green","diode-green-foreground"]) {
      expect(palette).toMatch(new RegExp(`--${key}:#[0-9a-fA-F]{6};`));
    }
  }
});
