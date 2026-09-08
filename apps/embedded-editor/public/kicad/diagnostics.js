// Bounded, local-only crash diagnostics. No board blobs, URLs, text input or credentials.
(function () {
  "use strict";
  var events = [];
  var sequence = 0;
  var frozen = null;
  var activeCommand = null;

  function record(event, detail) {
    events.push({
      sequence: ++sequence,
      timeMs: Date.now(),
      event: event,
      detail: detail || {},
    });
    if (events.length > 400) events.shift();
  }
  function coroutines() {
    // Read JS bookkeeping only. Never re-enter damaged WASM to diagnose a trap.
    var ctx = window.__libctxJspi;
    if (!ctx) return null;
    var ids = Object.keys(ctx.s);
    return {
      ghosts: ctx.ghosts,
      deadParked: ctx.deadParked,
      count: ids.length,
      states: ids.slice(-64).map(function (id) {
        return { id: Number(id), finished: Boolean(ctx.s[id].finished) };
      }),
    };
  }
  function snapshot() {
    return {
      version: 1,
      build: window.KICAD_BUILD || null,
      browser: navigator.userAgent,
      crossOriginIsolated: window.crossOriginIsolated,
      jspi: typeof WebAssembly.Suspending === "function",
      viewport: {
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      },
      memoryBytes: window.Module?.HEAPU8?.buffer?.byteLength || null,
      activeCommand: activeCommand,
      coroutines: coroutines(),
      firstFailure: frozen,
      events: events.slice(),
    };
  }
  function failure(error) {
    var text = String((error && error.stack) || error);
    var detail = {
      kind: /function signature mismatch/.test(text)
        ? "function-signature-mismatch"
        : /out of bounds/i.test(text)
          ? "memory-out-of-bounds"
          : /unreachable/i.test(text)
            ? "unreachable"
            : "runtime-failure",
      // Addresses/function indexes only; never include arbitrary exception text.
      wasmFrames: (
        text.match(
          /(?:\$func\d+|wasm-function\[\d+\]:0x[\da-f]+|kicad_editor\.wasm:0x[\da-f]+)/g
        ) || []
      ).slice(0, 40),
    };
    record("failure", detail);
    if (!frozen)
      frozen = {
        timeMs: Date.now(),
        detail: detail,
        activeCommand: activeCommand,
        coroutines: coroutines(),
        events: events.slice(),
      };
  }
  ["warn", "error"].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      var text = typeof arguments[0] === "string" ? arguments[0] : "";
      if (text.startsWith("[libctx-jspi]")) {
        var id = text.match(/(?:coroutine |id=)(\d+)/);
        record("jspi." + level, {
          coroutine: id ? Number(id[1]) : null,
          rejected: text.includes("REJECTED"),
          refused: text.includes("ghost/refused"),
          reason: text.match(/reason=([a-z-]+)/)?.[1] || null,
        });
        if (text.includes("REJECTED")) failure(text);
      }
      return original.apply(console, arguments);
    };
  });
  addEventListener(
    "keydown",
    function (event) {
      var editable = event.target.closest?.("input,textarea,[contenteditable]");
      var code =
        /^(Escape|Delete|Backspace|Enter|Space|Arrow\w+|Key[MRZYE]|F\d+)$/.test(
          event.code
        )
          ? event.code
          : "other";
      record("input.key", {
        code: editable ? "text-input" : code,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
        alt: event.altKey,
      });
    },
    true
  );
  addEventListener(
    "pointerdown",
    function (event) {
      var control = event.target.closest?.("[data-wx-dom-id]");
      record("input.pointer", {
        button: event.button,
        control: control ? Number(control.dataset.wxDomId) : null,
      });
    },
    true
  );
  window.diodeKicadDiagnostics = {
    record: record,
    failure: failure,
    snapshot: snapshot,
    start: function (type, requestId) {
      activeCommand = {
        type: type,
        requestId: requestId,
        startedMs: Date.now(),
      };
      record("command.start", {
        type: type,
        requestId: requestId,
        coroutines: coroutines(),
      });
    },
    end: function () {
      record("command.end", {
        type: activeCommand?.type,
        requestId: activeCommand?.requestId,
        elapsedMs: Date.now() - (activeCommand?.startedMs || Date.now()),
      });
      activeCommand = null;
    },
  };
  record("frame.boot");
})();
