import { useState } from "react";
import type { KicadToolbarCommand, KicadToolbarState } from "../lib/kicadToolbar";
export function KicadToolbar({state, onCommand, onChoice, error}: {
  state: KicadToolbarState | null; error: string | null;
  onCommand: (command: KicadToolbarCommand) => void;
  onChoice: (id: number, selected: number) => void;
}) {
  const [search, setSearch] = useState("");
  return <div className="toolbar" role="group" aria-label="KiCad board controls">
    {state?.toolbars.map(bar => <div className="toolbar-row" key={bar.name} aria-label={`KiCad ${bar.name} toolbar`}>
      {bar.items.map((item, i) => item.kind === "separator" ? <span key={i} className="separator" /> : item.kind === "command" ?
        <button key={i} disabled={!item.enabled} aria-pressed={item.checked} title={item.tooltip || item.label} aria-label={item.tooltip || item.label} onClick={() => onCommand(item)}>
          {item.icon ? <img src={item.icon} alt="" width="20" height="20" /> : item.label}
        </button> : <select key={i} aria-label={item.label || item.options[0] || "Board setting"} disabled={!item.enabled} value={item.selected} onChange={e => onChoice(item.id, Number(e.target.value))}>
          {item.options.map((option, index) => <option value={index} key={index} disabled={option === "---"}>{option}</option>)}
        </select>)}
    </div>)}
    {state && <details><summary>Commands</summary><input aria-label="Find a board command" placeholder="Find a board command…" value={search} onChange={e => setSearch(e.target.value)} />
      <div className="command-list">{state.commands.filter(c => `${c.label} ${c.group}`.toLowerCase().includes(search.toLowerCase())).map(c => <button key={c.id} disabled={!c.enabled} onClick={() => onCommand(c)}>{c.checked ? "✓ " : ""}{c.label} <small>{c.group}</small></button>)}</div>
    </details>}
    {error && <div role="alert">{error}</div>}
  </div>;
}
