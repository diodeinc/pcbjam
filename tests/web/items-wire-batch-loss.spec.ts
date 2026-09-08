import { test, expect, type Page } from '@playwright/test';
import { collabEvaluate } from '../kicad/utils/collab-lock';

/**
 * P-5: a field cannot be serialized as a standalone board item; its parent
 * footprint and every other edited root must reach the peer without batch loss.
 *
 * The editor now uses locked full snapshots, not onItems deltas. Injecting a
 * synthetic onItems callback no longer exercises production. The original
 * poisoned-delta assertion lives in kicad-binding.test.ts (legacy ingress must
 * keep healthy entries). model.test.ts separately asserts that a malformed FULL
 * snapshot is rejected atomically: treating omitted roots as deletions would
 * corrupt the room. This e2e exercises the native multi-root/field edit itself.
 */
type WireItem = { sexpr: string; parent: string | null };
type W = { Module: {
  kicadCollabSnapshotItems(): string;
  kicadCollabTestItemBlob(uuid: string): string;
  kicadCollabTestMoveBoardItem(uuid: string, dx: number, dy: number): boolean;
  kicadCollabTestSetFootprintField(uuid: string, name: string, text: string): boolean;
}; kicadCollab?: { onHistory?: unknown } };

async function bootBoard(page: Page, user: string): Promise<void> {
  await page.goto(`/default/projects/demo/demo.kicad_pcb?user=${user}`);
  await expect(page.locator('#canvas')).toBeVisible({ timeout: 120000 });
  await expect.poll(() => page.title(), { timeout: 120000 }).toMatch(/demo — PCB Editor/i);
  await page.waitForFunction(() => typeof (window as unknown as W).kicadCollab?.onHistory === 'function');
}

async function blobOf(page: Page, uuid: string): Promise<string> {
  return collabEvaluate(page, id => {
    const wire = JSON.parse((window as unknown as W).Module.kicadCollabSnapshotItems()) as { added: WireItem[] };
    return wire.added.find(item => item.sexpr.includes(id))?.sexpr ?? '';
  }, uuid);
}
async function positionOf(page: Page, uuid: string): Promise<string> {
  return (await blobOf(page, uuid)).match(/\(at [^)]*\)/)?.[0] ?? '(absent)';
}

test('a multi-root edit with a footprint field must not discard any healthy root', async ({ page, context }) => {
  test.setTimeout(240000);
  const alice = page;
  await bootBoard(alice, 'alice');
  const bob = await context.newPage();
  await bootBoard(bob, 'bob');
  const picked = await collabEvaluate(alice, () => {
    const mod = (window as unknown as W).Module;
    const snap = JSON.parse(mod.kicadCollabSnapshotItems()) as { added: WireItem[] };
    const footprints = snap.added.filter(item => /^\s*\(footprint\b/.test(item.sexpr));
    const fp1 = footprints[0];
    const fp2 = footprints.slice(1).find(item => /\(property\s+"[^"]*"[^]*?\(uuid\s+"([^"]+)"\)/.test(item.sexpr));
    if (!fp1 || !fp2) throw new Error('demo must have two footprints, the second with a field');
    const id1 = fp1.sexpr.match(/\(uuid\s+"([^"]+)"\)/)![1];
    const id2 = fp2.sexpr.match(/\(uuid\s+"([^"]+)"\)/)![1];
    const field = fp2.sexpr.match(/\(property\s+"[^"]*"[^]*?\(uuid\s+"([^"]+)"\)/)![1];
    return { id1, id2, fieldBlob: mod.kicadCollabTestItemBlob(field), fpBlob: mod.kicadCollabTestItemBlob(id1) };
  });
  expect(picked.fieldBlob, 'P-5: a standalone field blob is empty text').toBe('');
  expect(picked.fpBlob, 'footprint blob is the footprint form').toMatch(/^\s*\(footprint\b/);
  expect(picked.fpBlob).toContain(`(uuid "${picked.id1}")`);
  const before1 = await positionOf(bob, picked.id1);
  const before2 = await positionOf(bob, picked.id2);
  expect(before1).not.toBe('(absent)');
  expect(before2).not.toBe('(absent)');

  // Control is a real native local edit, not a fabricated callback.
  expect(await collabEvaluate(alice, id =>
    (window as unknown as W).Module.kicadCollabTestMoveBoardItem(id, 1_100_000, 2_200_000), picked.id1)).toBe(true);
  await expect.poll(() => positionOf(bob, picked.id1), { timeout: 30000 }).not.toBe(before1);
  const afterControl = await positionOf(bob, picked.id1);

  // Same checkpoint contains a field edit, its parent movement, and a second
  // root's movement. Every native probe must succeed, then both roots arrive.
  const marker = `batch-field-${test.info().project.name}`;
  expect(await collabEvaluate(alice, ({ id1, id2, marker }) => {
    const mod = (window as unknown as W).Module;
    return [
      mod.kicadCollabTestMoveBoardItem(id2, 3_300_000, 4_400_000),
      mod.kicadCollabTestSetFootprintField(id2, 'Value', marker),
      mod.kicadCollabTestMoveBoardItem(id1, 5_500_000, 6_600_000),
    ];
  }, { ...picked, marker })).toEqual([true, true, true]);
  await expect.poll(() => positionOf(bob, picked.id1), { timeout: 30000 }).not.toBe(afterControl);
  await expect.poll(() => positionOf(bob, picked.id2), { timeout: 30000 }).not.toBe(before2);
  await expect.poll(() => blobOf(bob, picked.id2), { timeout: 30000 }).toContain(marker);
  expect(await positionOf(bob, picked.id1)).toBe(await positionOf(alice, picked.id1));
  expect(await positionOf(bob, picked.id2)).toBe(await positionOf(alice, picked.id2));
  await bob.close();
});
