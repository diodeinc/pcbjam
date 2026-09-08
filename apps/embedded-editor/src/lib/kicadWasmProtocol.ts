export const KICAD_WASM_PROTOCOL = "diode-kicad-wasm-v1" as const;

export function kicadBrowserCompatibilityError(wasm: {
  Suspending?: unknown;
  promising?: unknown;
}): string | null {
  return typeof wasm.Suspending === "function" &&
    typeof wasm.promising === "function"
    ? null
    : "This KiCad build requires WebAssembly JSPI, which this browser does not support. Open this board in an up-to-date Chrome browser. Reconnecting will not fix browser compatibility.";
}

export interface KicadWasmBoard {
  filename: string;
  contents: string;
  projectContents?: Record<string, string>;
}

export type KicadWasmCommand =
  | "save-board"
  | "toolbar-state"
  | "toolbar-command"
  | "toolbar-choice"
  | "try-lock"
  | "unlock"
  | "apply-items"
  | "prepare-items"
  | "capture-items"
  | "snapshot-items"
  | "snapshot-state"
  | "set-history-state"
  | "set-read-only";

export interface KicadWasmEnvelope {
  protocol: typeof KICAD_WASM_PROTOCOL;
  session: string;
  nonce: string;
  type: string;
  requestId?: string;
  payload?: unknown;
}

export function isKicadWasmEnvelope(
  value: unknown
): value is KicadWasmEnvelope {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<KicadWasmEnvelope>;
  return (
    message.protocol === KICAD_WASM_PROTOCOL &&
    typeof message.session === "string" &&
    typeof message.nonce === "string" &&
    typeof message.type === "string"
  );
}

export function validateKicadWasmBoard(board: KicadWasmBoard): void {
  if (
    !board ||
    typeof board.filename !== "string" ||
    typeof board.contents !== "string"
  ) {
    throw new Error("KiCad board requires string filename and contents");
  }
  if (!/\.kicad_pcb$/i.test(board.filename) || /[\\/]/.test(board.filename)) {
    throw new Error(
      "KiCad board filename must be a basename ending in .kicad_pcb"
    );
  }
  if (board.projectContents) {
    for (const [filename, contents] of Object.entries(board.projectContents)) {
      if (
        !filename ||
        /(^|[\\/])\.\.([\\/]|$)/.test(filename) ||
        filename.startsWith("/") ||
        typeof contents !== "string"
      ) {
        throw new Error(`Unsafe KiCad project file: ${filename}`);
      }
    }
  }
}
