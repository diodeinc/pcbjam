import { test, expect } from "./fixtures";
import { waitForPcbnew } from "./utils/pcbnew-ready";
import { stableShot } from "../e2e/utils/element-tracker";

const UUID = "66666666-0000-0000-0000-000000000001";
const BOARD = `(kicad_pcb (version 20260206) (generator "pcbnew")
  (general (thickness 1.6)) (paper "A4")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (37 "F.SilkS" user) (25 "Edge.Cuts" user))
  (setup)
  (footprint "Test:R" (layer "F.Cu") (uuid "${UUID}") (at 100 100) (attr smd)
    (property "Reference" "R1" (at 0 -2) (layer "F.SilkS")
      (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu"))
    (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu"))))`;

test("web toolbar dispatches toolbar-only rotation and preserves menu history", async ({ page, testLogger }) => {
  test.setTimeout(180000);
  await page.goto("/kicad/pcbnew-collab.html");
  await waitForPcbnew(page);
  await page.evaluate((board) => {
    const w = window as any;
    w.FS.mkdirTree("/home/kicad/documents");
    w.FS.writeFile("/home/kicad/documents/web-toolbar.kicad_pcb", board);
    w.Module.kicadOpenFile("/home/kicad/documents/web-toolbar.kicad_pcb");
  }, BOARD);
  await expect.poll(() => page.title()).toContain("web-toolbar");
  await page.waitForFunction(() => !(window as any).Module.kicadOpenFileBusy());
  expect(await page.evaluate(() => (window as any).Module.kicadUseWebToolbar())).toBe(true);
  await page.waitForFunction(() => !(window as any).Module.kicadCollabBusy());
  expect(await page.evaluate((id) => (window as any).Module.kicadCollabTestSelectByUuid(id), UUID)).toBe(true);
  await expect.poll(() => page.evaluate(() => JSON.parse((window as any).Module.kicadCollabGetSelection()))).toEqual([UUID]);

  // This local-only harness has no remote applies. Observe the item without
  // acquiring a render lock that would exclude the UI command under test.
  const placement = () => page.evaluate((id) => {
    const blob = (window as any).Module.kicadCollabTestItemBlob(id);
    const at = /\(at ([^)]+)\)/.exec(blob)![1].split(/\s+/).map(Number);
    return [at[0], at[1], at[2] ?? 0];
  }, UUID);
  const command = async (label: string) => {
    // Use the same native command surface as the embedded app, not the
    // rotation test helper. Acceptance alone is NOT proof of dispatch.
    expect(await page.evaluate((label) => {
      const m = (window as any).Module;
      const state = JSON.parse(m.kicadWebToolbarState());
      const tool = state.toolbars.flatMap((bar: any) => bar.items)
        .find((item: any) => (item.tooltip || item.label || "").split(/[\t\n]/)[0] === label);
      if (!tool) throw new Error(`Missing toolbar command: ${label}`);
      return m.kicadWebToolbarCommand(tool.id);
    }, label)).toBe(true);
  };
  await expect.poll(placement).toEqual([100, 100, 0]);
  await command("Rotate Counterclockwise");
  await expect.poll(placement).toEqual([100, 100, 90]);
  await command("Undo");
  await expect.poll(placement).toEqual([100, 100, 0]);
  await command("Redo");
  await expect.poll(placement).toEqual([100, 100, 90]);
  await command("Rotate Clockwise");
  await expect.poll(placement).toEqual([100, 100, 0]);
  await stableShot(page, "web-toolbar-rotation-restored.png");
  expect(testLogger.errors).toEqual([]);
});
