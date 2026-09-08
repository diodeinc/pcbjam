import { execSync } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { collabEvaluate } from "./utils/collab-lock";
import { bootOpen, startV2, getPos, modelText, TRIO_PCB, TRIO_SCH, FP1, SYM1 } from "./utils/trio";

test.beforeAll(() => {
  execSync("node collab/build.mjs", { cwd: path.resolve(__dirname, ".."), stdio: "inherit" });
});

const edit = (page: Page, name: string, ...args: (string | number)[]) =>
  collabEvaluate(page, ({ name, args }) => {
    const mod = (window as unknown as { Module: Record<string, (...args: unknown[]) => unknown> }).Module;
    return mod[name](...args);
  }, { name, args });

// User actions enter the dispatcher outside the render lock (which correctly
// rejects input). The native action emits host history instead of swapping a
// native before-image; the host captures pending edits under its own lock.
const historyAction = async (page: Page, direction: "Undo" | "Redo") => {
  const result = await page.evaluate((direction) => (window as unknown as {
    Module: Record<string, () => boolean>;
  }).Module[`kicadCollabTest${direction}`](), direction);
  await page.waitForFunction(() => {
    const state = (window as unknown as { __collabV2: { binding: {
      historyState: { pending: number; running: boolean };
    } } }).__collabV2.binding.historyState;
    return state.pending === 0 && !state.running;
  });
  return result;
};

for (const [tool, cfg, id, move, field] of [
  ["pcbnew", TRIO_PCB, FP1, "kicadCollabTestMoveBoardItem", "kicadCollabTestSetFootprintField"],
  ["eeschema", TRIO_SCH, SYM1, "kicadCollabTestMoveSchItem", "kicadCollabTestSetFieldText"],
] as const) {
  test(`${tool}: host undo/redo preserves peer fields and remote deletion`, async ({ context }) => {
    test.setTimeout(240_000);
    const a = await context.newPage();
    const b = await context.newPage();
    await bootOpen(a, cfg);
    await bootOpen(b, cfg);
    const room = `host-history-${tool}-${test.info().workerIndex}`;
    await startV2(a, { room, seedText: cfg.fixture });
    await startV2(b, { room, editorMatchesDoc: true });
    const before = await getPos(a, id);
    expect(await edit(a, move, id, 2_000_000, 0)).toBe(true);
    await expect.poll(() => getPos(b, id), { timeout: 20_000 }).not.toBe(before);
    const moved = await getPos(b, id);

    expect(await edit(b, field, id, ...(tool === "pcbnew" ? ["Value"] : []), "peer-field")).toBe(true);
    await expect.poll(() => modelText(a, cfg), { timeout: 20_000 }).toContain("peer-field");
    expect(await edit(a, "kicadCollabTestUndoDepth")).toBe(0);
    expect(await edit(b, "kicadCollabTestUndoDepth")).toBe(0);
    expect(await historyAction(a, "Undo")).toBe(true);
    await expect.poll(() => getPos(a, id), { timeout: 20_000 }).toBe(before);
    expect(await modelText(a, cfg)).toContain("peer-field");
    expect(await historyAction(a, "Redo")).toBe(true);
    await expect.poll(() => getPos(a, id), { timeout: 20_000 }).toBe(moved);
    expect(await modelText(a, cfg)).toContain("peer-field");

    // A's history still mentions the object; a peer delete must not let that
    // history resurrect it or enter native undo with a freed pointer.
    expect(await edit(b, "kicadCollabTestRemoveItem", id)).toBe(true);
    await expect.poll(() => getPos(a, id), { timeout: 20_000 }).toBe("");
    expect(await historyAction(a, "Undo")).toBe(true);
    await collabEvaluate(a, () => JSON.parse((window as unknown as {
      Module: { kicadCollabSnapshotItems(): string };
    }).Module.kicadCollabSnapshotItems()));
    expect(await getPos(a, id)).toBe("");
    expect(await edit(a, "kicadCollabTestUndoDepth")).toBe(0);
    await a.close();
    await b.close();
  });

  test(`${tool}: immediate undo and superseding peer field keep local-only history`, async ({ context }) => {
    test.setTimeout(240_000);
    const a = await context.newPage();
    const b = await context.newPage();
    await bootOpen(a, cfg);
    await bootOpen(b, cfg);
    const room = `host-immediate-${tool}-${test.info().workerIndex}`;
    await startV2(a, { room, seedText: cfg.fixture });
    await startV2(b, { room, editorMatchesDoc: true });
    const before = await getPos(a, id);
    expect(await edit(a, move, id, tool === "pcbnew" ? 2_000_000 : 20_000, 0)).toBe(true);
    expect(await historyAction(a, "Undo")).toBe(true);
    await expect.poll(() => getPos(a, id)).toBe(before);
    expect(await historyAction(a, "Redo")).toBe(true);
    await expect.poll(() => getPos(b, id)).not.toBe(before);

    const fields = tool === "pcbnew" ? ["Value"] : [];
    expect(await edit(a, field, id, ...fields, "local-value")).toBe(true);
    await expect.poll(() => modelText(b, cfg)).toContain("local-value");
    expect(await edit(b, field, id, ...fields, "superseding-peer-value")).toBe(true);
    await expect.poll(() => modelText(a, cfg)).toContain("superseding-peer-value");
    expect(await historyAction(a, "Undo")).toBe(true);
    expect(await modelText(a, cfg)).toContain("superseding-peer-value");
    expect(await historyAction(a, "Redo")).toBe(true);
    expect(await modelText(a, cfg)).toContain("superseding-peer-value");
    expect(await edit(a, "kicadCollabTestUndoDepth")).toBe(0);
    await a.close();
    await b.close();
  });
}
