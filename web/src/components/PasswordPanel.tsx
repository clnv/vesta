import { KeyRound } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { changePassword } from "../lib/api";

interface Props {
  csrfToken: string;
  onClose(): void;
  onMessage(message: string): void;
}

export function PasswordPanel({ csrfToken, onClose, onMessage }: Props) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmation) {
      setError("New passwords do not match");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await changePassword(currentPassword, newPassword, csrfToken);
      onMessage("Password changed");
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Password could not be changed");
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="password-panel" onSubmit={(event) => void submit(event)}>
        <KeyRound size={22} />
        <div><span className="eyebrow">LOCAL ACCOUNT</span><h2>Change password</h2></div>
        <label><span>Current password</span><input required type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
        <label><span>New password</span><input required type="password" minLength={12} autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
        <label><span>Confirm new password</span><input required type="password" minLength={12} autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        {error && <div className="signin-error">{error}</div>}
        <footer><button type="button" className="toolbar-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save password"}</button></footer>
      </form>
    </div>
  );
}
