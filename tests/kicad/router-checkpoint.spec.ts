import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { stableShot } from "../e2e/utils/element-tracker";

declare const window: Window & {
  Module: {
    kicadCollabTestRouter(command: string): string;
    kicadCollabSnapshotItems(): string;
    kicadOpenFile(path: string): void;
  };
  wxElementRegistry?: { findAll(options: { visible: boolean }): { typeName: string }[] };
};

// Runs real PNS algorithms and the production locked reconcile path in the WASM editor.
// This driver intentionally does not claim coverage of mouse/tool-stack dispatch or the
// generator/footprint overlay callbacks; those also require interactive browser tests.
const P = "10000000-0000-4000-8000-000000000001";
const N = "10000000-0000-4000-8000-000000000002";
const REMOTE = "10000000-0000-4000-8000-000000000003";
const PAD = "10000000-0000-4000-8000-000000000004";
const BOARD = `(kicad_pcb (version 20241229) (generator pcbnew)
 (general (thickness 1.6)) (paper "A4")
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
 (setup) (net 0 "") (net 1 "DATA_P") (net 2 "DATA_N")
 (segment (start 40 50) (end 50 50) (width 0.2) (layer "F.Cu") (net 1) (uuid "${P}"))
 (segment (start 40 50.45) (end 50 50.45) (width 0.2) (layer "F.Cu") (net 2) (uuid "${N}"))
 (segment (start 80 80) (end 90 80) (width 0.2) (layer "F.Cu") (net 0) (uuid "${REMOTE}"))
 (footprint "Test" (layer "F.Cu") (at 100 100)
  (uuid "10000000-0000-4000-8000-000000000005")
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "DATA_P") (uuid "${PAD}")))
)`;

type State = { sequence: number; ok: boolean; active: boolean; checkpoint: boolean; added?: number; preview?: number; spacing?: number };
type Blob = { sexpr: string; parent: null };
type Wire = { added: Blob[]; changed: Blob[]; removed: string[] };

async function state(page: Page): Promise<State> {
  return page.evaluate(() => JSON.parse((window.Module as any).kicadCollabTestRouter("")));
}

async function command(page: Page, op: { op: string; [key: string]: unknown }): Promise<State> {
  const previous = (await state(page)).sequence;
  // A direct BOARD mutation has no outer input dispatch. Use the production lock
  // so the apply coroutine drains posted tool events before releasing it.
  if (op.op === "commit") await lock(page);
  await page.evaluate((op) => (window.Module as any).kicadCollabTestRouter(JSON.stringify(op)), op);
  if (op.op === "commit") await page.evaluate(() => (window.Module as any).kicadCollabUnlock());
  await expect.poll(async () => (await state(page)).sequence).toBe(previous + 1);
  return state(page);
}

async function lock(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window.Module as any).kicadCollabTryLock()),
    { timeout: 15000 }).toBe(true);
}

async function snapshot(page: Page): Promise<Wire> {
  await lock(page);
  try {
    return await page.evaluate(() => JSON.parse(window.Module.kicadCollabSnapshotItems()));
  } finally {
    await page.evaluate(() => (window.Module as any).kicadCollabUnlock());
  }
}

async function apply(page: Page, delta: Wire): Promise<void> {
  await lock(page);
  await page.evaluate((delta) => {
    const module = window.Module as any;
    const wire = JSON.stringify({ ...delta, committed: delta });
    module.kicadCollabPrepareItems(wire);
    module.kicadCollabApplyItems(wire);
    module.kicadCollabUnlock(); // unlock is deferred until queued apply completes
  }, delta);
  // A new lock can only be taken once the queued prepare/apply has completed.
  await lock(page);
  await page.evaluate(() => (window.Module as any).kicadCollabUnlock());
}

test.describe("cooperative router checkpoints", () => {
  test.describe.configure({ timeout: 240000 });

  test.beforeEach(async ({ page }) => {
    await page.goto("/kicad/pcbnew-collab.html");
    await page.waitForFunction(() => typeof (window.Module as any)?.kicadCollabTestRouter === "function",
      null, { timeout: 150000 }); // missing hooks are a failure, not a silent skip
    await page.waitForFunction(() => window.wxElementRegistry?.findAll({ visible: true })
      .some((e) => /Frame$/.test(e.typeName)), null, { timeout: 150000 });
    await page.evaluate((board) => {
      const fs = (window as any).FS;
      fs.mkdirTree("/home/kicad/documents");
      fs.writeFile("/home/kicad/documents/router-checkpoint.kicad_pcb", board);
      window.Module.kicadOpenFile("/home/kicad/documents/router-checkpoint.kicad_pcb");
    }, BOARD);
    await expect.poll(() => page.title(), { timeout: 30000 }).toContain("router-checkpoint");
    await expect.poll(() => page.evaluate(() => (window.Module as any).kicadCollabSetHistoryMode(true))).toBe(true);
  });

  for (const mode of [2, 3, 4, 5, 6]) {
    test(`mode ${mode}: repeated incoming edits preserve preview; cancel retains only remote edits`, async ({ page, testLogger }) => {
      const before = await snapshot(page);
      const remote = before.added.find((item) => item.sexpr.includes(REMOTE))!;
      const tuning = mode >= 4;
      const start = await command(page, { op: "start", mode, ids: mode === 3 ? [P, N] : [P],
        x: tuning ? 45000000 : 50000000, y: 50000000 });
      expect(start.ok).toBe(true);
      if (tuning) expect((await command(page, { op: "tuning" })).ok).toBe(true);
      expect((await command(page, { op: "move", x: tuning ? 49000000 : 60000000, y: 55000000 })).ok).toBe(true);
      if (!tuning) {
        await command(page, { op: "fix", x: 60000000, y: 55000000 });
        await command(page, { op: "move", x: 65000000, y: 60000000 });
        if (mode === 3) await command(page, { op: "spacing", step: 200000 });
      }
      expect((await state(page)).checkpoint).toBe(true);
      // Fixed DP/bus stages are speculative: serializing BOARD must not expose them.
      expect((await snapshot(page)).added).toEqual(before.added);
      for (let i = 0; i < 2; i++) {
        const changed = { ...remote, sexpr: remote.sexpr.replace(/\(width 0\.2\)/, `(width ${0.3 + i / 10})`) };
        await apply(page, { added: [], changed: [changed], removed: [] });
        expect((await state(page)).active).toBe(true);
        expect((await state(page)).checkpoint).toBe(true);
        expect((await state(page)).preview).toBeGreaterThan(0);
        if (tuning) expect((await state(page)).spacing).toBe(600000);
        expect((await snapshot(page)).added.find((blob) => blob.sexpr.includes(REMOTE))?.sexpr).toContain(`(width ${0.3 + i / 10})`);
      }
      await stableShot(page, test.info().outputPath(`mode-${mode}-after-checkpoint.png`));
      // Deleting an unrelated root must not run the generic cancel-all fallback.
      await apply(page, { added: [], changed: [], removed: [REMOTE] });
      expect((await state(page)).active).toBe(true);
      await command(page, { op: "cancel" });
      expect((await snapshot(page)).added).toEqual(before.added.filter((blob) => !blob.sexpr.includes(REMOTE)));
      expect(testLogger.errors).toEqual([]);
      expect(testLogger.consoleLogs.some((line) => /Aborted\(|memory access out of bounds/.test(line))).toBe(false);
    });
  }

  for (const mode of [2, 3]) {
    test(`mode ${mode}: fixed stages are committed once after two checkpoints`, async ({ page }) => {
      const before = await snapshot(page);
      const remote = before.added.find((blob) => blob.sexpr.includes(REMOTE))!;
      expect((await command(page, { op: "start", mode, ids: mode === 3 ? [P, N] : [P], x: 50000000, y: 50000000 })).ok).toBe(true);
      for (const [x, y] of [[60000000, 55000000], [65000000, 60000000]]) {
        expect((await command(page, { op: "move", x, y })).ok).toBe(true);
        await command(page, { op: "fix", x, y });
        await command(page, { op: "move", x: x + 2000000, y: y + 2000000 });
        await apply(page, { added: [], changed: [remote], removed: [] });
        expect((await state(page)).active).toBe(true);
        expect((await snapshot(page)).added).toEqual(before.added);
      }
      await command(page, { op: "commit" });
      const after = await snapshot(page);
      // Native non-footprint blobs carry a kicad_pcb parser envelope.
      const tracks = after.added.filter((blob) => /\(segment\s/.test(blob.sexpr));
      expect(tracks.length).toBeGreaterThan(3);
      const shapes = tracks.map((blob) => blob.sexpr.replace(/\(uuid\s+"[^"]+"\)/g, ""));
      expect(new Set(shapes).size).toBe(shapes.length);
      await apply(page, { added: [], changed: [remote], removed: [] });
      expect((await snapshot(page)).added).toEqual(after.added);
    });
  }

  test("component drag re-resolves replaced pad geometry and cancels without reverting remote properties", async ({ page }) => {
    const before = await snapshot(page);
    const footprint = before.added.find((blob) => blob.sexpr.includes(PAD))!;
    expect((await command(page, { op: "start", mode: 1, ids: [PAD], drag: true, x: 100000000, y: 100000000 })).ok).toBe(true);
    await command(page, { op: "move", x: 105000000, y: 105000000 });
    const changed = { ...footprint, sexpr: footprint.sexpr.replace("(size 1 1)", "(size 1.5 1)") };
    await apply(page, { added: [], changed: [changed], removed: [] });
    expect((await state(page)).active).toBe(true);
    await command(page, { op: "cancel" });
    expect((await snapshot(page)).added.find((blob) => blob.sexpr.includes(PAD))?.sexpr).toContain("(size 1.5 1)");
  });

  test("initialized idle router permits default-history snapshots but active routing still requires host history", async ({ page }) => {
    await command(page, { op: "start", mode: 1, ids: [P], x: 50000000, y: 50000000 });
    await command(page, { op: "cancel" });
    expect(await page.evaluate(() => (window.Module as any).kicadCollabSetHistoryMode(false))).toBe(true);
    expect((await snapshot(page)).added.length).toBeGreaterThan(0);
    expect((await command(page, { op: "start", mode: 1, ids: [P], x: 50000000, y: 50000000 })).ok).toBe(true);
    expect((await state(page)).checkpoint).toBe(false);
    await command(page, { op: "cancel" });
    expect((await snapshot(page)).added.length).toBeGreaterThan(0);
  });

  test("removing the differential-pair source abandons only the invalid gesture", async ({ page }) => {
    expect((await command(page, { op: "start", mode: 2, ids: [P], x: 50000000, y: 50000000 })).ok).toBe(true);
    await command(page, { op: "move", x: 60000000, y: 55000000 });
    await apply(page, { added: [], changed: [], removed: [P] });
    expect((await state(page)).active).toBe(false);
    expect((await snapshot(page)).added.some((blob) => blob.sexpr.includes(P))).toBe(false);
  });
});
