import { expect, it } from "vitest";
import { parseKicadToolbar } from "./kicadToolbar";

const leaf = {
  id: 1,
  label: "Grid",
  kind: "check",
  checked: true,
  enabled: true,
};

it("retains native command IDs and checked states, including disabled ancestors", () => {
  const state = parseKicadToolbar({
    enabled: true,
    toolbars: [],
    menus: [
      {
        title: "View",
        items: [
          leaf,
          {
            ...leaf,
            id: 2,
            label: "Units",
            kind: "submenu",
            enabled: false,
            items: [{ ...leaf, id: 3, label: "Millimeters" }],
          },
        ],
      },
    ],
  });
  expect(state.commands).toEqual([
    { id: 1, label: "Grid", group: "View", checked: true, enabled: true },
    {
      id: 3,
      label: "Millimeters",
      group: "View / Units",
      checked: true,
      enabled: false,
    },
  ]);
});

it("keeps document lifecycle in Registry and disables commands when the editor is unavailable", () => {
  expect(
    parseKicadToolbar({
      enabled: false,
      toolbars: [],
      menus: [
        { title: "File", items: [{ ...leaf, label: "Open" }] },
        { title: "Edit", items: [{ ...leaf, label: "Undo" }] },
      ],
    }).commands
  ).toEqual([
    { id: 1, label: "Undo", group: "Edit", checked: true, enabled: false },
  ]);
});

it("rejects malformed native state", () => {
  expect(() => parseKicadToolbar(null)).toThrow();
  expect(() =>
    parseKicadToolbar({
      enabled: true,
      toolbars: [],
      menus: [{ title: "Edit", items: [{ ...leaf, id: "1" }] }],
    })
  ).toThrow();
});

it("normalizes native dynamic labels for quick-action matching", () => {
  const state = parseKicadToolbar({
    enabled: true,
    toolbars: [],
    menus: [{ title: "Edit", items: [{ ...leaf, label: "Undo " }] }],
  });
  expect(state.commands[0]).toMatchObject({ label: "Undo", enabled: true });
});

it("requires native toolbar arrays instead of accepting menu-only state", () => {
  for (const toolbars of [undefined, null, {}, "main"])
    expect(() =>
      parseKicadToolbar({ enabled: true, menus: [], toolbars })
    ).toThrow("Invalid KiCad toolbars");
  expect(() => parseKicadToolbar({ enabled: true, menus: [] })).toThrow(
    "Invalid KiCad toolbars"
  );
});

it("validates choice labels before normalization", () => {
  for (const label of [undefined, null, 1, {}, []])
    expect(() =>
      parseKicadToolbar({
        enabled: true,
        menus: [],
        toolbars: [
          {
            name: "aux",
            items: [
              {
                kind: "choice",
                id: 1,
                enabled: true,
                selected: 0,
                options: ["Track"],
                label,
              },
            ],
          },
        ],
      })
    ).toThrow("Invalid KiCad toolbar choice");
});

it("preserves native toolbar order, separators, command state, and every choice", () => {
  const state = parseKicadToolbar({
    enabled: true,
    menus: [],
    toolbars: [
      {
        name: "main",
        items: [
          {
            kind: "command",
            id: 1,
            label: "",
            tooltip: "Board Setup",
            checked: false,
            enabled: true,
          },
          { kind: "separator" },
        ],
      },
      {
        name: "aux",
        items: [
          {
            kind: "choice",
            id: 10,
            label: "",
            selected: 2,
            enabled: true,
            options: ["Track: use netclass width", "---", "Track: 0.2 mm"],
          },
          { kind: "separator" },
          {
            kind: "choice",
            id: 11,
            label: "",
            selected: 0,
            enabled: false,
            options: ["Zoom 1.00", "Zoom 2.00"],
          },
        ],
      },
    ],
  });
  expect(state.toolbars[0].items).toEqual([
    {
      kind: "command",
      id: 1,
      label: "Board Setup",
      tooltip: "Board Setup",
      group: "Toolbar",
      checked: false,
      enabled: true,
    },
    { kind: "separator" },
  ]);
  expect(state.toolbars[1].items).toHaveLength(3);
  expect(state.toolbars[1].items[0]).toMatchObject({ id: 10, selected: 2 });
  expect(state.toolbars[1].items[2]).toMatchObject({ id: 11, enabled: false });
});

it("excludes only Registry-owned New/Open/Save toolbar commands", () => {
  const command = (label: string, id: number) => ({
    kind: "command",
    id,
    label,
    tooltip: label,
    checked: false,
    enabled: true,
  });
  const state = parseKicadToolbar({
    enabled: true,
    menus: [],
    toolbars: [
      {
        name: "main",
        items: [
          command("Save", 1),
          command("Route Tracks", 2),
          command("Board Setup", 3),
        ],
      },
    ],
  });
  expect(
    state.toolbars[0].items.map((item) => ("id" in item ? item.id : null))
  ).toEqual([2, 3]);
});

it("preserves native PNG icons and rejects external image sources", () => {
  const state = (icon: string) => ({
    enabled: true,
    menus: [],
    toolbars: [
      {
        name: "main",
        items: [
          {
            kind: "command",
            id: 1,
            label: "Zoom In",
            tooltip: "Zoom In",
            checked: false,
            enabled: true,
            icon,
          },
        ],
      },
    ],
  });
  const icon = "data:image/png;base64,aGVsbG8=";
  expect(parseKicadToolbar(state(icon)).toolbars[0].items[0]).toMatchObject({
    icon,
  });
  expect(() =>
    parseKicadToolbar(state("https://example.com/icon.png"))
  ).toThrow();
});
