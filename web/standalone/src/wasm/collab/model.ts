// Adapted from diodeinc/diode packages/kicad-collab at PR #2854
// (3541e1d84d760ac5b9bf0f91296bcfe31e8be0de). Keep the private-rendered-branch
// capture and field-level history semantics aligned with that integration.
import * as Y from "yjs";
import {
  applyDeltaToY,
  deltaFromYEvents,
  deltaToItemsWire,
  docDelta,
  docToY,
  fileToDoc,
  itemsWireToDelta,
  kicadItemsMap,
  kicadLibSymbolsMap,
  parseItemsWireDelta,
  upsertLibSymbolsToY,
  wireLibSymbols,
  yToDoc,
  yToItemUnchecked,
  type ItemsWireDelta,
  type KicadDelta,
  type KicadDoc,
} from "@pcbjam/shared";

export { yToDoc, parseItemsWireDelta } from "@pcbjam/shared";
export { Y };
export type { ItemsWireDelta, KicadDoc, WireItem } from "@pcbjam/shared";

export const bytesToBase64 = (bytes: Uint8Array): string => {
  if (typeof Buffer !== "undefined")
    return Buffer.from(bytes).toString("base64");
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(text);
};

export const base64ToBytes = (value: string): Uint8Array =>
  typeof Buffer === "undefined"
    ? Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
    : new Uint8Array(Buffer.from(value, "base64"));

/** Seed a fresh browser replica from a native KiCad file. */
export function seedKicadDoc(contents: string): Y.Doc {
  const doc = new Y.Doc();
  docToY(fileToDoc(contents), doc);
  return doc;
}

export function applyBase64Update(
  doc: Y.Doc,
  update: string,
  origin?: unknown
): void {
  Y.applyUpdate(doc, base64ToBytes(update), origin);
}

export const LOCAL_KICAD_EDIT = Symbol("local-kicad-edit");

/** Track local board changes only; native normalization and peer edits are not undo entries. */
export function createKicadHistory(doc: Y.Doc): Y.UndoManager {
  return new Y.UndoManager(kicadItemsMap(doc), {
    trackedOrigins: new Set([LOCAL_KICAD_EDIT]),
    captureTimeout: 0,
  });
}

export function stateVectorBase64(doc: Y.Doc): string {
  return bytesToBase64(Y.encodeStateVector(doc));
}

export function updateBase64(doc: Y.Doc, stateVector?: string): string {
  return bytesToBase64(
    Y.encodeStateAsUpdate(
      doc,
      stateVector ? base64ToBytes(stateVector) : undefined
    )
  );
}

/**
 * Apply native item wires on a private browser branch and return only that
 * branch's Y update. This prevents a stale native snapshot replacing fields
 * already merged into the caller's live replica.
 */
export function itemWiresUpdate(doc: Y.Doc, wire: ItemsWireDelta): string {
  const delta = strictItemsWireToDelta(wire, yToDoc(doc).items);
  const branch = new Y.Doc();
  Y.applyUpdate(branch, Y.encodeStateAsUpdate(doc));
  const before = Y.encodeStateVector(branch);
  applyDeltaToY(branch, delta);
  upsertLibSymbolsToY(branch, wireLibSymbols(wire));
  const update = bytesToBase64(Y.encodeStateAsUpdate(branch, before));
  branch.destroy();
  return update;
}

/** Canonical local-edit delta from settled native snapshots captured under the host render lock. */
export function diffItemSnapshots(
  before: string,
  after: string
): ItemsWireDelta {
  if (before === after) return { added: [], changed: [], removed: [] };
  const previous = itemsSnapshotToDoc(before);
  const next = itemsSnapshotToDoc(after);
  const definitions = wireLibSymbols(parseItemsWireDelta(after));
  return rootOnly(
    deltaToItemsWire(docDelta(previous, next), next.items, (id) => definitions[id]),
    previous
  );
}

function strictItemsWireToDelta(
  wire: ItemsWireDelta,
  current: KicadDoc["items"]
) {
  return itemsWireToDelta(wire, current, (_wire, error) => {
    throw error;
  });
}

function itemsSnapshotToDoc(raw: string): KicadDoc {
  return itemsWireToDoc(parseItemsWireDelta(raw));
}

function itemsWireToDoc(wire: ItemsWireDelta): KicadDoc {
  return {
    root: "kicad_pcb",
    layout: [],
    items: Object.fromEntries(
      strictItemsWireToDelta(wire, {}).added.map(({ uuid, ...item }) => [
        uuid,
        item,
      ])
    ),
  };
}

/**
 * Rebase an in-progress native preview over the latest committed replica.
 * The preview diff is applied to a private branch so it cannot enter Yjs
 * history. Updates to remotely deleted committed items are discarded.
 * Snapshots cover the native checkpoint's changed roots; changedRoots carries
 * their latest authoritative replacements and removals, not the full document.
 */
export function rebaseKicadPreview(
  committedItems: string,
  workingItems: string,
  changedRoots: ItemsWireDelta
): { working: ItemsWireDelta; committed: ItemsWireDelta } {
  const committedDoc = itemsSnapshotToDoc(committedItems);
  const workingDoc = itemsSnapshotToDoc(workingItems);
  const latestDoc = itemsWireToDoc(changedRoots);
  const local = docDelta(committedDoc, workingDoc);
  const locallyAdded = new Set(local.added.map(({ uuid }) => uuid));

  // Added descendants are valid only when their root is also a genuine local
  // addition. This prevents a speculative child edit/add from rebuilding a
  // remotely deleted committed ancestor.
  const hasLiveOrAddedAncestry = (uuid: string): boolean => {
    let item = workingDoc.items[uuid];
    while (item?.parent !== null) {
      const parent = item?.parent;
      if (!parent) return false;
      if (!latestDoc.items[parent] && !locallyAdded.has(parent)) return false;
      item = workingDoc.items[parent];
    }
    return true;
  };
  const equal = (left: unknown, right: unknown): boolean =>
    JSON.stringify(left) === JSON.stringify(right);
  const slotIdentity = (value: unknown): string | undefined => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return undefined;
    if ("k" in value && typeof value.k === "string") return `key:${value.k}`;
    if ("item" in value && typeof value.item === "string")
      return `item:${value.item}`;
    if ("atom" in value && typeof value.atom === "string")
      return `atom:${value.atom}`;
    return undefined;
  };
  const mergeLocal = (
    base: unknown,
    localValue: unknown,
    remote: unknown
  ): unknown => {
    if (equal(base, localValue)) return remote;
    if (
      Array.isArray(base) &&
      Array.isArray(localValue) &&
      Array.isArray(remote)
    ) {
      const atomsOnly = [...base, ...localValue, ...remote].every(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          !Array.isArray(entry) &&
          "atom" in entry
      );
      if (atomsOnly) return localValue;
      const identified = [...base, ...localValue, ...remote].every(
        (entry) => slotIdentity(entry) !== undefined
      );
      // Atom tuples (coordinates, sizes, and similar values) are one field.
      // Slot lists, however, can be merged by their syntax key or child UUID.
      if (!identified) return localValue;

      const group = (values: unknown[]): Map<string, unknown[]> => {
        const result = new Map<string, unknown[]>();
        for (const value of values) {
          const identity = slotIdentity(value)!;
          result.set(identity, [...(result.get(identity) ?? []), value]);
        }
        return result;
      };
      const baseGroups = group(base);
      const localGroups = group(localValue);
      const remoteGroups = group(remote);
      const localOrder = [...new Set(localValue.map(slotIdentity) as string[])];
      const remoteOrder = [...new Set(remote.map(slotIdentity) as string[])];
      const order = [...localOrder];
      // Keep native ordering while inserting peer-added groups around the
      // nearest groups that are still present in the locally ordered list.
      for (const identity of remoteOrder) {
        if (order.includes(identity) || baseGroups.has(identity)) continue;
        const remoteIndex = remoteOrder.indexOf(identity);
        const previous = remoteOrder
          .slice(0, remoteIndex)
          .reverse()
          .find((candidate) => order.includes(candidate));
        const next = remoteOrder
          .slice(remoteIndex + 1)
          .find((candidate) => order.includes(candidate));
        if (previous !== undefined)
          order.splice(order.lastIndexOf(previous) + 1, 0, identity);
        else if (next !== undefined)
          order.splice(order.indexOf(next), 0, identity);
        else order.push(identity);
      }

      return order.flatMap((identity) => {
        const baseGroup = baseGroups.get(identity);
        const localGroup = localGroups.get(identity);
        const remoteGroup = remoteGroups.get(identity);
        if (!localGroup) return baseGroup ? [] : (remoteGroup ?? []); // Only base groups can be locally deleted.
        if (!baseGroup) return localGroup; // A genuine local addition wins.
        if (equal(baseGroup, localGroup)) return remoteGroup ?? [];
        // Repeated keys are a sequence, not independently alignable slots.
        if (
          baseGroup.length !== 1 ||
          localGroup.length !== 1 ||
          remoteGroup?.length !== 1
        )
          return localGroup;
        return [mergeLocal(baseGroup[0], localGroup[0], remoteGroup[0])];
      });
    }
    if (
      typeof base === "object" &&
      base !== null &&
      typeof localValue === "object" &&
      localValue !== null &&
      typeof remote === "object" &&
      remote !== null &&
      !Array.isArray(base) &&
      !Array.isArray(localValue) &&
      !Array.isArray(remote)
    ) {
      const baseObject = base as Record<string, unknown>;
      const localObject = localValue as Record<string, unknown>;
      const remoteObject = remote as Record<string, unknown>;
      return Object.fromEntries(
        [
          ...new Set([
            ...Object.keys(remoteObject),
            ...Object.keys(localObject),
          ]),
        ].flatMap((key) => {
          if (!(key in localObject))
            return key in baseObject ? [] : [[key, remoteObject[key]]];
          if (
            !(key in remoteObject) &&
            key in baseObject &&
            equal(localObject[key], baseObject[key])
          )
            return [];
          return [
            [
              key,
              mergeLocal(baseObject[key], localObject[key], remoteObject[key]),
            ],
          ];
        })
      );
    }
    return localValue;
  };
  const withoutDeletedRefs = (value: unknown): unknown => {
    if (Array.isArray(value))
      return value
        .filter((entry) => {
          if (typeof entry !== "object" || entry === null || !("item" in entry))
            return true;
          const uuid = (entry as { item: string }).item;
          return latestDoc.items[uuid] !== undefined || locallyAdded.has(uuid);
        })
        .map(withoutDeletedRefs);
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          withoutDeletedRefs(entry),
        ])
      );
    return value;
  };
  const overlay = {
    added: local.added.filter(
      ({ uuid }) => locallyAdded.has(uuid) && hasLiveOrAddedAncestry(uuid)
    ),
    updated: local.updated.flatMap(({ uuid }) => {
      const remote = latestDoc.items[uuid];
      const base = committedDoc.items[uuid];
      const localItem = workingDoc.items[uuid];
      if (!remote || !base || !localItem) return [];
      return [
        {
          uuid,
          ...(mergeLocal(
            base,
            withoutDeletedRefs(localItem),
            remote
          ) as typeof remote),
        },
      ];
    }),
    removed: local.removed.filter(
      (uuid) => latestDoc.items[uuid] !== undefined
    ),
  };

  const branch = new Y.Doc();
  // Re-materialize rather than clone CRDT identities: the local overlay must
  // deterministically follow (and therefore mask) the latest field values.
  docToY(latestDoc, branch);
  applyDeltaToY(branch, overlay);
  const result = {
    working: materializeRootDiff(workingDoc, branch),
    committed: rootOnly(
      deltaToItemsWire(docDelta(committedDoc, latestDoc), latestDoc.items),
      committedDoc
    ),
  };
  branch.destroy();
  // Native KiCad normalizes formatting and omits some file-only items.
  // A remote render must touch only roots changed in the logical replica,
  // not rewrite unrelated native objects because their serialization differs.
  const roots = new Set([
    ...changedRoots.removed,
    ...Object.entries(latestDoc.items)
      .filter(([, item]) => item.parent === null)
      .map(([uuid]) => uuid),
  ]);
  const keep = (item: ItemsWireDelta["added"][number]) =>
    strictItemsWireToDelta(
      { added: [item], changed: [], removed: [] },
      {}
    ).added.some((item) => item.parent === null && roots.has(item.uuid));
  for (const wire of [result.working, result.committed]) {
    wire.added = wire.added.filter(keep);
    wire.changed = wire.changed.filter(keep);
    wire.removed = wire.removed.filter((id) => roots.has(id));
  }
  return result;
}

// Board-item materialization is cached per replica, not per action. The public
// PCBJam observer decodes only UUIDs touched by a transaction, including nested
// field edits. Layout metadata is irrelevant to this item-only render path.
const itemViews = new WeakMap<
  Y.Doc,
  {
    doc: KicadDoc;
    fingerprints: Map<string, string>;
  }
>();

function itemView(doc: Y.Doc) {
  const existing = itemViews.get(doc);
  if (existing) return existing;
  const map = kicadItemsMap(doc);
  const view = {
    doc: { root: "kicad_pcb", layout: [], items: {} } as KicadDoc,
    fingerprints: new Map<string, string>(),
  };
  const set = (uuid: string, item: KicadDoc["items"][string]) => {
    view.doc.items[uuid] = item;
    view.fingerprints.set(uuid, JSON.stringify(item));
  };
  map.forEach((item, uuid) => set(uuid, yToItemUnchecked(item)));
  map.observeDeep((events) => {
    const delta = deltaFromYEvents(map, events);
    for (const { uuid, ...item } of [...delta.added, ...delta.updated])
      set(uuid, item);
    for (const uuid of delta.removed) {
      delete view.doc.items[uuid];
      view.fingerprints.delete(uuid);
    }
  });
  itemViews.set(doc, view);
  return view;
}

/** Materialize an item-only diff, lifting descendants and removals to roots. */
export function materializeRootDiff(
  from: KicadDoc | Y.Doc,
  doc: Y.Doc
): ItemsWireDelta {
  const desired = itemView(doc);
  const libDefs = (id: string) => kicadLibSymbolsMap(doc).get(id);
  if (from instanceof Y.Doc) {
    const previous = itemView(from);
    const { added, updated, removed }: KicadDelta = {
      added: [],
      updated: [],
      removed: [],
    };
    for (const [uuid, fingerprint] of desired.fingerprints) {
      if (previous.fingerprints.get(uuid) === fingerprint) continue;
      const entry = { uuid, ...desired.doc.items[uuid]! };
      (previous.fingerprints.has(uuid) ? updated : added).push(entry);
    }
    for (const uuid of previous.fingerprints.keys()) {
      if (!desired.fingerprints.has(uuid)) removed.push(uuid);
    }
    return rootOnly(
      deltaToItemsWire({ added, updated, removed }, desired.doc.items, libDefs),
      previous.doc
    );
  }
  return rootOnly(
    deltaToItemsWire(docDelta(from, desired.doc), desired.doc.items, libDefs),
    from
  );
}

export function rootOnly(
  wire: ItemsWireDelta,
  native: KicadDoc
): ItemsWireDelta {
  // Child removals have already made their surviving ancestor appear in
  // `changed`; sending both that replacement and a child removal is forbidden.
  return {
    ...wire,
    removed: wire.removed.filter((id) => native.items[id]?.parent === null),
  };
}
