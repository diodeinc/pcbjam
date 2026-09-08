// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useRef, useState } from "react";
import { Button, Spinner } from "./ui";
import {
  Y,
  LOCAL_KICAD_EDIT,
  applyBase64Update,
  createKicadHistory,
  diffItemSnapshots,
  itemWiresUpdate,
  materializeRootDiff,
  rebaseKicadPreview,
  stateVectorBase64,
  updateBase64,
  type ItemsWireDelta,
} from "../lib/collab";
import { HostConnection } from "../lib/host";
import type { KicadWasmBoard } from "@/lib/kicadWasmProtocol";
import { KicadDiagnostics } from "@/lib/kicadDiagnostics";
import {
  readKicadDraft,
  restoreKicadDraft,
  saveKicadDraft,
  type KicadDraft,
} from "@/lib/kicadDrafts";
import { KicadWasmFrame, type KicadWasmFrameHandle } from "./KicadWasmFrame";

export function SandboxKicadPane({
  boardPath,
  host,
  readOnly,
}: {
  boardPath: string;
  host: HostConnection;
  readOnly: boolean;
}) {
  const draftKey = host;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const frame = useRef<KicadWasmFrameHandle>(null);
  const [diagnostics] = useState(() => new KicadDiagnostics());
  const failureTrace = useRef<ReturnType<KicadDiagnostics["snapshot"]> | null>(
    null
  );
  // All replicas inherit server structs. Never independently seed the same
  // file into multiple Y.Docs: that would create unrelated CRDT identities.
  const [replicas] = useState(() => {
    const doc = new Y.Doc();
    return {
      doc,
      history: createKicadHistory(doc),
      confirmed: new Y.Doc(),
      rendered: new Y.Doc(),
    };
  });
  const initialized = useRef(false);
  const ready = useRef(false);
  const failed = useRef(false);
  const frameFailed = useRef(false);
  const editVersion = useRef(0);
  const nativeSnapshot = useRef<string | null>(null);
  const historyRequests = useRef<Array<"undo" | "redo">>([]);
  const [board, setBoard] = useState<KicadWasmBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [connectedSessions, setConnectedSessions] = useState<number | null>(
    null
  );
  const wake = useRef<() => void>(() => {});
  const persist = useRef<() => void>(() => {});

  function fail(reason: unknown) {
    diagnostics.record("failure", {
      frame: frameFailed.current,
      editVersion: editVersion.current,
    });
    failureTrace.current ??= diagnostics.snapshot();
    failed.current = true;
    setConnectedSessions(null);
    setError(current => current ?? (reason instanceof Error ? reason.message : String(reason)));
    void frame.current?.setReadOnly(true).catch(() => {});
  }

  function downloadDiagnostics() {
    const report = {
      version: 1,
      capturedAt: new Date().toISOString(),
      frame: frame.current?.diagnostics() ?? null,
      firstFailure: failureTrace.current,
      events: diagnostics.snapshot(),
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" })
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "kicad-diagnostics.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function acceptItems(delta: ItemsWireDelta) {
    if (!delta.added.length && !delta.changed.length && !delta.removed.length)
      return;
    const update = itemWiresUpdate(replicas.rendered, delta);
    applyBase64Update(replicas.rendered, update);
    applyBase64Update(replicas.doc, update, LOCAL_KICAD_EDIT);
    setRejected(null);
    editVersion.current++;
    diagnostics.record("local.items", {
      added: delta.added.length,
      changed: delta.changed.length,
      removed: delta.removed.length,
      editVersion: editVersion.current,
    });
    persist.current();
    wake.current();
  }

  useEffect(() => {
    let disposed = false;
    let active = false;
    let resync = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rendering = false;
    let renderTimer: ReturnType<typeof setTimeout> | undefined;
    let client: HostConnection | undefined;
    let draft: KicadDraft | null = null;
    let hasDraft = false;
    let saves = Promise.resolve();
    let pendingWrites = 0;
    let storageFailed = false;
    failed.current = false;

    persist.current = () => {
      hasDraft = !Y.equalSnapshots(
        Y.snapshot(replicas.doc),
        Y.snapshot(replicas.confirmed)
      );
      const next = {
        doc: updateBase64(replicas.doc),
        confirmed: updateBase64(replicas.confirmed),
      };
      pendingWrites++;
      host.status({ pendingWrites: true, storageFailed });
      saves = saves
        .then(() => saveKicadDraft(draftKey, next))
        .finally(() => {
          pendingWrites--;
          host.status({ pendingWrites: pendingWrites > 0, storageFailed });
        });
      void saves.catch((reason) => {
        storageFailed = true;
        host.status({ pendingWrites: pendingWrites > 0, storageFailed });
        if (!disposed)
          fail(
            new Error(
              `Unable to preserve local KiCad edits: ${reason instanceof Error ? reason.message : String(reason)}`
            )
          );
      });
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (pendingWrites || storageFailed) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    const captureLocal = async (captured?: string) => {
      if (!ready.current || !frame.current) return;
      const snapshot = captured ?? await frame.current.snapshotItems();
      if (disposed || failed.current) return;
      if (nativeSnapshot.current !== null) {
        acceptItems(diffItemSnapshots(nativeSnapshot.current, snapshot));
      }
      nativeSnapshot.current = snapshot;
    };

    // Renderer RPCs can suspend in a background tab. They must not hold up
    // exchanging Yjs updates or acknowledging already-captured local edits.
    const render = async () => {
      if (
        disposed ||
        failed.current ||
        rendering ||
        document.hidden ||
        !ready.current ||
        !frame.current
      )
        return;
      rendering = true;
      clearTimeout(renderTimer);
      let retry = false;
      try {
        // Native snapshots subtract pending COMMIT images, so previews never
        // enter durable Yjs history even while an interactive tool is active.
        if (!historyRequests.current.length) {
          const captured = await frame.current.captureItems();
          if (captured !== null) await captureLocal(captured);
        }
        if (disposed || failed.current) return;
        // History still captures and executes under the existing native lock.
        // Include intents delivered during the batched capture's unlock.
        const settled = historyRequests.current.length > 0 && await frame.current.tryLock();
        if (settled) {
          try {
            await captureLocal();
            if (disposed || failed.current) return;
            const version = editVersion.current;
            for (const direction of historyRequests.current.splice(0)) {
              diagnostics.record(`history.${direction}`, {
                undo: replicas.history.undoStack.length,
                redo: replicas.history.redoStack.length,
              });
              replicas.history[direction]();
              editVersion.current++;
            }
            if (editVersion.current !== version) {
              persist.current();
              wake.current();
            }
          } finally {
            await frame.current.unlock();
          }
        }
        if (disposed || failed.current || document.hidden) return;
        let delta = materializeRootDiff(replicas.rendered, replicas.doc);
        if (
          delta.added.length ||
          delta.changed.length ||
          delta.removed.length
        ) {
          if (!(await frame.current.tryLock())) {
            retry = true;
            return;
          }
          try {
            await frame.current.prepareItems(JSON.stringify(delta));
            await captureLocal();
            if (disposed || failed.current) return;
            delta = materializeRootDiff(replicas.rendered, replicas.doc);
            // Freeze the exact target before awaiting the renderer. Network
            // updates received meanwhile belong to the next render, not this one.
            const target = updateBase64(
              replicas.doc,
              stateVectorBase64(replicas.rendered)
            );
            const state = await frame.current.snapshotState(
              JSON.stringify(delta)
            );
            if (disposed || failed.current) return;
            const rebased = rebaseKicadPreview(
              state.committed,
              state.working,
              delta
            );
            diagnostics.record("render.apply", {
              added: rebased.working.added.length,
              changed: rebased.working.changed.length,
              removed: rebased.working.removed.length,
              editVersion: editVersion.current,
            });
            await frame.current.applyItems(
              JSON.stringify({
                ...rebased.working,
                committed: rebased.committed,
              })
            );
            applyBase64Update(replicas.rendered, target);
            nativeSnapshot.current = await frame.current.snapshotItems();
          } finally {
            await frame.current.unlock();
          }
        }
        if (disposed || failed.current) return;
        await frame.current.setHistoryState(
          !readOnlyRef.current && replicas.history.canUndo(),
          !readOnlyRef.current && replicas.history.canRedo()
        );
        if (disposed || failed.current) return;
        await frame.current.setReadOnly(readOnlyRef.current);
      } catch (reason) {
        if (!disposed) fail(reason);
      } finally {
        rendering = false;
        if (!disposed && !failed.current) {
          renderTimer = setTimeout(() => void render(), retry ? 50 : 1000);
        }
      }
    };

    const sync = async () => {
      if (disposed || failed.current || active || !client) return;
      active = true;
      resync = false;
      clearTimeout(timer);
      try {
        const version = editVersion.current;
        const sent = initialized.current
          ? updateBase64(replicas.doc, stateVectorBase64(replicas.confirmed))
          : undefined;
        const stateVector = stateVectorBase64(replicas.doc);
        // Preserve this packet's local edits before sending. Later edits queue
        // their own writes and remain pending for the next exchange.
        await saves;
        if (disposed || failed.current) return;
        const syncStarted = Date.now();
        diagnostics.record("sync.start", {
          editVersion: version,
          updateBytes: sent?.length ?? 0,
        });
        const response = await client.sync({
          update: sent,
          stateVector,
          includeContents: !initialized.current,
        });
        if (response.connectedSessions !== undefined)
          setConnectedSessions(response.connectedSessions);
        diagnostics.record("sync.end", {
          elapsedMs: Date.now() - syncStarted,
          updateBytes: response.update?.length ?? 0,
          busy: !!response.busy,
          rejected: !!response.rejected,
        });
        if (disposed || failed.current) return;
        if (response.busy) {
          return;
        }
        if (!response.update) throw new Error("Missing Yjs sync update");
        if (sent) applyBase64Update(replicas.confirmed, sent);
        applyBase64Update(replicas.confirmed, response.update);
        applyBase64Update(replicas.doc, response.update);
        if (!initialized.current) {
          if (!response.contents)
            throw new Error("Missing initial native board");
          applyBase64Update(replicas.rendered, response.update);
          if (draft) {
            if (readOnlyRef.current)
              throw new Error(
                "Local KiCad edits are preserved, but this session is read-only."
              );
            restoreKicadDraft(replicas.doc, draft);
            draft = null;
            resync = true;
          }
          const project = await host.request<Record<string, string> | null>("read-project");
          if (disposed) return;
          initialized.current = true;
          setBoard({
            filename: boardPath.split("/").pop()!,
            contents: response.contents,
            projectContents: project ?? undefined,
          });
        }
        if (hasDraft) persist.current();
        void render();
        if (response.rejected) setRejected(response.rejected);
      } catch (reason) {
        if (!disposed) fail(reason);
      } finally {
        active = false;
        if (!disposed && !failed.current)
          timer = setTimeout(() => void sync(), resync ? 50 : 1000);
      }
    };
    wake.current = () => {
      resync = true;
      void sync();
      void render();
    };
    // Rendering resumes when visible; transport never awaits that work.
    const onVisibility = () => {
      if (!document.hidden) wake.current();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void (async () => {
      try {
        draft = await readKicadDraft(draftKey);
        hasDraft = draft !== null;
        if (disposed) return;
        if (
          initialized.current &&
          !Y.equalSnapshots(
            Y.snapshot(replicas.doc),
            Y.snapshot(replicas.confirmed)
          )
        )
          persist.current();
        client = host;
        client.onChange = () => wake.current();
        client.onDisconnect = (reason) => {
          if (!disposed) fail(reason);
        };
        await client.connect();
        if (disposed) {
          client.close();
          return;
        }
        await sync();
      } catch (reason) {
        if (!disposed) fail(reason);
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(renderTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
      client?.close();
      wake.current = () => {};
      persist.current = () => {};
    };
  }, [attempt, boardPath, diagnostics, draftKey, replicas, host]);

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-paper"
      data-kicad-state={error ? "failed" : "collaborating"}
    >
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-2 text-mini text-mutedInk">
        <span className="mr-auto truncate" title={boardPath}>
          {boardPath.split("/").at(-1)}
        </span>
        {!error && board && connectedSessions !== null ? (
          <span className="connection-status" role="status" title="Connected browser tabs, including this tab">
            <span className="connection-dot" aria-hidden="true" />
            {connectedSessions} live {connectedSessions === 1 ? "tab" : "tabs"}
          </span>
        ) : !error ? (
          <span className="flex items-center gap-1.5" role="status">
            <Spinner className="h-3 w-3" />
            Loading KiCad…
          </span>
        ) : null}
        {error && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-6 text-mini"
            onClick={downloadDiagnostics}
          >
            Download diagnostics
          </Button>
        )}
        {error && (
          <Button
            className="h-6 text-mini"
            size="sm"
            onClick={() => {
              if (frameFailed.current) {
                location.reload();
                return;
              }
              setError(null);
              setAttempt((n) => n + 1);
            }}
          >
            {frameFailed.current ? "Reload" : "Reconnect"}
          </Button>
        )}
      </div>
      {(error || rejected) && (
        <div
          role="alert"
          className="border-b border-line px-3 py-2 text-status text-danger"
        >
          {error ??
            `Native KiCad rejected an update; shared state was corrected: ${rejected}`}
          {frameFailed.current &&
            " Download diagnostics before reloading. Reloading restores locally persisted edits; changes not yet captured from KiCad may be lost."}
        </div>
      )}
      {board ? (
        <KicadWasmFrame
          ref={frame}
          className="min-h-0 flex-1"
          initialBoard={board}
          onChanged={() => wake.current()}
          onHistory={(direction) => {
            if (readOnlyRef.current || failed.current || !ready.current) return;
            historyRequests.current.push(direction);
            wake.current();
          }}
          onReady={() => {
            ready.current = true;
            wake.current();
          }}
          onError={(reason) => {
            frameFailed.current = true;
            fail(reason);
          }}
        />
      ) : null}
    </div>
  );
}
