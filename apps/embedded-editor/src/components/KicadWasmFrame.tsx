// SPDX-License-Identifier: GPL-3.0-only

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  isKicadWasmEnvelope,
  kicadBrowserCompatibilityError,
  KICAD_WASM_PROTOCOL,
  type KicadWasmBoard,
  type KicadWasmCommand,
  type KicadWasmEnvelope,
  validateKicadWasmBoard,
} from "@/lib/kicadWasmProtocol";
import { parseKicadToolbar, type KicadToolbarState } from "@/lib/kicadToolbar";
import { KicadToolbar } from "./KicadToolbar";

export interface KicadWasmFrameHandle {
  saveBoard(): Promise<string>;
  tryLock(): Promise<boolean>;
  unlock(): Promise<void>;
  applyItems(delta: string): Promise<void>;
  prepareItems(delta: string): Promise<void>;
  captureItems(): Promise<string | null>;
  snapshotItems(): Promise<string>;
  snapshotState(delta: string): Promise<{ committed: string; working: string }>;
  setReadOnly(readOnly: boolean): Promise<void>;
  setHistoryState(canUndo: boolean, canRedo: boolean): Promise<void>;
  diagnostics(): unknown;
}

export interface KicadWasmFrameProps {
  initialBoard: KicadWasmBoard;
  local?: boolean;
  onReady?: () => void;
  onError?: (error: Error) => void;
  onChanged?: () => void;
  onHistory?: (direction: "undo" | "redo") => void;
  className?: string;
}

const MAX_PENDING_REQUESTS = 32;
const REQUEST_TIMEOUT_MS = 300_000;

export const KicadWasmFrame = forwardRef<
  KicadWasmFrameHandle,
  KicadWasmFrameProps
>(function KicadWasmFrame(
  { initialBoard, local = false, onReady, onError, onChanged, onHistory, className },
  ref
) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleOnce, setVisibleOnce] = useState(false);
  const [toolbarReady, setToolbarReady] = useState(false);
  const [toolbar, setToolbar] = useState<KicadToolbarState | null>(null);
  const [toolbarError, setToolbarError] = useState<string | null>(null);
  const [toolbarRefreshError, setToolbarRefreshError] = useState<string | null>(
    null
  );
  const lastDiagnostics = useRef<unknown>(null);
  const callbacksRef = useRef({
    onReady,
    onError,
    onChanged,
    onHistory,
  });
  const pendingRef = useRef(
    new Map<
      string,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        cancelTimeout: () => void;
      }
    >()
  );
  const identity = useMemo(
    () => ({ session: crypto.randomUUID(), nonce: crypto.randomUUID() }),
    []
  );

  callbacksRef.current = { onReady, onError, onChanged, onHistory };
  validateKicadWasmBoard(initialBoard);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
        if (!window.crossOriginIsolated) {
          observer.disconnect();
          callbacksRef.current.onError?.(new Error("KiCad requires cross-origin isolation. Serve the app and host with COOP: same-origin and COEP: require-corp, and delegate cross-origin-isolated to the app iframe."));
          return;
        }
        const compatibilityError = kicadBrowserCompatibilityError(
          WebAssembly as unknown as {
            Suspending?: unknown;
            promising?: unknown;
          }
        );
        if (compatibilityError) {
          observer.disconnect();
          callbacksRef.current.onError?.(new Error(compatibilityError));
          return;
        }
        setVisibleOnce(true);
        observer.disconnect();
      }
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const post = (
    message: Omit<KicadWasmEnvelope, "protocol" | "session" | "nonce">
  ) => {
    const target = iframeRef.current?.contentWindow;
    if (!target) throw new Error("KiCad iframe is not available");
    target.postMessage(
      { ...message, ...identity, protocol: KICAD_WASM_PROTOCOL },
      window.location.origin
    );
  };

  const request = (
    type: KicadWasmCommand,
    payload?: unknown
  ): Promise<unknown> => {
    if (pendingRef.current.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error("KiCad request queue is full"));
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancelTimeout = () => {
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", armTimeout);
      };
      const armTimeout = () => {
        clearTimeout(timer);
        // Chrome suspends the hidden renderer's JSPI/animation work. Give it
        // a fresh bounded deadline when visible, not a spurious fatal timeout.
        if (!document.hidden)
          timer = setTimeout(() => {
            cancelTimeout();
            pendingRef.current.delete(requestId);
            reject(new Error(`KiCad ${type} request timed out`));
          }, REQUEST_TIMEOUT_MS);
      };
      document.addEventListener("visibilitychange", armTimeout);
      armTimeout();
      pendingRef.current.set(requestId, { resolve, reject, cancelTimeout });
      try {
        post({ type, requestId, payload });
      } catch (error) {
        cancelTimeout();
        pendingRef.current.delete(requestId);
        reject(error);
      }
    });
  };

  useImperativeHandle(ref, () => ({
    saveBoard: async () => (await request("save-board")) as string,
    diagnostics: () => {
      const target = iframeRef.current?.contentWindow as
        | (Window & {
            diodeKicadDiagnostics?: { snapshot(): unknown };
          })
        | null;
      return (
        target?.diodeKicadDiagnostics?.snapshot() ?? lastDiagnostics.current
      );
    },
    tryLock: async () => (await request("try-lock")) === true,
    unlock: async () => void (await request("unlock")),
    applyItems: async (delta) => void (await request("apply-items", { delta })),
    prepareItems: async (delta) =>
      void (await request("prepare-items", { delta })),
    captureItems: async () => (await request("capture-items")) as string | null,
    snapshotItems: async () => (await request("snapshot-items")) as string,
    snapshotState: async (delta) =>
      (await request("snapshot-state", { delta })) as {
        committed: string;
        working: string;
      },
    setReadOnly: async (readOnly) =>
      void (await request("set-read-only", { readOnly })),
    setHistoryState: async (canUndo, canRedo) =>
      void (await request("set-history-state", { canUndo, canRedo })),
  }));

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (
        event.source !== iframeRef.current?.contentWindow ||
        event.origin !== window.location.origin
      )
        return;
      if (!isKicadWasmEnvelope(event.data)) return;
      const message = event.data;
      if (
        message.session !== identity.session ||
        message.nonce !== identity.nonce
      )
        return;
      if (message.type === "diagnostics")
        lastDiagnostics.current = message.payload;
      if (message.type === "ready") {
        setToolbarReady(true);
        callbacksRef.current.onReady?.();
      }
      if (message.type === "changed") callbacksRef.current.onChanged?.();
      if (
        message.type === "history" &&
        (message.payload === "undo" || message.payload === "redo")
      )
        callbacksRef.current.onHistory?.(message.payload);
      if (message.type === "error" && !message.requestId) {
        setToolbarReady(false);
        setToolbar(null);
        iframeRef.current?.setAttribute("inert", "");
        for (const request of pendingRef.current.values()) {
          request.cancelTimeout();
          request.reject(new Error("KiCad runtime stopped"));
        }
        pendingRef.current.clear();
        callbacksRef.current.onError?.(
          new Error(
            typeof message.payload === "string"
              ? message.payload
              : "KiCad failed"
          )
        );
      }
      if (
        (message.type === "response" || message.type === "request-error") &&
        message.requestId
      ) {
        const pending = pendingRef.current.get(message.requestId);
        if (!pending) return;
        pending.cancelTimeout();
        pendingRef.current.delete(message.requestId);
        if (message.type === "request-error")
          pending.reject(
            new Error(String(message.payload ?? "KiCad request failed"))
          );
        else pending.resolve(message.payload);
      }
    };
    window.addEventListener("message", handleMessage);
    const pending = pendingRef.current;
    return () => {
      window.removeEventListener("message", handleMessage);
      for (const request of pending.values()) {
        request.cancelTimeout();
        request.reject(new Error("KiCad iframe was disposed"));
      }
      pending.clear();
    };
  }, [identity]);

  useEffect(() => {
    if (!toolbarReady) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let previous = "";
    const refresh = async () => {
      try {
        if (!document.hidden) {
          const value = await request("toolbar-state");
          const serialized = JSON.stringify(value);
          if (!disposed && value !== null) {
            if (serialized !== previous) {
              setToolbar(parseKicadToolbar(value));
              previous = serialized;
            }
            setToolbarRefreshError(null);
          }
        }
      } catch (error) {
        if (!disposed)
          setToolbarRefreshError(
            error instanceof Error ? error.message : "Toolbar unavailable"
          );
      } finally {
        if (!disposed) timer = setTimeout(refresh, 500);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
    // request reads refs; avoid restarting polling on toolbar state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolbarReady]);

  const runToolbarCommand = (
    type: "toolbar-command" | "toolbar-choice",
    payload: unknown
  ) => {
    setToolbarError(null);
    void request(type, payload)
      .then((accepted) => {
        if (!accepted)
          setToolbarError("Editor busy or command unavailable. Try again.");
      })
      .catch((error) => setToolbarError(error.message));
  };
  const src = `./kicad/index.html?session=${encodeURIComponent(identity.session)}&nonce=${encodeURIComponent(identity.nonce)}`;
  return (
    <div ref={containerRef} className={`flex flex-col ${className ?? ""}`}>
      <KicadToolbar
        state={toolbar}
        error={toolbarError ?? toolbarRefreshError}
        onCommand={(command) =>
          runToolbarCommand("toolbar-command", { id: command.id })
        }
        onChoice={(id, selected) =>
          runToolbarCommand("toolbar-choice", { id, selected })
        }
      />
      {visibleOnce && (
        <iframe
          ref={iframeRef}
          src={src}
          title="KiCad"
          className="min-h-0 flex-1"
          style={{ width: "100%", border: 0, display: "block" }}
          sandbox="allow-scripts allow-same-origin"
          onLoad={() =>
            post({ type: "init", payload: { board: initialBoard, local } })
          }
        />
      )}
    </div>
  );
});
