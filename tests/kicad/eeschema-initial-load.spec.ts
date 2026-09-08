import { test, expect } from "./fixtures";
import { TRIO_SCH, hasAbort } from "./utils/trio";

// No prior mouse/cursor activity or collaboration host: the first busy scope
// restores wx's default-constructed global cursor when the schematic loads.
test("initial schematic load restores an unset busy cursor without aborting", async ({ page, testLogger }) => {
  test.setTimeout(120000);
  await page.goto("/kicad/eeschema.html");
  await page.waitForFunction(() => (window as any).wxElementRegistry?.findAll({visible:true}).some((entry: any) => /Frame$/.test(entry.typeName)), null, {timeout:90000});
  await page.evaluate(fixture => {
    const w = window as any;
    w.FS.mkdirTree("/home/kicad/documents");
    w.FS.writeFile("/home/kicad/documents/trio.kicad_sch", fixture);
    w.Module.kicadOpenFile("/home/kicad/documents/trio.kicad_sch");
  }, TRIO_SCH.fixture);
  await expect.poll(() => page.title(), {timeout:30000}).toContain("trio");
  expect(hasAbort(testLogger)).toBe(false);
});
