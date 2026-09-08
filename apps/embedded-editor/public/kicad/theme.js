// The native frame consumes only its own PCBJam application's local tokens.
// The application receives light/dark via the authenticated outer protocol;
// neither this harness nor diagnostics accesses the embedding host's DOM.
(function () {
  "use strict";
  var host = parent.document.documentElement;
  var root = document.documentElement;
  var palette = {
    paper: "--paper-bg",
    surface: "--paper-surface",
    hover: "--hover-surface",
    line: "--line",
    ink: "--ink",
    muted: "--muted-ink",
    accent: "--diode-green",
    accentInk: "--diode-green-foreground",
  };
  var theme;

  function readTheme() {
    var computed = parent.getComputedStyle(host);
    theme = {};
    Object.entries(palette).forEach(function (entry) {
      theme[entry[0]] = computed.getPropertyValue(entry[1]).trim();
    });
    Object.values(palette)
      .concat([
        "--line-strong",
        "--diode-green-surface",
        "--danger-ink",
        "--radius-control",
        "--font-chrome-stack",
        "--data-table-cell-font-size",
      ])
      .forEach(function (token) {
        root.style.setProperty(token, computed.getPropertyValue(token));
      });
    theme.font = computed
      .getPropertyValue("--font-chrome-stack")
      .split(",")[0]
      .trim()
      .replace(/^["']|["']$/g, "");
    theme.pixelSize = parseFloat(
      computed.getPropertyValue("--data-table-cell-font-size")
    );
    theme.dark = computed.colorScheme === "dark";
    root.style.colorScheme = theme.dark ? "dark" : "light";
    root.dataset.theme = theme.dark ? "dark" : "light";
  }

  readTheme();

  // Copy only the chrome font faces, resolving URLs relative to their source
  // stylesheet. Loading before wx measures widgets keeps native/DOM geometry equal.
  var fonts = document.createElement("style");
  fonts.id = "pcbjam-chrome-fonts";
  Array.from(parent.document.styleSheets).forEach(function (sheet) {
    var rules;
    try {
      rules = sheet.cssRules;
    } catch (_) {
      return;
    }
    Array.from(rules).forEach(function (rule) {
      if (
        rule.type !== CSSRule.FONT_FACE_RULE ||
        rule.style.fontFamily.replace(/["']/g, "") !== theme.font
      )
        return;
      fonts.textContent +=
        rule.cssText.replace(/url\(["']?([^"')]+)["']?\)/g, function (_, url) {
          return (
            'url("' +
            new URL(url, sheet.href || parent.location.href).href +
            '")'
          );
        }) + "\n";
    });
  });
  document.head.appendChild(fonts);

  window.diodeKicadTheme = {
    loadFonts: function () {
      return document.fonts.load(theme.pixelSize + 'px "' + theme.font + '"');
    },
    apply: function () {
      readTheme();
      if (!Module.kicadSetChromeTheme(JSON.stringify(theme)))
        throw new Error("KiCad refused PCBJam chrome tokens");
    },
  };

  var observer = new MutationObserver(function () {
    readTheme();
    if (window.Module && typeof Module.kicadSetChromeTheme === "function")
      window.diodeKicadTheme.apply();
  });
  observer.observe(host, {
    attributes: true,
    attributeFilter: ["data-theme", "class", "style"],
  });

  // Keep wx's native geometry authoritative: CSS transforms would move only
  // the pixels, breaking hit testing for canvas-drawn controls. Center through
  // the same exported Move/SetSize path used by wx's desktop drag handles.
  var dialogObserver;
  var layoutFrame;
  var fitted = new WeakMap();
  function layoutDialogs() {
    layoutFrame = null;
    var visible = false;
    document.querySelectorAll(".window.toplevel").forEach(function (dialog) {
      var title = dialog.querySelector(".window-titlebar-text");
      var rect = dialog.getBoundingClientRect();
      if (!title || !rect.width || !rect.height) return;
      visible = true;
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-label", title.textContent);
      var close = dialog.querySelector(".window-titlebar-close");
      if (close) close.setAttribute("aria-label", "Close " + title.textContent);
      var width = Math.min(rect.width, Math.max(1, innerWidth - 32));
      var height = Math.min(rect.height, Math.max(1, innerHeight - 32));
      var x = Math.max(16, Math.round((innerWidth - width) / 2));
      var y = Math.max(16, Math.round((innerHeight - height) / 2));
      var requested = [x, y, width, height].join(",");
      if (fitted.get(dialog) === requested) return;
      fitted.set(dialog, requested);
      var id = Number(dialog.id.replace("window-", ""));
      if (width !== rect.width || height !== rect.height)
        Module.ccall(
          "wx_window_resize",
          null,
          ["number", "number", "number", "number", "number"],
          [id, x, y, width, height]
        );
      else if (x !== rect.x || y !== rect.y)
        Module.ccall(
          "wx_window_move",
          null,
          ["number", "number", "number"],
          [id, x, y]
        );
    });
    root.toggleAttribute("data-dialog-open", visible);
  }
  function scheduleDialogLayout() {
    if (layoutFrame == null) layoutFrame = requestAnimationFrame(layoutDialogs);
  }
  function stopDialogDrag(event) {
    if (
      event.target.closest(".window-titlebar") &&
      !event.target.closest(".window-titlebar-close")
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }
  document.addEventListener("pointerdown", stopDialogDrag, true);
  document.addEventListener("DOMContentLoaded", function () {
    dialogObserver = new MutationObserver(scheduleDialogLayout);
    dialogObserver.observe(document.getElementById("window-container"), {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
    });
    scheduleDialogLayout();
  });
  addEventListener("resize", function () {
    fitted = new WeakMap();
    scheduleDialogLayout();
  });
  addEventListener("pagehide", function () {
    observer.disconnect();
    if (dialogObserver) dialogObserver.disconnect();
    if (layoutFrame != null) cancelAnimationFrame(layoutFrame);
  });
})();
