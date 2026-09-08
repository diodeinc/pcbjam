import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const script = readFileSync(
  new URL("../../public/kicad/theme.js", import.meta.url),
  "utf8"
);

function setup(mode: "light" | "dark" = "light") {
  const listeners: Record<string, (event?: unknown) => void> = {};
  let layout: () => void = () => {};
  const rect = { x: -100, y: 900, width: 600, height: 400 };
  const close = { setAttribute: vi.fn() };
  const dialog = {
    id: "window-7",
    querySelector: (selector: string) =>
      selector.endsWith("-text") ? { textContent: "Board Setup" } : close,
    getBoundingClientRect: () => rect,
    setAttribute: vi.fn(),
  };
  const root = {
    style: { setProperty: vi.fn() },
    dataset: {},
    toggleAttribute: vi.fn(),
  };
  const ccall = vi.fn();
  const kicadSetChromeTheme = vi.fn((_theme: string) => true);
  const context = {
    // The native iframe's parent is the standalone PCBJam app, not Registry.
    // Its local palette is selected by the explicit light/dark host message.
    parent: {
      get parent(): never { throw new Error("Embedding host DOM is off limits"); },
      document: { documentElement: {}, styleSheets: [] },
      getComputedStyle: () => ({
        getPropertyValue: (token: string) => token === "--font-chrome-stack"
          ? '"Arial", sans-serif'
          : token === "--data-table-cell-font-size" ? "12px"
          : mode === "dark" ? "#112233" : "#fefefe",
        colorScheme: mode,
      }),
    },
    document: {
      documentElement: root,
      createElement: () => ({}),
      head: { appendChild: vi.fn() },
      querySelectorAll: () => [dialog],
      getElementById: () => ({}),
      addEventListener: (name: string, fn: (event?: unknown) => void) => {
        listeners[name] = fn;
      },
    },
    window: {} as { diodeKicadTheme: { apply: () => void } },
    Module: { ccall, kicadSetChromeTheme },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame: (fn: () => void) => {
      layout = fn;
      return 1;
    },
    cancelAnimationFrame: vi.fn(),
    addEventListener: (name: string, fn: () => void) => {
      listeners[name] = fn;
    },
    innerWidth: 1000,
    innerHeight: 800,
  };
  runInNewContext(script, context);
  listeners.DOMContentLoaded();
  return {
    context,
    listeners,
    rect,
    close,
    dialog,
    root,
    ccall,
    layout: () => layout(),
  };
}

describe("KiCad dialog chrome", () => {
  it.each(["light", "dark"] as const)("applies the standalone app's explicit %s palette without consulting the embedding host", (mode) => {
    const env = setup(mode);
    env.context.window.diodeKicadTheme.apply();
    expect(JSON.parse(env.context.Module.kicadSetChromeTheme.mock.calls[0][0])).toMatchObject({
      dark: mode === "dark",
      paper: mode === "dark" ? "#112233" : "#fefefe",
      font: "Arial",
      pixelSize: 12,
    });
    expect(env.root.dataset).toEqual({ theme: mode });
    expect(env.root.style.setProperty).toHaveBeenCalledWith("--paper-bg", mode === "dark" ? "#112233" : "#fefefe");
  });

  it("centers through native geometry, labels dialogs and avoids repeated native calls", () => {
    const env = setup();
    env.layout();
    expect(env.ccall).toHaveBeenCalledWith(
      "wx_window_move",
      null,
      ["number", "number", "number"],
      [7, 200, 200]
    );
    expect(env.dialog.setAttribute).toHaveBeenCalledWith(
      "aria-label",
      "Board Setup"
    );
    expect(env.close.setAttribute).toHaveBeenCalledWith(
      "aria-label",
      "Close Board Setup"
    );
    expect(env.root.toggleAttribute).toHaveBeenCalledWith(
      "data-dialog-open",
      true
    );
    env.layout();
    expect(env.ccall).toHaveBeenCalledTimes(1);
  });

  it("fits oversized dialogs through native resize after viewport changes", () => {
    const env = setup();
    env.layout();
    env.context.innerWidth = 500;
    env.context.innerHeight = 300;
    env.listeners.resize();
    env.layout();
    expect(env.ccall).toHaveBeenLastCalledWith(
      "wx_window_resize",
      null,
      ["number", "number", "number", "number", "number"],
      [7, 16, 16, 468, 268]
    );
  });

  it("blocks titlebar dragging but preserves close-button events", () => {
    const env = setup();
    const event = {
      target: {
        closest: (selector: string): boolean => selector === ".window-titlebar",
      },
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    env.listeners.pointerdown(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    event.target.closest = () => true;
    env.listeners.pointerdown(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("does not hide wx dialog drawing canvases", () => {
    const css = readFileSync(
      new URL("../../public/kicad/theme.css", import.meta.url),
      "utf8"
    );
    expect(css).toMatch(/#canvas\s*\{\s*display: none/);
    expect(css).toMatch(/\.window-canvas\s*\{\s*display: block/);
    expect(css).not.toMatch(/(?:^|\n)canvas\s*\{/);
  });
});
