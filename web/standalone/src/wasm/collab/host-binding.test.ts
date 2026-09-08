import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { applyDeltaToY, field, itemsWireToDelta, yToDoc } from "@pcbjam/shared";
import { createHostBinding, type HostModule, type HostWindow } from "./host-binding";
import { materializeRootDiff, seedKicadDoc } from "./model";

afterEach(() => vi.useRealTimers());

for (const root of ["kicad_pcb", "kicad_sch"]) describe(root, () => {
  const source = `(${root} (version 20250114)
    (${root === "kicad_pcb" ? 'footprint "Lib:FP"' : 'symbol (lib_id "Device:R")'}
      (at 10 10) (uuid "item-1") (property "Value" "initial")))`;
  const wire = (doc: Y.Doc) => JSON.stringify(materializeRootDiff(
    { root, layout: [], items: {} }, doc,
  ));
  const edit = (doc: Y.Doc, key: string, values: string[]) => {
    const item = yToDoc(doc).items["item-1"]!;
    applyDeltaToY(doc, { added: [], removed: [], updated: [{
      uuid: "item-1", ...item,
      body: item.body.map(slot => "k" in slot && slot.k === key
        ? { k: key, v: values.map(atom => ({ atom })) } : slot),
    }] });
  };
  const value = (doc: Y.Doc, key: string) => field(yToDoc(doc).items["item-1"]!.body, key);
  async function fixture() {
    vi.useFakeTimers();
    const doc = seedKicadDoc(source);
    const native = seedKicadDoc(source);
    let locked = false;
    let available = true;
    let busy = false;
    const assertLocked = () => expect(locked).toBe(true);
    const mod: HostModule = {
      kicadCollabTryLock: vi.fn(() => {
        if (locked || !available) return false;
        locked = true;
        return true;
      }),
      kicadCollabUnlock: vi.fn(() => { assertLocked(); locked = false; }),
      kicadCollabBusy: () => busy,
      kicadCollabSetHistoryMode: vi.fn(() => true),
      kicadCollabSetHistoryState: vi.fn(),
      kicadCollabSnapshotItems: vi.fn(() => { assertLocked(); return wire(native); }),
      kicadCollabPrepareItems: vi.fn(assertLocked),
      kicadCollabSnapshotState: vi.fn(() => {
        assertLocked();
        return JSON.stringify({ committed: wire(native), working: wire(native) });
      }),
      kicadCollabApplyItems: vi.fn(raw => {
        assertLocked();
        applyDeltaToY(native, itemsWireToDelta(JSON.parse(raw), yToDoc(native).items));
      }),
    };
    const win: HostWindow = { kicadCollab: { onFatal: vi.fn() } };
    const binding = createHostBinding(doc, mod, win, {});
    await binding.seed(() => {});
    return { doc, native, mod, win, binding, locked: () => locked,
      available: (v: boolean) => { available = v; }, busy: (v: boolean) => { busy = v; },
      tick: () => vi.advanceTimersByTimeAsync(100),
      destroy: () => { binding.destroy(); doc.destroy(); native.destroy(); },
    };
  }

  it("captures immediate undo before polling, preserves peer fields through undo/redo", async () => {
    const f = await fixture();
    edit(f.native, "at", ["20", "30"]);
    edit(f.doc, "property", ['"Value"', '"peer"']);
    f.win.kicadCollab!.onHistory!("undo");
    await f.tick();
    expect(value(f.native, "at")).toEqual([{ atom: "10" }, { atom: "10" }]);
    expect(value(f.native, "property")).toEqual([{ atom: '"Value"' }, { atom: '"peer"' }]);
    f.win.kicadCollab!.onHistory!("redo");
    await f.tick();
    expect(value(f.native, "at")).toEqual([{ atom: "20" }, { atom: "30" }]);
    expect(value(f.native, "property")).toEqual([{ atom: '"Value"' }, { atom: '"peer"' }]);
    expect(f.win.kicadCollab!.onFatal).not.toHaveBeenCalled();
    f.destroy();
  });

  it("does not undo a superseding peer field or resurrect a remotely deleted root", async () => {
    const f = await fixture();
    edit(f.native, "at", ["20", "30"]);
    await f.tick();
    edit(f.doc, "at", ["40", "50"]);
    await f.tick();
    f.win.kicadCollab!.onHistory!("undo");
    await f.tick();
    expect(value(f.native, "at")).toEqual([{ atom: "40" }, { atom: "50" }]);
    edit(f.native, "at", ["60", "70"]);
    await f.tick();
    applyDeltaToY(f.doc, { added: [], updated: [], removed: ["item-1"] });
    await f.tick();
    f.win.kicadCollab!.onHistory!("undo");
    await f.tick();
    f.win.kicadCollab!.onHistory!("redo");
    await f.tick();
    expect(yToDoc(f.native).items["item-1"]).toBeUndefined();
    expect(yToDoc(f.doc).items["item-1"]).toBeUndefined();
    f.destroy();
  });

  it("does not create history from seeding, normalization, or remote-only edits", async () => {
    const f = await fixture();
    edit(f.doc, "at", ["40", "50"]);
    await f.tick();
    expect(f.mod.kicadCollabSetHistoryState).toHaveBeenLastCalledWith(false, false);
    f.win.kicadCollab!.onHistory!("undo");
    await f.tick();
    expect(value(f.native, "at")).toEqual([{ atom: "40" }, { atom: "50" }]);
    f.destroy();
  });

  it("defers unsupported checkpoints without unlocked snapshots or a 30-second fatal", async () => {
    const f = await fixture();
    const snapshots = vi.mocked(f.mod.kicadCollabSnapshotItems).mock.calls.length;
    f.available(false);
    edit(f.doc, "at", ["40", "50"]);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.mod.kicadCollabSnapshotItems).toHaveBeenCalledTimes(snapshots);
    expect(f.win.kicadCollab!.onFatal).not.toHaveBeenCalled();
    f.available(true);
    await f.tick();
    expect(value(f.native, "at")).toEqual([{ atom: "40" }, { atom: "50" }]);
    f.destroy();
  });

  it("holds the lock through JSPI completion and renders updates received during suspension next", async () => {
    const f = await fixture();
    const apply = f.mod.kicadCollabApplyItems;
    f.mod.kicadCollabApplyItems = vi.fn(raw => { apply(raw); f.busy(true); });
    edit(f.doc, "at", ["40", "50"]);
    await f.tick();
    expect(f.locked()).toBe(true);
    edit(f.doc, "property", ['"Value"', '"during-jspi"']);
    f.busy(false);
    f.mod.kicadCollabApplyItems = apply;
    await vi.advanceTimersByTimeAsync(16);
    expect(f.locked()).toBe(false);
    await f.tick();
    expect(value(f.native, "property")).toEqual([{ atom: '"Value"' }, { atom: '"during-jspi"' }]);
    expect(f.mod.kicadCollabSetHistoryState).toHaveBeenLastCalledWith(false, false);
    f.destroy();
  });

  it("does not touch a destroyed binding after a suspended apply settles", async () => {
    const f = await fixture();
    const apply = f.mod.kicadCollabApplyItems;
    f.mod.kicadCollabApplyItems = vi.fn(raw => { apply(raw); f.busy(true); });
    edit(f.doc, "at", ["40", "50"]);
    await f.tick();
    const snapshots = vi.mocked(f.mod.kicadCollabSnapshotItems).mock.calls.length;
    f.binding.destroy();
    expect(f.locked()).toBe(true);
    f.busy(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.locked()).toBe(false);
    expect(f.mod.kicadCollabSnapshotItems).toHaveBeenCalledTimes(snapshots);
    expect(f.win.kicadCollab!.onFatal).not.toHaveBeenCalled();
    f.doc.destroy();
    f.native.destroy();
  });

  if (root === "kicad_pcb") it("freezes the render target before awaiting a native preview snapshot", async () => {
    const f = await fixture();
    let complete!: (value: string) => void;
    const getState = f.mod.kicadCollabSnapshotState;
    f.mod.kicadCollabSnapshotState = () => new Promise<string>(resolve => { complete = resolve; });
    edit(f.doc, "at", ["40", "50"]);
    await f.tick();
    expect(f.locked()).toBe(true);
    edit(f.doc, "property", ['"Value"', '"during-snapshot"']);
    complete(await getState("{}"));
    f.mod.kicadCollabSnapshotState = getState;
    await vi.advanceTimersByTimeAsync(0);
    expect(value(f.native, "property")).toEqual([{ atom: '"Value"' }, { atom: '"initial"' }]);
    await f.tick();
    expect(value(f.native, "property")).toEqual([{ atom: '"Value"' }, { atom: '"during-snapshot"' }]);
    expect(f.mod.kicadCollabSetHistoryState).toHaveBeenLastCalledWith(false, false);
    f.destroy();
  });
});
