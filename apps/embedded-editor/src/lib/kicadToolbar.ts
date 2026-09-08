export type KicadToolbarCommand = {
  id: number;
  label: string;
  group: string;
  enabled: boolean;
  checked: boolean;
};

export type KicadToolbarItem =
  | { kind: "separator" }
  | (KicadToolbarCommand & { kind: "command"; tooltip: string; icon?: string })
  | {
      kind: "choice";
      id: number;
      label: string;
      options: string[];
      selected: number;
      enabled: boolean;
    };

export type KicadToolbarState = {
  enabled: boolean;
  commands: KicadToolbarCommand[];
  toolbars: { name: "main" | "aux"; items: KicadToolbarItem[] }[];
};

/** Native menus are the command catalogue; the web shell only chooses presentation. */
export function parseKicadToolbar(value: unknown): KicadToolbarState {
  if (
    !value ||
    typeof value !== "object" ||
    !("menus" in value) ||
    !("enabled" in value) ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.menus)
  )
    throw new Error("Invalid KiCad toolbar state");
  const commands: KicadToolbarCommand[] = [];
  function visit(items: unknown, group: string, enabled: boolean) {
    if (!Array.isArray(items)) throw new Error("Invalid KiCad menu items");
    for (const item of items) {
      if (
        !item ||
        typeof item.label !== "string" ||
        !Number.isInteger(item.id) ||
        typeof item.enabled !== "boolean" ||
        typeof item.checked !== "boolean"
      )
        throw new Error("Invalid KiCad menu item");
      if (item.kind === "separator") continue;
      // The sandbox-bound document cannot be replaced by opening a different
      // file in WASM. Keep exports and other file tools, but leave lifecycle
      // and saving to Registry and the collaboration coordinator.
      if (
        group === "File" &&
        /^(New|Open|Save|Revert|Close|Quit|Exit)\b/.test(item.label)
      )
        continue;
      if (item.kind === "submenu") {
        visit(item.items, `${group} / ${item.label}`, enabled && item.enabled);
      } else {
        commands.push({
          id: item.id,
          label: item.label.trim(),
          group,
          enabled: enabled && item.enabled,
          checked: item.checked,
        });
      }
    }
  }
  for (const menu of value.menus) {
    if (!menu || typeof menu.title !== "string")
      throw new Error("Invalid KiCad menu");
    visit(menu.items, menu.title, value.enabled);
  }
  const toolbars = "toolbars" in value ? value.toolbars : undefined;
  if (!Array.isArray(toolbars)) throw new Error("Invalid KiCad toolbars");
  return {
    enabled: value.enabled,
    commands,
    toolbars: toolbars.map((toolbar) => {
      if (
        !toolbar ||
        !["main", "aux"].includes(toolbar.name) ||
        !Array.isArray(toolbar.items)
      )
        throw new Error("Invalid KiCad toolbar");
      return {
        name: toolbar.name,
        items: toolbar.items
          .map((item: any): KicadToolbarItem => {
            if (item?.kind === "separator") return { kind: "separator" };
            if (
              !item ||
              !["command", "choice"].includes(item.kind) ||
              !Number.isInteger(item.id) ||
              typeof item.enabled !== "boolean"
            )
              throw new Error("Invalid KiCad toolbar item");
            if (item.kind === "command") {
              if (
                typeof item.label !== "string" ||
                typeof item.tooltip !== "string" ||
                typeof item.checked !== "boolean" ||
                (item.icon !== undefined &&
                  (typeof item.icon !== "string" ||
                    (item.icon !== "" &&
                      !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(
                        item.icon
                      ))))
              )
                throw new Error("Invalid KiCad toolbar command");
              return {
                ...item,
                label: (item.label || item.tooltip).trim(),
                group: "Toolbar",
                enabled: value.enabled && item.enabled,
              };
            }
            if (
              typeof item.label !== "string" ||
              !Number.isInteger(item.selected) ||
              !Array.isArray(item.options) ||
              !item.options.every(
                (option: unknown) => typeof option === "string"
              )
            )
              throw new Error("Invalid KiCad toolbar choice");
            return {
              ...item,
              label: item.label.trim(),
              enabled: value.enabled && item.enabled,
            };
          })
          // Registry owns the sandbox document lifecycle. This is the sole
          // intentional exception to KiCad's native TOP_MAIN configuration.
          .filter(
            (item: KicadToolbarItem) =>
              item.kind !== "command" || !/^(New|Open|Save)\b/.test(item.label)
          ),
      };
    }),
  };
}
