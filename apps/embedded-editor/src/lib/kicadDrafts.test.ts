import { expect, it } from "vitest";
import { Y, applyBase64Update, updateBase64 } from "./collab";
import { restoreKicadDraft } from "./kicadDrafts";

it("replays a draft idempotently when the server saved it before the browser received acknowledgment", () => {
  const server = new Y.Doc();
  server.getMap("items").set("a", 1);
  const confirmed = updateBase64(server);
  server.getMap("items").set("a", 2);
  const draft = { doc: updateBase64(server), confirmed };
  const before = updateBase64(server);
  restoreKicadDraft(server, draft);
  expect(updateBase64(server)).toBe(before);
  server.destroy();
});

it("rejects a re-seeded server before applying saved edits", () => {
  const old = new Y.Doc();
  old.getMap("items").set("a", 1);
  const confirmed = updateBase64(old);
  old.getMap("items").set("a", 2);
  const server = new Y.Doc();
  server.getMap("items").set("a", 1);
  const before = updateBase64(server);
  expect(() => restoreKicadDraft(server, { doc: updateBase64(old), confirmed }))
    .toThrow("different server history");
  expect(updateBase64(server)).toBe(before);
  server.destroy();
  old.destroy();
});

it("rejects incomplete acknowledged history even when the client identity matches", () => {
  const old = new Y.Doc();
  old.getMap("items").set("a", 1);
  const server = new Y.Doc();
  applyBase64Update(server, updateBase64(old));
  old.getMap("items").set("a", 2);
  const confirmed = updateBase64(old);
  old.getMap("items").set("a", 3);
  const before = updateBase64(server);
  expect(() => restoreKicadDraft(server, { doc: updateBase64(old), confirmed }))
    .toThrow("different server history");
  expect(updateBase64(server)).toBe(before);
  old.destroy();
  server.destroy();
});
