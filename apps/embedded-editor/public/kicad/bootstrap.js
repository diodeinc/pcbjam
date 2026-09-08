/* GPL-3.0 harness derived from PCBJam tests/apps/kicad/pcbnew.html. */
// These names are part of the non-modular Emscripten/wx harness contract.
var mainWindow = document.getElementById("main-window");
var statusText = document.getElementById("status");
var progressBar = null;
(function () {
  "use strict";
  var PROTOCOL = "diode-kicad-wasm-v1";
  var query = new URLSearchParams(location.search);
  var session = query.get("session");
  var nonce = query.get("nonce");
  var parentOrigin = location.origin;
  var initialized = false;
  var runtimeReady = false;
  var fatalError = null;
  var applyingRemote = false;
  var currentReadOnly = true;
  var localMode = false;
  var renderLocked = false;
  var commandTail = Promise.resolve();
  var resourceData;
  var status = document.getElementById("status");
  var diagnostics = window.diodeKicadDiagnostics;

  // Include wx chrome, not just TOOL_MANAGER actions, in input exclusion.
  [
    "pointerdown",
    "pointerup",
    "pointermove",
    "mousedown",
    "mouseup",
    "mousemove",
    "click",
    "dblclick",
    "contextmenu",
    "keydown",
    "keyup",
    "wheel",
    "beforeinput",
  ].forEach(function (type) {
    addEventListener(
      type,
      function (event) {
        if (!renderLocked) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (type === "keydown" && !currentReadOnly && !fatalError) {
          try {
            // Native owns configured shortcut matching and queues only history
            // intent until unlock. Never replay DOM input or notify twice.
            requireFunction("kicadCollabQueueHistoryKey")(
              event.code,
              event.ctrlKey,
              event.shiftKey,
              event.altKey,
              event.metaKey
            );
          } catch (error) {
            fail(error);
          }
        }
      },
      { capture: true, passive: false }
    );
  });

  function send(type, payload, requestId) {
    parent.postMessage(
      {
        protocol: PROTOCOL,
        session: session,
        nonce: nonce,
        type: type,
        payload: payload,
        requestId: requestId,
      },
      parentOrigin
    );
  }
  function fail(error, requestId) {
    var message = error instanceof Error ? error.message : String(error);
    var fatal = !requestId || error instanceof WebAssembly.RuntimeError;
    if (fatal) {
      fatalError = message;
      currentReadOnly = true;
    }
    diagnostics.failure(error);
    send("diagnostics", diagnostics.snapshot());
    status.textContent = "Error: " + message;
    status.dataset.error = "true";
    status.style.display = "block";
    send(
      fatal ? "error" : "request-error",
      message,
      fatal ? undefined : requestId
    );
  }
  function safePath(name) {
    if (!name || name[0] === "/" || /(^|[\\/])\.\.([\\/]|$)/.test(name))
      throw new Error("Unsafe project filename");
    return "/home/kicad/documents/" + name.replace(/\\/g, "/");
  }
  function seedConfig() {
    ["9.99", "10.0"].forEach(function (version) {
      var dir = "/home/kicad/.config/kicad/kicad/" + version;
      FS.mkdirTree(dir);
      FS.writeFile(
        dir + "/kicad_common.json",
        JSON.stringify({
          do_not_show_again: {
            update_check_prompt: true,
            data_collection_prompt: true,
          },
        })
      );
      FS.writeFile(
        dir + "/sym-lib-table",
        "(sym_lib_table\n  (version 7)\n)\n"
      );
      FS.writeFile(dir + "/fp-lib-table", "(fp_lib_table\n  (version 7)\n)\n");
      FS.writeFile(
        dir + "/design-block-lib-table",
        "(design_block_lib_table\n  (version 7)\n)\n"
      );
    });
  }
  function createCanvas() {
    var canvas = document.createElement("canvas");
    canvas.id = "canvas";
    canvas.oncontextmenu = function (event) {
      event.preventDefault();
    };
    canvas.addEventListener("webglcontextlost", function (event) {
      event.preventDefault();
      fail("WebGL context lost");
    });
    mainWindow.appendChild(canvas);
    Module.canvas = canvas;
  }
  function installResources() {
    var dependency = "kicad-images";
    addRunDependency(dependency);
    fetch("images.bin", { credentials: "same-origin" })
      .then(function (response) {
        if (!response.ok)
          throw new Error("images.tar.gz HTTP " + response.status);
        return response.arrayBuffer();
      })
      .then(function (buffer) {
        resourceData = new Uint8Array(buffer);
        var path = "/workspace/build-wasm/sysroot/share/kicad/resources";
        FS.mkdirTree(path);
        FS.writeFile(path + "/images.tar.gz", resourceData);
        removeRunDependency(dependency);
      })
      .catch(function (error) {
        fail(error); /* Deliberately retain dependency: fail closed. */
      });
  }
  function waitForRuntime() {
    if (fatalError) return Promise.reject(new Error(fatalError));
    if (runtimeReady) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var started = Date.now();
      (function poll() {
        if (fatalError) return reject(new Error(fatalError));
        if (runtimeReady) return resolve();
        if (Date.now() - started > 120000)
          return reject(new Error("KiCad runtime startup timed out"));
        setTimeout(poll, 50);
      })();
    });
  }
  function requireFunction(name) {
    if (typeof Module[name] !== "function")
      throw new Error("Required WASM API is unavailable: " + name);
    return function () {
      if (fatalError) throw new Error(fatalError);
      return Module[name].apply(Module, arguments);
    };
  }
  async function setReadOnly(value) {
    var setter = requireFunction("kicadSetReadOnly");
    var started = Date.now();
    while ((await Promise.resolve(setter(value))) !== true) {
      if (Date.now() - started > 120000)
        throw new Error("KiCad refused read-only state change");
      await new Promise(function (resolve) {
        setTimeout(resolve, 50);
      });
    }
    currentReadOnly = value;
  }
  async function waitForOpen() {
    var busy = requireFunction("kicadOpenFileBusy");
    var started = Date.now();
    await new Promise(function (resolve) {
      setTimeout(resolve, 50);
    });
    while (busy()) {
      if (Date.now() - started > 300000)
        throw new Error("KiCad board open timed out");
      await new Promise(function (resolve) {
        setTimeout(resolve, 50);
      });
    }
  }
  async function waitForCollab() {
    var busy = requireFunction("kicadCollabBusy");
    var started = Date.now();
    while (await Promise.resolve(busy())) {
      if (fatalError) throw new Error(fatalError);
      if (Date.now() - started > 300000)
        throw new Error("KiCad collaboration operation timed out");
      await new Promise(function (resolve) {
        setTimeout(resolve, 20);
      });
    }
  }
  async function snapshotItems() {
    var snapshotter = requireFunction("kicadCollabSnapshotItems");
    await waitForCollab();
    var snapshot = await Promise.resolve(snapshotter());
    await waitForCollab();
    var parsed = JSON.parse(snapshot);
    if (!parsed || !Array.isArray(parsed.added))
      throw new Error("KiCad returned an invalid item snapshot");
    return snapshot;
  }
  async function openInitialBoard(board) {
    if (
      !board ||
      typeof board.contents !== "string" ||
      !/^[^\\/]+\.kicad_pcb$/i.test(board.filename)
    )
      throw new Error("Invalid KiCad board");
    FS.mkdirTree("/home/kicad/documents");
    Object.entries(board.projectContents || {}).forEach(function (entry) {
      var path = safePath(entry[0]);
      FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
      FS.writeFile(path, entry[1]);
    });
    var boardPath = safePath(board.filename);
    FS.writeFile(boardPath, board.contents);
    // Lock before exposing document contents. Missing/failed lock never opens a private board.
    await setReadOnly(true);
    var opened = await Promise.resolve(
      requireFunction("kicadOpenFile")(boardPath)
    );
    if (opened === false) throw new Error("KiCad refused to open the board");
    await waitForOpen();
    await setReadOnly(true);
  }
  async function initialize(payload) {
    if (initialized) throw new Error("KiCad frame is already initialized");
    initialized = true;
    localMode = payload.local === true;
    await waitForRuntime();
    window.kicadCollab = {
      onFatal: fail,
      onChanged: function () {
        if (!applyingRemote && !currentReadOnly) send("changed");
      },
      onHistory: function (direction) {
        diagnostics.record("native.history", {
          direction: direction,
          readOnly: currentReadOnly,
        });
        if (!currentReadOnly) send("history", direction);
      },
    };
    await openInitialBoard(payload.board);
    // Registers/baselines the native listener only after the open guard clears.
    var lockStarted = Date.now();
    while (!requireFunction("kicadCollabTryLock")()) {
      if (Date.now() - lockStarted > 300000)
        throw new Error("KiCad initial collaboration lock timed out");
      await new Promise(function (resolve) {
        setTimeout(resolve, 50);
      });
    }
    renderLocked = true;
    try {
      await waitForCollab();
      // Enabling host history disposes native undo pointers, so it needs the
      // same exclusion as snapshots and applies, even during initialization.
      if (!requireFunction("kicadCollabSetHistoryMode")(!localMode))
        throw new Error("KiCad collaboration history could not be enabled");
      await snapshotItems();
    } finally {
      requireFunction("kicadCollabUnlock")();
      renderLocked = false;
    }
    document.getElementById("canvas").style.display = "block";
    if (!requireFunction("kicadUseWebToolbar")())
      throw new Error("KiCad web toolbar could not be enabled");
    await waitForCollab();
    status.style.display = "none";
    diagnostics.record("frame.ready");
    send("ready");
  }
  async function command(type, payload) {
    await waitForRuntime();
    if (!initialized && type !== "set-read-only")
      throw new Error("KiCad frame is not initialized");
    if (type === "save-board") {
      if (!localMode || !renderLocked) throw new Error("Local save requires a native lock");
      var output = "/home/kicad/documents/pcbjam-export.kicad_pcb";
      if (FS.analyzePath(output).exists) FS.unlink(output);
      await Promise.resolve(requireFunction("kicadSaveBoard")(output));
      var contents = FS.readFile(output, { encoding: "utf8" });
      if (!contents.trim()) throw new Error("KiCad produced an empty board");
      return contents;
    }
    if (type === "toolbar-state") {
      if (renderLocked) return null;
      return JSON.parse(requireFunction("kicadWebToolbarState")());
    }
    if (type === "toolbar-command" || type === "toolbar-choice") {
      if (
        !payload ||
        !Number.isInteger(payload.id) ||
        (type === "toolbar-choice" && !Number.isInteger(payload.selected))
      )
        throw new Error("Invalid KiCad toolbar command");
      if (renderLocked || currentReadOnly) return false;
      var accepted =
        type === "toolbar-choice"
          ? requireFunction("kicadWebToolbarChoice")(
              payload.id,
              payload.selected
            )
          : requireFunction("kicadWebToolbarCommand")(payload.id);
      if (accepted) window.focus();
      return accepted;
    }
    if (type === "capture-items") {
      // Routine polling must not keep input excluded across parent-frame RPCs
      // or the parent's snapshot diff/Yjs work. Keep the native lock mandatory,
      // but release it here before the captured snapshot leaves this frame.
      if (renderLocked || !requireFunction("kicadCollabTryLock")()) return null;
      renderLocked = true;
      try {
        return await snapshotItems();
      } finally {
        await waitForCollab();
        requireFunction("kicadCollabUnlock")();
        renderLocked = false;
      }
    }
    if (type === "try-lock") {
      var acquired = requireFunction("kicadCollabTryLock")();
      if (acquired) renderLocked = true;
      return acquired;
    }
    if (type === "unlock") {
      await waitForCollab();
      requireFunction("kicadCollabUnlock")();
      renderLocked = false;
      return;
    }
    if (type === "set-read-only")
      return setReadOnly(!payload || payload.readOnly !== false);
    if (type === "set-history-state")
      return requireFunction("kicadCollabSetHistoryState")(
        Boolean(payload.canUndo),
        Boolean(payload.canRedo)
      );
    if (type === "snapshot-items") {
      return snapshotItems();
    }
    if (type === "snapshot-state") {
      if (!payload || typeof payload.delta !== "string")
        throw new Error("Invalid KiCad item delta");
      await waitForCollab();
      var state = JSON.parse(
        await Promise.resolve(
          requireFunction("kicadCollabSnapshotState")(payload.delta)
        )
      );
      if (
        typeof state.committed !== "string" ||
        typeof state.working !== "string"
      )
        throw new Error("KiCad returned an invalid working-state snapshot");
      return state;
    }
    if (type === "prepare-items") {
      if (!payload || typeof payload.delta !== "string")
        throw new Error("Invalid KiCad item delta");
      requireFunction("kicadCollabPrepareItems")(payload.delta);
      await waitForCollab();
      return;
    }
    if (type === "apply-items") {
      if (!payload || typeof payload.delta !== "string")
        throw new Error("Invalid KiCad item delta");
      applyingRemote = true;
      try {
        var result = await Promise.resolve(
          requireFunction("kicadCollabApplyItems")(payload.delta)
        );
        await waitForCollab();
        return result;
      } finally {
        setTimeout(function () {
          applyingRemote = false;
        }, 0);
      }
    }
    throw new Error("Unknown KiCad command");
  }
  addEventListener("message", function (event) {
    var message = event.data;
    if (
      event.source !== parent ||
      event.origin !== parentOrigin ||
      !message ||
      message.protocol !== PROTOCOL ||
      message.session !== session ||
      message.nonce !== nonce
    )
      return;
    diagnostics.record("command.queued", {
      type: message.type,
      requestId: message.requestId,
    });
    if (message.type === "init") {
      commandTail = commandTail
        .then(function () {
          diagnostics.start("init");
          return initialize(message.payload || {});
        })
        .then(function () {
          diagnostics.end();
        })
        .catch(function (error) {
          fail(error);
        });
      return;
    }
    commandTail = commandTail
      .then(function () {
        diagnostics.start(message.type, message.requestId);
        return command(message.type, message.payload);
      })
      .then(
        function (result) {
          diagnostics.end();
          send("response", result, message.requestId);
        },
        function (error) {
          fail(error, message.requestId);
        }
      );
  });
  window.Module = {
    thisProgram: "/usr/bin/pcbnew",
    arguments: ["--frame=pcb"],
    preRun: [
      createCanvas,
      installResources,
      seedConfig,
      function () {
        addRunDependency("registry-fonts");
        window.diodeKicadTheme
          .loadFonts()
          .then(function () {
            removeRunDependency("registry-fonts");
          })
          .catch(fail);
      },
      function () {
        FS.mkdirTree("/home/kicad");
        FS.chdir("/home/kicad");
      },
    ],
    locateFile: function (path) {
      return path;
    },
    print: function () {
      console.log.apply(console, ["[KICAD]"].concat(Array.from(arguments)));
    },
    printErr: function () {
      console.error.apply(console, ["[KICAD]"].concat(Array.from(arguments)));
    },
    setStatus: function (text) {
      if (text) status.textContent = text;
    },
    onRuntimeInitialized: function () {
      window.diodeKicadTheme.apply();
      runtimeReady = true;
    },
  };
  // Install before main() starts so startup coroutine failures also fail closed.
  window.kicadCollab = { onFatal: fail };
  window.onerror = function (message, source, line, column, error) {
    console.error("[KICAD]", (error && error.stack) || message);
    fail(message);
    return false;
  };
  window.onunhandledrejection = function (event) {
    fail(event.reason);
  };
})();
