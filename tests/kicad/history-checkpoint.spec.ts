import { test, expect } from "./fixtures";
import { TRIO_SCH } from "./utils/trio";

// Actual WASM translation/queue tests. The callback records host intent, not a
// mocked native editor. Production Yjs undo is covered by the host UI suite.
test.beforeEach(async ({ page }) => {
  await page.goto("/kicad/eeschema.html");
  await page.waitForFunction(() => (window as any).wxElementRegistry?.findAll({visible:true})
    .some((entry: any) => /Frame$/.test(entry.typeName)), null, {timeout:90000});
  await page.evaluate(fixture => {
    const w = window as any;
    w.FS.mkdirTree("/home/kicad/documents");
    w.FS.writeFile("/home/kicad/documents/history.kicad_sch", fixture);
    w.Module.kicadOpenFile("/home/kicad/documents/history.kicad_sch");
  }, TRIO_SCH.fixture);
  await expect.poll(() => page.title(), {timeout:30000}).toContain("history");
  await expect.poll(() => page.evaluate(() => (window as any).Module.kicadCollabTryLock())).toBe(true);
  await page.evaluate(() => {
    const w = window as any;
    w.Module.kicadCollabSetHistoryMode(true);
    w.__history = [];
    w.kicadCollab = {...w.kicadCollab, onHistory: (direction: string) => w.__history.push(direction)};
  });
});

test("configured history keys retain order and drain exactly once after unlock", async ({ page }) => {
  expect(await page.evaluate(() => {
    const m = (window as any).Module;
    return [m.kicadCollabQueueHistoryKey("KeyZ", true, false, false, false),
      m.kicadCollabQueueHistoryKey("KeyY", true, false, false, false),
      m.kicadCollabQueueHistoryKey("KeyR", false, false, false, false),
      m.kicadCollabQueueHistoryKey("KeyY", true, true, true, false)];
  })).toEqual([true, true, false, false]);
  expect(await page.evaluate(() => (window as any).__history)).toEqual([]);
  await page.evaluate(() => (window as any).Module.kicadCollabUnlock());
  expect(await page.evaluate(() => (window as any).__history)).toEqual(["undo", "redo"]);
  await page.evaluate(() => (window as any).Module.kicadCollabUnlock());
  expect(await page.evaluate(() => (window as any).__history)).toEqual(["undo", "redo"]);
  expect(await page.evaluate(() => (window as any).Module.kicadCollabQueueHistoryKey("KeyZ", true, false, false, false))).toBe(false);
});

for (const cancel of ["listener", "mode", "document", "readonly"]) {
  test(`${cancel} change drops queued history instead of applying it to a new session`, async ({ page }) => {
    expect(await page.evaluate(() => (window as any).Module.kicadCollabQueueHistoryKey("KeyZ", true, false, false, false))).toBe(true);
    await page.evaluate(async cancel => {
      const w = window as any;
      if (cancel === "listener") w.kicadCollab.onHistory = () => w.__history.push("replacement");
      if (cancel === "mode") w.Module.kicadCollabSetHistoryMode(false);
      if (cancel === "readonly") w.Module.kicadSetReadOnly(true);
      if (cancel === "document") await w.Module.kicadOpenFile("/home/kicad/documents/history.kicad_sch");
      w.Module.kicadCollabUnlock();
    }, cancel);
    expect(await page.evaluate(() => (window as any).__history)).toEqual([]);
  });
}
