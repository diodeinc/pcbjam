// SPDX-License-Identifier: GPL-3.0-only
import { expect, test } from "vitest";
import { applyDeltaToY, docDelta, fileToDoc } from "@pcbjam/shared";
import {
  Y, LOCAL_KICAD_EDIT, applyBase64Update, createKicadHistory,
  itemWiresUpdate, materializeRootDiff, seedKicadDoc, yToDoc,
} from "./collab";

const footprint = "6f76cd60-3a83-4dc2-9450-7a687b924d30";
const text = "55937cbf-3e73-478f-a232-6321d6144042";
const board = (item: string) => `(kicad_pcb ${item})`;
const clone = (doc: Y.Doc) => {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
  return peer;
};

function exercise(seed: string, local: string, normalized: string, undone: string) {
  const doc = seedKicadDoc(board(seed));
  const rendered = clone(doc), server = clone(doc), peer = clone(doc);
  const history = createKicadHistory(doc);
  const expected = (item: string) => fileToDoc(board(item)).items;
  const assertItems = (item: string) => {
    // Parse independently authored KiCad syntax, not a snapshot of Y.Array keys
    // or the implementation's serialization. This compares every ordered slot.
    expect(yToDoc(doc).items).toEqual(expected(item));
    const wire = materializeRootDiff(rendered, doc);
    expect(wire.added).toEqual([]);
    expect(wire.removed).toEqual([]);
    expect(wire.changed).toHaveLength(1);
    expect(wire.changed[0].sexpr).toMatch(/^\(footprint "Sensor:QFN-24"/);
    expect(fileToDoc(board(wire.changed[0].sexpr)).items).toEqual(expected(item));
  };
  const converge = () => {
    for (const replica of [server, peer]) {
      Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(replica)));
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(replica, Y.encodeStateVector(doc)));
      expect(yToDoc(replica)).toEqual(yToDoc(doc));
      expect(Y.encodeStateVector(replica)).toEqual(Y.encodeStateVector(doc));
    }
  };
  try {
    // Real browser branch: rendered native state -> item wires -> tracked local
    // update. Server normalization follows that branch, but is never tracked.
    const update = itemWiresUpdate(rendered, {
      added: [], changed: [{ sexpr: local, parent: null }], removed: [],
    });
    applyBase64Update(doc, update, LOCAL_KICAD_EDIT);
    assertItems(local);
    Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
    applyDeltaToY(server, docDelta(yToDoc(server), fileToDoc(board(normalized))), "native-finish");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
    assertItems(normalized);
    expect(history.undoStack).toHaveLength(1);
    expect(history.redoStack).toHaveLength(0);
    converge();
    history.undo();
    assertItems(undone);
    expect(history.undoStack).toHaveLength(0);
    expect(history.redoStack).toHaveLength(1);
    converge();
    history.redo();
    assertItems(normalized);
    expect(history.undoStack).toHaveLength(1);
    expect(history.redoStack).toHaveLength(0);
    converge();
  } finally {
    history.destroy();
    for (const replica of [doc, rendered, server, peer]) replica.destroy();
  }
}

test("rotation Undo preserves the leading footprint name across native normalization", () => {
  for (let iteration = 0; iteration < 20; iteration++) {
    exercise(
      `(footprint "Sensor:QFN-24" (layer "F.Cu") (at 13 27 0) (uuid "${footprint}"))`,
      `(footprint "Sensor:QFN-24" (layer "F.Cu") (uuid "${footprint}") (at 13 27 45))`,
      `(footprint "Sensor:QFN-24" (version 20260101) (generator "pcbnew") (layer "F.Cu") (uuid "${footprint}") (at 13 27 45))`,
      `(footprint "Sensor:QFN-24" (version 20260101) (generator "pcbnew") (layer "F.Cu") (at 13 27 0) (uuid "${footprint}"))`,
    );
  }
});

test("fp_text hide remains interleaved after reorder, normalization, Undo and Redo", () => {
  const wrap = (body: string) => `(footprint "Sensor:QFN-24" (layer "F.Cu") (uuid "${footprint}") (fp_text ${body}))`;
  for (let iteration = 0; iteration < 20; iteration++) {
    exercise(
      wrap(`reference "U7" (at 3 4) (layer "F.SilkS") hide (uuid "${text}")`),
      wrap(`reference "U7" (layer "F.SilkS") (at 3 4) hide (uuid "${text}")`),
      wrap(`reference "U7" (layer "F.SilkS") (at 3 4) hide (effects (font (size 1 1) (thickness 0.15))) (uuid "${text}")`),
      wrap(`reference "U7" (at 3 4) (layer "F.SilkS") hide (effects (font (size 1 1) (thickness 0.15))) (uuid "${text}")`),
    );
  }
});
