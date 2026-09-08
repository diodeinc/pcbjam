import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { KicadDiagnostics } from "./kicadDiagnostics";

describe("KiCad diagnostics", () => {
  it("bounds metadata without resetting sequence numbers", () => {
    const trace = new KicadDiagnostics();
    for (let i = 0; i < 500; i++) trace.record("sync", { bytes: i });
    const events = trace.snapshot();
    expect(events).toHaveLength(400);
    expect(events[0].sequence).toBe(101);
    expect(events[399].detail).toEqual({ bytes: 499 });
  });

  it("detaches exported snapshots and caller-owned metadata", () => {
    const trace = new KicadDiagnostics();
    const detail = { bytes: 12 };
    trace.record("apply", detail);
    detail.bytes = 99;
    trace.snapshot()[0].detail.bytes = 123;
    expect(trace.snapshot()[0].detail.bytes).toBe(12);
  });

  it("captures the first JSPI trap, sanitizes stacks, and keeps it after ring rollover", () => {
    const script = readFileSync(
      new URL("../../public/kicad/diagnostics.js", import.meta.url),
      "utf8"
    );
    const context = {
      window: {} as Record<string, any>,
      navigator: { userAgent: "test" },
      innerWidth: 100,
      innerHeight: 80,
      devicePixelRatio: 1,
      console: { warn: () => {}, error: () => {} },
      addEventListener: () => {},
    };
    context.window.__libctxJspi = {
      s: { 251: { finished: false } },
      ghosts: 0,
      deadParked: 0,
    };
    context.window.KICAD_BUILD = { archiveSha256: "pinned-build" };
    runInNewContext(script, context);
    const trace = context.window.diodeKicadDiagnostics;
    trace.start("apply-items", "request-1");
    (context.console.warn as (...args: string[]) => void)(
      "[libctx-jspi] coroutine 251 entry REJECTED: RuntimeError: function signature mismatch\n at kicad_editor.wasm:0x1234\n at wasm://wasm/private-build:wasm-function[123]:0xabcd\n at https://secret.example/?token=private-value"
    );
    trace.end();
    for (let i = 0; i < 450; i++) trace.record("idle");
    trace.failure(new Error("later failure"));
    const report = trace.snapshot();
    expect(report.events).toHaveLength(400);
    expect(report.firstFailure.detail.kind).toBe("function-signature-mismatch");
    expect(report.firstFailure.detail.wasmFrames).toEqual([
      "kicad_editor.wasm:0x1234",
      "wasm-function[123]:0xabcd",
    ]);
    expect(report.firstFailure.activeCommand.type).toBe("apply-items");
    expect(report.firstFailure.coroutines.states).toEqual([
      { id: 251, finished: false },
    ]);
    expect(JSON.stringify(report)).not.toContain("private-value");
    expect(JSON.stringify(report)).not.toContain("secret.example");
    expect(report.build.archiveSha256).toBe("pinned-build");
  });
});
