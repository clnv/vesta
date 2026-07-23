import { Check, Clock3, Eraser, Folder, Pencil, Plus, Star, X } from "lucide-react";
import { useState } from "react";
import type { HistoryEntry, TeamFolder, TeamLibrary, TeamQuery } from "../types";

interface Props {
  mode: "history" | "stars";
  onMode(mode: "history" | "stars"): void;
  history: HistoryEntry[];
  teamLibraries: TeamLibrary[];
  onRecall(entry: HistoryEntry): void;
  onOpenTeamStar(entry: TeamQuery): void;
  onEditTeamStar(entry: TeamQuery, title: string, folderId: string): Promise<boolean>;
  onCreateFolder(teamId: string): void;
  onClearHistory(): void;
}

export function Sidebar(props: Props) {
  const starCount = props.teamLibraries.reduce(
    (total, library) => total + library.queries.length + library.folders.reduce((folderTotal, folder) => folderTotal + folder.queries.length, 0),
    0,
  );

  return (
    <aside className="sidebar" aria-label="Query explorer">
      <div className="sidebar-switcher" role="group" aria-label="Explorer sidebar">
        <button
          className={props.mode === "history" ? "active" : ""}
          aria-pressed={props.mode === "history"}
          aria-controls="sidebar-history"
          onClick={() => props.onMode("history")}
        >
          <Clock3 size={17} /> History
        </button>
        <button
          className={props.mode === "stars" ? "active" : ""}
          aria-pressed={props.mode === "stars"}
          aria-controls="sidebar-stars"
          onClick={() => props.onMode("stars")}
        >
          <Star size={17} /> Stars
        </button>
      </div>
      {props.mode === "history" ? (
        <section className="sidebar-panel" id="sidebar-history">
          <div className="sidebar-title-row">
            <div className="sidebar-heading">
              <span className="eyebrow">LOCAL ONLY</span>
              <div className="sidebar-heading-line">
                <h2>Query history</h2>
                <span className="sidebar-count" aria-label={`${props.history.length} saved queries`}>{props.history.length}</span>
              </div>
              <p>Reopen a recent query in the active tab.</p>
            </div>
            <button className="icon-button sidebar-title-action" title="Clear query history" aria-label="Clear history" disabled={props.history.length === 0} onClick={props.onClearHistory}><Eraser size={17} /></button>
          </div>
          <div className="history-list">
            {props.history.length === 0 && <div className="sidebar-note"><Clock3 size={20} /><span><strong>No query history yet</strong>Executed query text will appear here. Result rows are never stored.</span></div>}
            {props.history.map((entry) => (
              <button className="history-item" key={entry.id} onClick={() => props.onRecall(entry)}>
                <code>{entry.query}</code>
                <span className="history-meta">
                  <time dateTime={new Date(entry.executedAt).toISOString()}>{formatHistoryTime(entry.executedAt)}</time>
                  <span className={`history-status ${entry.status}`}><i />{entry.status}</span>
                  {entry.elapsedMs !== undefined && <span>{formatElapsedTime(entry.elapsedMs)}</span>}
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : (
        <section className="sidebar-panel" id="sidebar-stars">
          <div className="sidebar-title-row">
            <div className="sidebar-heading">
              <span className="eyebrow">TEAM LIBRARY</span>
              <div className="sidebar-heading-line">
                <h2>Team stars</h2>
                <span className="sidebar-count" aria-label={`${starCount} starred queries`}>{starCount}</span>
              </div>
              <p>Open, rename, and organize shared queries.</p>
            </div>
          </div>
          <div className="team-library-list">
            {props.teamLibraries.length === 0 && <div className="sidebar-note"><Star size={20} /><span><strong>No team stars yet</strong>Join a team to star and reuse queries.</span></div>}
            {props.teamLibraries.map((library) => (
              <section className="team-library" key={library.team.id}>
                <header>
                  <span className="team-identity"><i aria-hidden="true">{library.team.name.slice(0, 1).toUpperCase()}</i><strong>{library.team.name}</strong></span>
                  <button title={`Create a folder in ${library.team.name}`} aria-label={`Create folder in ${library.team.name}`} onClick={() => props.onCreateFolder(library.team.id)}><Plus size={16} /></button>
                </header>
                {library.queries.length > 0 && (
                  <div className="team-query-group">
                    <span className="team-group-label">Unfiled</span>
                    {library.queries.map((item) => (
                      <TeamStarItem
                        item={item}
                        folders={library.folders}
                        onOpen={props.onOpenTeamStar}
                        onEdit={props.onEditTeamStar}
                        key={item.id}
                      />
                    ))}
                  </div>
                )}
                {library.folders.map((folder) => (
                  <div className="team-folder" key={folder.id}>
                    <span><Folder size={15} /> {folder.name}<small>{folder.queries.length}</small></span>
                    {folder.queries.length === 0 && <small>Empty folder</small>}
                    {folder.queries.map((item) => (
                      <TeamStarItem
                        item={item}
                        folders={library.folders}
                        onOpen={props.onOpenTeamStar}
                        onEdit={props.onEditTeamStar}
                        key={item.id}
                      />
                    ))}
                  </div>
                ))}
              </section>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}

function TeamStarItem({
  item,
  folders,
  onOpen,
  onEdit,
}: {
  item: TeamQuery;
  folders: TeamFolder[];
  onOpen(item: TeamQuery): void;
  onEdit(item: TeamQuery, title: string, folderId: string): Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [folderId, setFolderId] = useState(item.folderId ?? "");
  const [saving, setSaving] = useState(false);

  const beginEditing = () => {
    setTitle(item.title);
    setFolderId(item.folderId ?? "");
    setEditing(true);
  };

  if (editing) {
    return (
      <form className="team-star-editor" onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim() || saving) return;
        setSaving(true);
        void onEdit(item, title.trim(), folderId)
          .then((updated) => {
            if (updated) setEditing(false);
          })
          .finally(() => setSaving(false));
      }}>
        <label><span>Name</span><input aria-label="Star name" autoFocus maxLength={256} required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label><span>Folder</span><select aria-label="Star folder" value={folderId} onChange={(event) => setFolderId(event.target.value)}>
          <option value="">Unfiled</option>
          {folders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}
        </select></label>
        <div className="team-star-editor-actions">
          <button type="button" title="Cancel" aria-label="Cancel editing star" disabled={saving} onClick={() => setEditing(false)}><X size={16} /></button>
          <button type="submit" title="Save changes" aria-label="Save star" disabled={saving || !title.trim()}><Check size={16} /></button>
        </div>
      </form>
    );
  }

  return (
    <div className="team-star-item">
      <button className="team-query-item" aria-label={`Open ${item.title} in a new tab`} title={`Open ${item.title} in a new tab`} onClick={() => onOpen(item)}>
        <Star size={14} fill="currentColor" aria-hidden="true" />
        <strong>{item.title}</strong>
        <code>{item.query}</code>
      </button>
      <button className="team-star-edit" aria-label={`Edit ${item.title}`} title="Rename or move star" onClick={beginEditing}><Pencil size={15} /></button>
    </div>
  );
}

function formatHistoryTime(executedAt: number) {
  return new Date(executedAt).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatElapsedTime(elapsedMs: number) {
  return elapsedMs >= 1_000 ? `${(elapsedMs / 1_000).toFixed(1)}s` : `${elapsedMs}ms`;
}
