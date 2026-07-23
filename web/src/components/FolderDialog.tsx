import { FolderPlus, X } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";

interface Props {
  teamName: string;
  busy: boolean;
  error: string;
  onClose(): void;
  onCreate(name: string): void;
}

export function FolderDialog({ teamName, busy, error, onClose, onCreate }: Props) {
  const [name, setName] = useState("");
  const titleId = useId();
  const descriptionId = useId();
  const inputId = useId();
  const dialogRef = useRef<HTMLFormElement>(null);
  const cleanName = name.trim();

  useEffect(() => {
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? []);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", handleDialogKeys);
    return () => window.removeEventListener("keydown", handleDialogKeys);
  }, [busy, onClose]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (cleanName && !busy) onCreate(cleanName);
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <form
        ref={dialogRef}
        className="folder-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onSubmit={submit}
      >
        <header>
          <span className="folder-dialog-icon"><FolderPlus size={20} /></span>
          <div>
            <span className="eyebrow">TEAM LIBRARY</span>
            <h2 id={titleId}>Create folder</h2>
          </div>
          <button type="button" className="folder-dialog-close" aria-label="Close create folder dialog" disabled={busy} onClick={onClose}><X size={18} /></button>
        </header>
        <p id={descriptionId}>Add a folder to <strong>{teamName}</strong> to keep shared queries organized.</p>
        <div className="folder-dialog-field">
          <div>
            <label htmlFor={inputId}>Folder name</label>
            <small>{name.length}/128 characters</small>
          </div>
          <input
            id={inputId}
            autoFocus
            required
            maxLength={128}
            placeholder="e.g. Production incidents"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        {error && <div className="folder-dialog-error" role="alert">{error}</div>}
        <footer>
          <button type="button" className="toolbar-button" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={busy || !cleanName}>
            <FolderPlus size={16} /> {busy ? "Creating…" : "Create folder"}
          </button>
        </footer>
      </form>
    </div>
  );
}
