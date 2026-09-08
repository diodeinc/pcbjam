import * as Y from "yjs";
import { isEmptyItemsWireDelta, yToDoc } from "@pcbjam/shared";
import {
  applyBase64Update, createKicadHistory, diffItemSnapshots, itemWiresUpdate,
  LOCAL_KICAD_EDIT, materializeRootDiff, rebaseKicadPreview,
  stateVectorBase64, updateBase64,
} from "./model";
import { withCollabLock, type CollabLockModule } from "./lock";

export interface HostModule extends CollabLockModule {
  kicadCollabTryLock(): boolean;
  kicadCollabUnlock(): void;
  kicadCollabBusy(): boolean;
  kicadCollabSetHistoryMode(enabled: boolean): boolean;
  kicadCollabSetHistoryState(undo: boolean, redo: boolean): void;
  kicadCollabSnapshotItems(): string | Promise<string>;
  kicadCollabApplyItems(wire: string): unknown;
  kicadCollabPrepareItems(wire: string): unknown;
  kicadCollabSnapshotState(wire: string): string | Promise<string>;
}

export interface HostWindow {
  kicadCollab?: {
    onChanged?: () => void;
    onHistory?: (direction: "undo" | "redo") => void;
    onFatal?: (error: unknown) => void;
    onItems?: (wire: string) => void;
  };
}

/** Locked pull bridge. The private rendered replica is NEVER replaced by the latest doc after an await. */
export function createHostBinding(
  doc: Y.Doc,
  mod: HostModule,
  win: HostWindow,
  opts: { readOnly?: boolean; sheetPath?: string },
) {
  if (!mod.kicadCollabTryLock || !mod.kicadCollabUnlock) {
    throw new Error("Host history requires native collaboration locks");
  }
  const rendered = new Y.Doc();
  const history = createKicadHistory(doc);
  const requests: ("undo" | "redo")[] = [];
  let baseline: string | undefined;
  let ready = false;
  let destroyed = false;
  let failed = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tagged = (wire: object) => JSON.stringify(
    opts.sheetPath === undefined ? wire : { ...wire, sheet: opts.sheetPath },
  );
  const fail = (error: unknown) => {
    failed = true;
    clearTimeout(timer);
    if (win.kicadCollab?.onFatal) win.kicadCollab.onFatal(error);
    else {
      console.error("KiCad host collaboration failed", error);
      setTimeout(() => { throw error; }, 0);
    }
  };
  const settle = async () => {
    const deadline = Date.now() + 30_000;
    while (await mod.kicadCollabBusy()) {
      if (Date.now() >= deadline) throw new Error("KiCad collaboration apply timed out");
      await new Promise<void>((resolve) => setTimeout(resolve, 16));
    }
  };
  const snapshot = async () => {
    await settle();
    if (destroyed) throw new Error("KiCad collaboration binding was destroyed");
    const raw = await mod.kicadCollabSnapshotItems();
    await settle();
    if (!Array.isArray(JSON.parse(raw).added)) throw new Error("Invalid locked KiCad snapshot");
    return raw;
  };
  const capture = async () => {
    const raw = await snapshot();
    if (destroyed || failed) return;
    if (!opts.readOnly && baseline !== undefined) {
      const delta = diffItemSnapshots(baseline, raw);
      if (!isEmptyItemsWireDelta(delta)) {
        const update = itemWiresUpdate(rendered, delta);
        applyBase64Update(rendered, update);
        applyBase64Update(doc, update, LOCAL_KICAD_EDIT);
      }
    }
    baseline = raw;
  };
  const updateHistoryState = () => mod.kicadCollabSetHistoryState(
    !opts.readOnly && history.canUndo(), !opts.readOnly && history.canRedo(),
  );
  async function render() {
    if (!ready || destroyed || failed || running) return;
    running = true;
    try {
      // A user may keep a non-checkpointable tool active indefinitely. Defer
      // rather than fail or snapshot without the mandatory native lock.
      if (!mod.kicadCollabTryLock()) return;
      try {
        if (destroyed || failed) return;
        await capture();
        if (destroyed || failed) return;
        for (const direction of requests.splice(0)) history[direction]();
        let delta = materializeRootDiff(rendered, doc);
        if (!isEmptyItemsWireDelta(delta)) {
          // Schematics only permit an idle checkpoint; PCB additionally exposes
          // working previews and rollback images for in-progress gestures.
          const pcb = yToDoc(doc).root === "kicad_pcb";
          if (pcb) {
            await mod.kicadCollabPrepareItems(tagged(delta));
            await settle();
            await capture();
            if (destroyed || failed) return;
            delta = materializeRootDiff(rendered, doc);
          }
          const target = updateBase64(doc, stateVectorBase64(rendered));
          let wire: object = delta;
          if (pcb) {
            const state = JSON.parse(await mod.kicadCollabSnapshotState(tagged(delta)));
            if (destroyed || failed) return;
            const rebased = rebaseKicadPreview(state.committed, state.working, delta);
            wire = { ...rebased.working, committed: rebased.committed };
          }
          await mod.kicadCollabApplyItems(tagged(wire));
          await settle();
          if (destroyed || failed) return;
          applyBase64Update(rendered, target);
          baseline = await snapshot();
        }
        if (destroyed || failed) return;
        updateHistoryState();
      } finally {
        mod.kicadCollabUnlock();
      }
    } catch (error) {
      if (!destroyed) fail(error);
    } finally {
      running = false;
      wake();
    }
  }
  function wake() {
    if (!ready || destroyed || failed || running || timer !== undefined) return;
    // Polling also covers schematic changes and immediate undo before an idle
    // notification. Each pass captures under the lock, never a live preview.
    timer = setTimeout(() => { timer = undefined; void render(); }, 100);
  }
  const onChanged = () => wake();
  const onHistory = (direction: "undo" | "redo") => {
    if (destroyed || failed || opts.readOnly) return;
    requests.push(direction);
    wake();
  };
  win.kicadCollab = { ...win.kicadCollab, onChanged, onHistory, onItems: undefined };
  doc.on("update", wake);

  return {
    wake,
    get historyState() {
      return { undo: history.undoStack.length, redo: history.redoStack.length,
        pending: requests.length, running };
    },
    async seed(seed: () => void) {
      if (destroyed) return;
      await withCollabLock(mod, async () => {
        if (destroyed) return;
        await settle();
        if (destroyed) return;
        // Opt-in disposes native picker history: it must be at the same safe
        // checkpoint as seed/apply, never during a suspended local command.
        if (!mod.kicadCollabSetHistoryMode(true)) throw new Error("KiCad history frame is not ready");
        seed(); // Existing file/layout seed and normalization, NOT a local-edit origin.
        const target = Y.encodeStateAsUpdate(doc);
        await settle();
        baseline = await snapshot();
        if (destroyed) return;
        Y.applyUpdate(rendered, target);
        history.clear();
        updateHistoryState();
        ready = true;
      });
      wake();
    },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      doc.off("update", wake);
      history.destroy();
      rendered.destroy();
      if (win.kicadCollab?.onHistory === onHistory) {
        win.kicadCollab.onHistory = undefined;
        win.kicadCollab.onChanged = undefined;
      }
      // Do not re-enable native history while an async apply may still own
      // pointers. A new document/frame owns the next history-mode decision.
    },
  };
}
