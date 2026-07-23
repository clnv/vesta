import { Plus, RefreshCw, UserPlus, Users } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import {
  addDirectoryMembership, createDirectoryTeam, createDirectoryUser, getDirectory,
} from "../lib/api";
import type { Directory } from "../types";

interface Props {
  csrfToken: string;
  onClose(): void;
  onChanged(): void;
  onMessage(message: string): void;
}

export function AdminPanel({ csrfToken, onClose, onChanged, onMessage }: Props) {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [busy, setBusy] = useState(false);
  const [user, setUser] = useState({ email: "", name: "", password: "", roles: "reader", isAdmin: false });
  const [teamName, setTeamName] = useState("");
  const [membership, setMembership] = useState({ userId: "", teamId: "" });

  const refresh = async () => {
    setBusy(true);
    try {
      const value = await getDirectory();
      setDirectory(value);
      setMembership((current) => ({
        userId: current.userId || value.users[0]?.id || "",
        teamId: current.teamId || value.teams[0]?.id || "",
      }));
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Directory could not be loaded");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const submitUser = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await createDirectoryUser({
        ...user,
        roles: user.roles.split(",").map((role) => role.trim()).filter(Boolean),
      }, csrfToken);
      setUser({ email: "", name: "", password: "", roles: "reader", isAdmin: false });
      onMessage("User created");
      await refresh();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "User could not be created");
      setBusy(false);
    }
  };

  const submitTeam = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await createDirectoryTeam(teamName, csrfToken);
      setTeamName("");
      onMessage("Team created");
      await refresh();
      onChanged();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Team could not be created");
      setBusy(false);
    }
  };

  const submitMembership = async (event: FormEvent) => {
    event.preventDefault();
    if (!membership.userId || !membership.teamId) return;
    setBusy(true);
    try {
      await addDirectoryMembership(membership.userId, membership.teamId, csrfToken);
      onMessage("Team member added");
      await refresh();
      onChanged();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "Membership could not be created");
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="admin-panel" aria-label="Local user directory">
        <header>
          <div><span className="eyebrow">SQLITE DIRECTORY</span><h2>Users &amp; teams</h2></div>
          <button className="icon-button" aria-label="Refresh directory" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} className={busy ? "spin" : ""} /></button>
          <button className="toolbar-button" onClick={onClose}>Done</button>
        </header>

        <div className="admin-grid">
          <form onSubmit={(event) => void submitUser(event)}>
            <h3><UserPlus size={15} /> Create user</h3>
            <input required type="email" placeholder="Email" value={user.email} onChange={(event) => setUser({ ...user, email: event.target.value })} />
            <input required placeholder="Display name" value={user.name} onChange={(event) => setUser({ ...user, name: event.target.value })} />
            <input required type="password" minLength={12} placeholder="Temporary password (12+)" value={user.password} onChange={(event) => setUser({ ...user, password: event.target.value })} />
            <input placeholder="Roles, comma-separated" value={user.roles} onChange={(event) => setUser({ ...user, roles: event.target.value })} />
            <label className="checkbox-row"><input type="checkbox" checked={user.isAdmin} onChange={(event) => setUser({ ...user, isAdmin: event.target.checked })} /> Administrator</label>
            <button className="primary-button" disabled={busy}><Plus size={14} /> Create user</button>
          </form>

          <div className="admin-column">
            <form onSubmit={(event) => void submitTeam(event)}>
              <h3><Users size={15} /> Create team</h3>
              <div className="inline-form"><input required placeholder="Team name" value={teamName} onChange={(event) => setTeamName(event.target.value)} /><button className="primary-button" disabled={busy}><Plus size={14} /></button></div>
            </form>
            <form onSubmit={(event) => void submitMembership(event)}>
              <h3>Add team member</h3>
              <select value={membership.userId} onChange={(event) => setMembership({ ...membership, userId: event.target.value })}>
                {(directory?.users ?? []).map((item) => <option value={item.id} key={item.id}>{item.email}</option>)}
              </select>
              <select value={membership.teamId} onChange={(event) => setMembership({ ...membership, teamId: event.target.value })}>
                {(directory?.teams ?? []).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
              </select>
              <button className="toolbar-button" disabled={busy || !membership.userId || !membership.teamId}>Add member</button>
            </form>
          </div>
        </div>

        <div className="directory-list">
          {(directory?.users ?? []).map((item) => {
            const teams = (directory?.memberships ?? [])
              .filter((entry) => entry.userId === item.id)
              .map((entry) => directory?.teams.find((team) => team.id === entry.teamId)?.name)
              .filter(Boolean);
            return <div key={item.id}><strong>{item.name}</strong><span>{item.email}</span><small>{item.isAdmin ? "admin · " : ""}{item.roles.join(", ") || "no roles"}{teams.length ? ` · ${teams.join(", ")}` : ""}</small></div>;
          })}
        </div>
      </section>
    </div>
  );
}
