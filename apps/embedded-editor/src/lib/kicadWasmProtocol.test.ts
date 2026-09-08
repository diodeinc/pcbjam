import { describe, expect, it } from "vitest";
import {
  isKicadWasmEnvelope,
  kicadBrowserCompatibilityError,
  KICAD_WASM_PROTOCOL,
  validateKicadWasmBoard,
} from "./kicadWasmProtocol";

describe("KiCad WASM protocol", () => {
  it("requires both JSPI entry points before loading the runtime", () => {
    expect(kicadBrowserCompatibilityError({})).toContain("WebAssembly JSPI");
    expect(
      kicadBrowserCompatibilityError({ Suspending: () => {} })
    ).not.toBeNull();
    expect(
      kicadBrowserCompatibilityError({
        Suspending: () => {},
        promising: () => {},
      })
    ).toBeNull();
  });

  it("recognizes only complete protocol envelopes", () => {
    expect(
      isKicadWasmEnvelope({
        protocol: KICAD_WASM_PROTOCOL,
        session: "session",
        nonce: "nonce",
        type: "ready",
      })
    ).toBe(true);
    expect(
      isKicadWasmEnvelope({ protocol: KICAD_WASM_PROTOCOL, type: "ready" })
    ).toBe(false);
    expect(
      isKicadWasmEnvelope({
        protocol: "other",
        session: "s",
        nonce: "n",
        type: "ready",
      })
    ).toBe(false);
  });

  it("accepts a local board and project files", () => {
    expect(() =>
      validateKicadWasmBoard({
        filename: "main.kicad_pcb",
        contents: "(kicad_pcb)",
        projectContents: {
          "main.kicad_pro": "{}",
          "libs/local.pretty/a.kicad_mod": "module",
        },
      })
    ).not.toThrow();
  });

  it.each([
    "../private.kicad_pcb",
    "/private.kicad_pcb",
    "folder/private.kicad_pcb",
    "private.txt",
  ])("rejects unsafe board filename %s", (filename) => {
    expect(() => validateKicadWasmBoard({ filename, contents: "" })).toThrow();
  });

  it("rejects project path traversal", () => {
    expect(() =>
      validateKicadWasmBoard({
        filename: "main.kicad_pcb",
        contents: "",
        projectContents: { "../token": "secret" },
      })
    ).toThrow("Unsafe KiCad project file");
  });
});
