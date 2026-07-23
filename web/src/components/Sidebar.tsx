import { Ban, Check, Clock3, Database, Eraser, Folder, ListFilter, Plus, RefreshCw, Search, UsersRound } from "lucide-react";
import { useMemo, useState } from "react";
import type { FieldValue, HistoryEntry, TeamLibrary, TeamQuery } from "../types";

interface Props {
  mode: "fields" | "history" | "shared";
  onMode(mode: "fields" | "history" | "shared"): void;
  fields: FieldValue[];
  values: FieldValue[];
  selectedField?: string;
  loading: boolean;
  history: HistoryEntry[];
  teamLibraries: TeamLibrary[];
  canInspect: boolean;
  onRefresh(): void;
  onField(field: string): void;
  onInsert(field: string, value: string, exclude: boolean): void;
  onRecall(entry: HistoryEntry): void;
  onRecallTeamQuery(entry: TeamQuery): void;
  onCreateFolder(teamId: string): void;
  onClearHistory(): void;
}

export function Sidebar(props: Props) {
  const [search, setSearch] = useState("");
  const items = props.selectedField ? props.values : props.fields;
  const filtered = useMemo(() => items.filter((item) => item.value.toLowerCase().includes(search.toLowerCase())), [items, search]);
  return (
    <aside className="sidebar">
      <div className="sidebar-switcher" role="tablist" aria-label="Explorer sidebar">
        <button className={props.mode === "fields" ? "active" : ""} onClick={() => props.onMode("fields")}><ListFilter size={15} /> Fields</button>
        <button className={props.mode === "history" ? "active" : ""} onClick={() => props.onMode("history")}><Clock3 size={15} /> History</button>
        <button className={props.mode === "shared" ? "active" : ""} onClick={() => props.onMode("shared")}><UsersRound size={15} /> Shared</button>
      </div>
      {props.mode === "fields" ? (
        <>
          <div className="sidebar-title-row">
            <div>
              <span className="eyebrow">QUERY SCOPE</span>
              <h2>{props.selectedField || "Fields"}</h2>
            </div>
            <button className="icon-button" aria-label="Refresh fields" disabled={!props.canInspect || props.loading} onClick={props.onRefresh}><RefreshCw size={15} className={props.loading ? "spin" : ""} /></button>
          </div>
          <label className="sidebar-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find fields or values" /></label>
          {!props.canInspect && <div className="sidebar-note"><Database size={17} /> Add an explicit <code>_time:</code> filter to inspect fields.</div>}
          {props.selectedField && <button className="back-link" onClick={() => props.onField("")}>← All fields</button>}
          <div className="sidebar-list">
            {filtered.map((item) => props.selectedField ? (
              <div className="value-item" key={item.value}>
                <button className="value-main" onClick={() => props.onInsert(props.selectedField!, item.value, false)} title="Add include filter">
                  <span>{item.value || "(empty)"}</span><small>{item.hits.toLocaleString()}</small>
                </button>
                <button className="mini-action include" onClick={() => props.onInsert(props.selectedField!, item.value, false)} aria-label={`Include ${item.value}`}><Check size={13} /></button>
                <button className="mini-action exclude" onClick={() => props.onInsert(props.selectedField!, item.value, true)} aria-label={`Exclude ${item.value}`}><Ban size={13} /></button>
              </div>
            ) : (
              <button className="field-item" key={item.value} onClick={() => props.onField(item.value)}><span>{item.value}</span><small>{item.hits.toLocaleString()}</small></button>
            ))}
          </div>
        </>
      ) : props.mode === "history" ? (
        <>
          <div className="sidebar-title-row">
            <div><span className="eyebrow">LOCAL ONLY</span><h2>Query history</h2></div>
            <button className="icon-button" aria-label="Clear history" disabled={props.history.length === 0} onClick={props.onClearHistory}><Eraser size={15} /></button>
          </div>
          <div className="history-list">
            {props.history.length === 0 && <div className="sidebar-note"><Clock3 size={17} /> Executed query text will appear here. Result rows are never stored.</div>}
            {props.history.map((entry) => (
              <button className="history-item" key={entry.id} onClick={() => props.onRecall(entry)}>
                <code>{entry.query}</code>
                <span>{new Date(entry.executedAt).toLocaleString()} · {entry.status}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="sidebar-title-row">
            <div><span className="eyebrow">SQLITE LIBRARY</span><h2>Team queries</h2></div>
          </div>
          <div className="team-library-list">
            {props.teamLibraries.length === 0 && <div className="sidebar-note"><UsersRound size={17} /> Join a team to save and browse shared queries.</div>}
            {props.teamLibraries.map((library) => (
              <section className="team-library" key={library.team.id}>
                <header><strong>{library.team.name}</strong><button aria-label={`Create folder in ${library.team.name}`} onClick={() => props.onCreateFolder(library.team.id)}><Plus size={13} /></button></header>
                {library.queries.map((item) => <TeamQueryButton item={item} onRecall={props.onRecallTeamQuery} key={item.id} />)}
                {library.folders.map((folder) => (
                  <div className="team-folder" key={folder.id}>
                    <span><Folder size={12} /> {folder.name}</span>
                    {folder.queries.length === 0 && <small>Empty folder</small>}
                    {folder.queries.map((item) => <TeamQueryButton item={item} onRecall={props.onRecallTeamQuery} key={item.id} />)}
                  </div>
                ))}
              </section>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}

function TeamQueryButton({ item, onRecall }: { item: TeamQuery; onRecall(item: TeamQuery): void }) {
  return (
    <button className="team-query-item" onClick={() => onRecall(item)}>
      <strong>{item.title}</strong>
      <code>{item.query}</code>
    </button>
  );
}
