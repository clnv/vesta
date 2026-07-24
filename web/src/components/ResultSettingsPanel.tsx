import { EyeOff, Plus, RotateCcw, Trash2, X } from "lucide-react";
import type { FormEvent, KeyboardEvent } from "react";
import { useState } from "react";
import { updateUserSettings } from "../lib/api";
import { DEFAULT_HIDDEN_RESULT_FIELDS, parseHiddenResultFields } from "../lib/resultFields";
import type { UserSettings } from "../types";

interface Props {
  settings: UserSettings;
  csrfToken: string;
  onClose(): void;
  onSaved(settings: UserSettings): void;
  onMessage(message: string): void;
}

function mergeFields(current: string[], value: string): string[] {
  const seen = new Set(current);
  const merged = [...current];
  for (const field of parseHiddenResultFields(value)) {
    if (seen.has(field)) continue;
    seen.add(field);
    merged.push(field);
  }
  return merged;
}

export function ResultSettingsPanel({ settings, csrfToken, onClose, onSaved, onMessage }: Props) {
  const [fields, setFields] = useState(settings.hiddenResultFields);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const addDraft = () => {
    const next = mergeFields(fields, draft);
    if (next.length > 100) {
      setError("You can hide up to 100 fields or prefixes.");
      return;
    }
    setFields(next);
    setDraft("");
    setError("");
  };

  const addOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addDraft();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = mergeFields(fields, draft);
    if (next.length > 100) {
      setError("You can hide up to 100 fields or prefixes.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const updated = await updateUserSettings(next, csrfToken);
      onSaved(updated);
      onMessage("Result field settings saved. Rerun a query to load newly visible fields.");
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Result field settings could not be saved");
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <form className="result-settings-panel" onSubmit={(event) => void submit(event)}>
        <header>
          <div className="result-settings-icon"><EyeOff size={19} /></div>
          <div>
            <span className="eyebrow">RESULT DISPLAY</span>
            <h2>Hidden fields</h2>
            <small>Personal to your account</small>
          </div>
          <button className="result-settings-close" type="button" aria-label="Close hidden field settings" disabled={busy} onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <p>Reduce noisy result payloads by hiding fields you rarely inspect. Source security rules always remain enforced.</p>
        <section className="result-field-composer">
          <label htmlFor="hidden-result-field">Add a field or prefix</label>
          <div>
            <input
              id="hidden-result-field"
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={addOnEnter}
              placeholder="e.g. kubernetes.* or trace_id"
              spellCheck={false}
            />
            <button type="button" disabled={busy || parseHiddenResultFields(draft).length === 0} onClick={addDraft}>
              <Plus size={14} /> Add
            </button>
          </div>
          <small>Paste comma-separated names, or end a name with <code>*</code> to match a prefix.</small>
        </section>
        <section className="hidden-field-editor">
          <header>
            <div>
              <strong>{fields.length} hidden {fields.length === 1 ? "field" : "fields"}</strong>
              <small>Applied after you save changes</small>
            </div>
            <button type="button" disabled={busy || fields.length === 0} onClick={() => { setFields([]); setDraft(""); }}>
              <Trash2 size={13} /> Clear all
            </button>
          </header>
          {fields.length > 0 ? (
            <div className="hidden-field-chips" aria-label="Fields hidden from results">
              {fields.map((field) => (
                <span key={field}>
                  <code>{field}</code>
                  <button
                    type="button"
                    aria-label={`Show ${field} in results`}
                    title={`Stop hiding ${field}`}
                    disabled={busy}
                    onClick={() => setFields((current) => current.filter((candidate) => candidate !== field))}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <div className="hidden-field-empty">
              <EyeOff size={18} />
              <span><strong>All result fields are visible</strong><small>Add a field above or restore the recommended defaults.</small></span>
            </div>
          )}
        </section>
        {error && <div className="signin-error">{error}</div>}
        <footer>
          <button
            className="settings-reset"
            type="button"
            disabled={busy}
            onClick={() => {
              setFields([...DEFAULT_HIDDEN_RESULT_FIELDS]);
              setDraft("");
            }}
          >
            <RotateCcw size={13} /> Restore defaults
          </button>
          <div>
            <button type="button" className="toolbar-button" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
          </div>
        </footer>
      </form>
    </div>
  );
}
