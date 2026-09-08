import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyDeltaToY, itemsWireToDelta, kicadLibSymbolsMap, yToDoc } from "@pcbjam/shared";
import {
  applyBase64Update, diffItemSnapshots, itemWiresUpdate, materializeRootDiff,
  rebaseKicadPreview, seedKicadDoc,
} from "./model";

const base = `(kicad_pcb (version 20241229)
  (footprint "Lib:FP" (at 10 10) (uuid "fp-1") (property "Value" "base")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (uuid "pad-1"))))`;
const snapshot = (text: string) => {
  const doc = seedKicadDoc(text);
  const wire = materializeRootDiff({ root: "kicad_pcb", layout: [], items: {} }, doc);
  doc.destroy();
  return JSON.stringify(wire);
};
const render = (text: string, wire: ReturnType<typeof materializeRootDiff>) => {
  const doc = seedKicadDoc(text);
  applyDeltaToY(doc, itemsWireToDelta(wire, yToDoc(doc).items));
  return snapshotOf(doc);
};
const snapshotOf = (doc: Y.Doc) => JSON.stringify(materializeRootDiff(
  { root: "kicad_pcb", layout: [], items: {} }, doc,
));

describe("committed snapshots and private preview branches", () => {
  it("rejects a malformed full snapshot atomically without publishing healthy roots or deletions", () => {
    const doc = seedKicadDoc(base);
    const before = Y.encodeStateAsUpdate(doc);
    const mixed = { added: [
      { parent: null, sexpr: base.replace("10 10", "20 30") },
      { parent: null, sexpr: "(kicad_pcb)" },
    ], changed: [], removed: ["fp-1"] };
    expect(() => diffItemSnapshots(snapshot(base), JSON.stringify(mixed))).toThrow();
    expect(() => itemWiresUpdate(doc, mixed)).toThrow();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    doc.destroy();
  });

  it("captures a stale native field edit without overwriting unseen peer fields", () => {
    const rendered = seedKicadDoc(base);
    const live = new Y.Doc();
    Y.applyUpdate(live, Y.encodeStateAsUpdate(rendered));
    applyBase64Update(live, itemWiresUpdate(live,
      diffItemSnapshots(snapshot(base), snapshot(base.replace('"base"', '"peer"')))));
    const local = itemWiresUpdate(rendered,
      diffItemSnapshots(snapshot(base), snapshot(base.replace("10 10", "20 30"))));
    applyBase64Update(live, local);
    expect(snapshotOf(live)).toContain("20 30");
    expect(snapshotOf(live)).toContain('\\"peer\\"');
    live.destroy();
    rendered.destroy();
  });

  it("lifts child removal to one parent replacement, never parent replacement plus child removal", () => {
    const doc = seedKicadDoc(base);
    const before = yToDoc(doc);
    applyDeltaToY(doc, { added: [], updated: [], removed: ["pad-1"] });
    const delta = materializeRootDiff(before, doc);
    expect(delta.changed).toHaveLength(1);
    expect(delta.changed[0]!.sexpr).not.toContain("pad-1");
    expect(delta.removed).toEqual([]);
    doc.destroy();
  });

  it("keeps a local preview private and cancellation restores the peer's changed field", () => {
    const committed = seedKicadDoc(base);
    const peer = seedKicadDoc(base.replace('"base"', '"peer"'));
    const working = base.replace("10 10", "20 30");
    const before = Y.encodeStateAsUpdate(committed);
    const delta = materializeRootDiff(committed, peer);
    const rebased = rebaseKicadPreview(snapshot(base), snapshot(working), delta);
    const preview = render(working, rebased.working);
    const rollback = render(base, rebased.committed);
    expect(preview).toContain("20 30");
    expect(preview).toContain('\\"peer\\"');
    expect(rollback).toContain("10 10");
    expect(rollback).toContain('\\"peer\\"');
    expect(Y.encodeStateAsUpdate(committed)).toEqual(before);
    committed.destroy();
    peer.destroy();
  });

  it("does not resurrect a peer-deleted root or its locally previewed descendants", () => {
    const committed = seedKicadDoc(base);
    const peer = seedKicadDoc("(kicad_pcb (version 20241229))");
    const working = base.replace("(size 1 1)", "(size 2 2)");
    const rebased = rebaseKicadPreview(snapshot(base), snapshot(working),
      materializeRootDiff(committed, peer));
    expect(rebased.working.added).toEqual([]);
    expect(rebased.working.changed).toEqual([]);
    expect(rebased.working.removed).toEqual(["fp-1"]);
    expect(rebased.committed.removed).toEqual(["fp-1"]);
    committed.destroy();
    peer.destroy();
  });

  it("carries schematic library definitions on snapshot capture and subsequent peer render", () => {
    const text = `(kicad_sch (version 20250114)
      (lib_symbols (symbol "Device:R" (property "Reference" "R")))
      (symbol (lib_id "Device:R") (at 10 10) (uuid "sym-1")))`;
    const native = seedKicadDoc(text);
    const room = seedKicadDoc("(kicad_sch (version 20250114))");
    const wire = materializeRootDiff(yToDoc(room), native);
    expect(wire.added[0]!.sexpr).toContain("lib_symbols");
    applyBase64Update(room, itemWiresUpdate(room, wire));
    expect(kicadLibSymbolsMap(room).get("Device:R")).toContain('"Reference"');
    expect(materializeRootDiff({ root: "kicad_sch", layout: [], items: {} }, room)
      .added[0]!.sexpr).toContain("lib_symbols");
    native.destroy();
    room.destroy();
  });
});
