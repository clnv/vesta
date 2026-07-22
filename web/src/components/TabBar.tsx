import { CopyPlus, Plus, X } from "lucide-react";
import { useState } from "react";
import type { ExplorerTab } from "../types";

interface Props {
  tabs: ExplorerTab[];
  activeId: string;
  onSelect(id: string): void;
  onAdd(): void;
  onDuplicate(id: string): void;
  onClose(id: string): void;
  onRename(id: string, title: string): void;
}

export function TabBar({ tabs, activeId, onSelect, onAdd, onDuplicate, onClose, onRename }: Props) {
  const [renaming, setRenaming] = useState<string | null>(null);
  return (
    <nav className="tabbar" aria-label="Query tabs">
      <div className="tabs-scroll">
        {tabs.map((tab) => (
          <div className={`query-tab ${tab.id === activeId ? "active" : ""}`} key={tab.id}>
            <button className="tab-main" onClick={() => onSelect(tab.id)} onDoubleClick={() => setRenaming(tab.id)}>
              <span className={`status-dot ${tab.status}`} />
              {renaming === tab.id ? (
                <input
                  autoFocus
                  defaultValue={tab.title}
                  onClick={(event) => event.stopPropagation()}
                  onBlur={(event) => { onRename(tab.id, event.target.value.trim() || "Untitled query"); setRenaming(null); }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") setRenaming(null);
                  }}
                />
              ) : <span>{tab.title}</span>}
              {tab.query !== tab.lastExecutedQuery && tab.lastExecutedQuery && <i title="Query changed since last run" />}
            </button>
            <button className="tab-action" aria-label={`Duplicate ${tab.title}`} onClick={() => onDuplicate(tab.id)}><CopyPlus size={13} /></button>
            <button className="tab-action" aria-label={`Close ${tab.title}`} onClick={() => onClose(tab.id)}><X size={14} /></button>
          </div>
        ))}
      </div>
      <button className="add-tab" aria-label="New query tab" onClick={onAdd}><Plus size={16} /></button>
    </nav>
  );
}

