// SPDX-License-Identifier: GPL-3.0-only
import { Y, applyBase64Update } from "./collab";
import type { HostConnection } from "./host";
export type KicadDraft = { doc: string; confirmed: string };
// Durable storage and multi-tab merging belong exclusively to the host.
export const readKicadDraft = (host: HostConnection) => host.request<KicadDraft | null>("draft-load");
export const saveKicadDraft = (host: HostConnection, draft: KicadDraft) => host.request<void>("draft-merge", draft);
/** Refuse to merge saved edits into independently re-seeded server history. */
export function restoreKicadDraft(server: Y.Doc, draft: KicadDraft): void {
  const confirmed = new Y.Doc();
  try {
    applyBase64Update(confirmed, draft.confirmed);
    const current = Y.decodeStateVector(Y.encodeStateVector(server));
    for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(confirmed))) {
      if ((current.get(client) ?? 0) < clock) throw new Error("Saved KiCad edits belong to a different server history. The local draft has been preserved; do not clear browser storage.");
    }
    applyBase64Update(server, draft.doc);
  } finally { confirmed.destroy(); }
}
