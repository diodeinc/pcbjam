import { expect, it } from "vitest";
import { Y, applyBase64Update, updateBase64, createKicadHistory, LOCAL_KICAD_EDIT } from "./collab";
import { restoreKicadDraft } from "./kicadDrafts";
import { kicadItemsMap } from "@pcbjam/shared";
it("restores a draft idempotently but refuses an independently reseeded server", () => {
  const old = new Y.Doc(); old.getMap("items").set("a",1);
  const confirmed = updateBase64(old);
  old.getMap("items").set("a",2);
  const draft = {doc:updateBase64(old), confirmed};
  const server = new Y.Doc(); applyBase64Update(server,confirmed);
  restoreKicadDraft(server,draft);
  expect(server.getMap("items").get("a")).toBe(2);
  const before = updateBase64(server); restoreKicadDraft(server,draft);
  expect(updateBase64(server)).toBe(before);
  const reseeded = new Y.Doc(); reseeded.getMap("items").set("a",1);
  expect(() => restoreKicadDraft(reseeded,draft)).toThrow("different server history");
  expect(reseeded.getMap("items").get("a")).toBe(1);
  old.destroy(); server.destroy(); reseeded.destroy();
});
it("host history tracks only local edits, not incoming shared updates", () => {
  const doc = new Y.Doc();
  const history = createKicadHistory(doc);
  // History scopes the kicad root, not unrelated host state.
  expect(history.canUndo()).toBe(false);
  doc.getMap("unrelated").set("a",1);
  expect(history.canUndo()).toBe(false);
  const items = kicadItemsMap(doc);
  doc.transact(() => items.set("local", new Y.Map()), LOCAL_KICAD_EDIT);
  expect(history.canUndo()).toBe(true);
  items.set("remote", new Y.Map());
  history.undo();
  expect(items.has("local")).toBe(false);
  expect(items.has("remote")).toBe(true);
  history.redo();
  expect(items.has("local")).toBe(true);
  history.destroy(); doc.destroy();
});
