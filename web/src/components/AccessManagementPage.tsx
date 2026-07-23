import {
  ArrowLeft, Ban, Check, ChevronRight, CircleAlert, KeyRound, LogOut,
  Moon, Plus, RefreshCw, Search, ShieldCheck, Sun, UserPlus, Users, UsersRound, X,
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addDirectoryMembership, createDirectoryTeam, createDirectoryUser, getDirectory,
  getPermissionCatalog, removeDirectoryMembership, updateDirectoryTeam, updateDirectoryUser,
} from "../lib/api";
import type {
  Directory, DirectoryUser, PermissionCatalog, Session, Team, UpdateDirectoryUserInput,
} from "../types";

type AccessTab = "users" | "teams" | "permissions";
type Theme = "light" | "dark";

interface Props {
  session: Session;
  theme: Theme;
  onTheme(theme: Theme): void;
  onBack(): void;
  onMessage(message: string): void;
  onSessionChanged(): Promise<void>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function teamIDsFor(directory: Directory, userID: string): string[] {
  return directory.memberships.filter((item) => item.userId === userID).map((item) => item.teamId);
}

function memberIDsFor(directory: Directory, teamID: string): string[] {
  return directory.memberships.filter((item) => item.teamId === teamID).map((item) => item.userId);
}

function intersects(left: string[] | null | undefined, right: string[] | null | undefined): boolean {
  const values = new Set(left ?? []);
  return (right ?? []).some((value) => values.has(value));
}

function effectiveSourceCount(user: DirectoryUser, catalog: PermissionCatalog): number {
  return (catalog.sources ?? []).filter((source) => (
    intersects(user.roles, source.roles) &&
    (source.tenants ?? []).some((tenant) => (tenant.roles?.length ?? 0) === 0 || intersects(user.roles, tenant.roles))
  )).length;
}

export function AccessManagementPage({
  session, theme, onTheme, onBack, onMessage, onSessionChanged,
}: Props) {
  const [tab, setTab] = useState<AccessTab>("users");
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [catalog, setCatalog] = useState<PermissionCatalog | null>(null);
  const [loading, setLoading] = useState(session.user.isAdmin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!session.user.isAdmin) return;
    setLoading(true);
    setError("");
    try {
      const [nextDirectory, nextCatalog] = await Promise.all([getDirectory(), getPermissionCatalog()]);
      setDirectory(nextDirectory);
      setCatalog(nextCatalog);
    } catch (loadError) {
      setError(errorMessage(loadError, "Access management could not be loaded"));
    } finally {
      setLoading(false);
    }
  }, [session.user.isAdmin]);

  const refreshDirectory = async () => {
    setDirectory(await getDirectory());
  };

  useEffect(() => { void load(); }, [load]);

  const runMutation = async (
    action: () => Promise<void>,
    success: string,
    refreshSession = false,
  ): Promise<boolean> => {
    setBusy(true);
    try {
      await action();
      await refreshDirectory();
      if (refreshSession) await onSessionChanged();
      onMessage(success);
      return true;
    } catch (mutationError) {
      onMessage(errorMessage(mutationError, "The change could not be saved"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!session.user.isAdmin) {
    return (
      <div className="access-shell">
        <AccessHeader session={session} theme={theme} onTheme={onTheme} onBack={onBack} />
        <main className="access-denied">
          <div className="error-symbol"><Ban size={22} /></div>
          <span className="eyebrow">ADMINISTRATOR ACCESS</span>
          <h1>Access denied</h1>
          <p>Your account cannot manage users, teams, or permission assignments.</p>
          <button className="primary-button large-button" onClick={onBack}><ArrowLeft size={15} /> Return to explorer</button>
        </main>
      </div>
    );
  }

  return (
    <div className="access-shell">
      <AccessHeader session={session} theme={theme} onTheme={onTheme} onBack={onBack} />
      <div className="access-titlebar">
        <div>
          <span className="eyebrow">LOCAL SQLITE DIRECTORY</span>
          <h1>Access management</h1>
          <p>Manage accounts, team membership, and the roles that unlock VictoriaLogs sources.</p>
        </div>
        <button className="toolbar-button" disabled={loading || busy} onClick={() => void load()}>
          <RefreshCw size={14} className={loading ? "spin" : ""} /> Refresh
        </button>
      </div>

      {loading ? (
        <main className="access-loading" aria-label="Loading access management">
          <div className="loading-line"><i /></div>
          <p>Loading directory and permission policy…</p>
        </main>
      ) : error || !directory || !catalog ? (
        <main className="access-error">
          <CircleAlert size={24} />
          <h2>Access management is unavailable</h2>
          <p>{error || "The directory response was incomplete."}</p>
          <button className="toolbar-button" onClick={() => void load()}><RefreshCw size={14} /> Try again</button>
        </main>
      ) : (
        <>
          <section className="access-summary" aria-label="Directory summary">
            <SummaryCard label="Users" value={directory.users.length} detail={`${directory.users.filter((user) => user.disabled).length} suspended`} icon={<Users size={17} />} />
            <SummaryCard label="Teams" value={directory.teams.length} detail={`${directory.memberships.length} memberships`} icon={<UsersRound size={17} />} />
            <SummaryCard label="Configured roles" value={catalog.roles.length} detail={`${catalog.sources.length} log sources`} icon={<KeyRound size={17} />} />
            <SummaryCard
              label="Default deny"
              value={directory.users.filter((user) => effectiveSourceCount(user, catalog) === 0).length}
              detail="users without source access"
              icon={<ShieldCheck size={17} />}
            />
          </section>

          <nav className="access-tabs" role="tablist" aria-label="Access management sections">
            <button role="tab" aria-selected={tab === "users"} className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}><Users size={15} /> Users</button>
            <button role="tab" aria-selected={tab === "teams"} className={tab === "teams" ? "active" : ""} onClick={() => setTab("teams")}><UsersRound size={15} /> Teams</button>
            <button role="tab" aria-selected={tab === "permissions"} className={tab === "permissions" ? "active" : ""} onClick={() => setTab("permissions")}><ShieldCheck size={15} /> Permissions</button>
          </nav>

          <main className="access-content">
            {tab === "users" && (
              <UsersView
                directory={directory}
                catalog={catalog}
                currentUserID={session.user.subject}
                busy={busy}
                onCreate={async (input) => {
                  let created: DirectoryUser | null = null;
                  const saved = await runMutation(async () => {
                    created = await createDirectoryUser(input, session.csrfToken);
                  }, "User created");
                  return saved ? created : null;
                }}
                onSave={async (id, input) => {
                  await runMutation(
                    async () => { await updateDirectoryUser(id, input, session.csrfToken); },
                    "User access updated",
                    id === session.user.subject,
                  );
                }}
              />
            )}
            {tab === "teams" && (
              <TeamsView
                directory={directory}
                currentUserID={session.user.subject}
                busy={busy}
                onCreate={async (name) => {
                  let created: Team | null = null;
                  const saved = await runMutation(async () => {
                    created = await createDirectoryTeam(name, session.csrfToken);
                  }, "Team created");
                  return saved ? created : null;
                }}
                onRename={async (id, name) => {
                  await runMutation(async () => {
                    await updateDirectoryTeam(id, name, session.csrfToken);
                  }, "Team renamed", teamIDsFor(directory, session.user.subject).includes(id));
                }}
                onAdd={async (userID, teamID) => {
                  await runMutation(async () => {
                    await addDirectoryMembership(userID, teamID, session.csrfToken);
                  }, "Team member added", userID === session.user.subject);
                }}
                onRemove={async (userID, teamID) => {
                  await runMutation(async () => {
                    await removeDirectoryMembership(userID, teamID, session.csrfToken);
                  }, "Team member removed", userID === session.user.subject);
                }}
              />
            )}
            {tab === "permissions" && <PermissionsView directory={directory} catalog={catalog} />}
          </main>
        </>
      )}
    </div>
  );
}

function AccessHeader({
  session, theme, onTheme, onBack,
}: Pick<Props, "session" | "theme" | "onTheme" | "onBack">) {
  return (
    <header className="app-header access-header">
      <button className="access-back" onClick={onBack}><ArrowLeft size={15} /><span>Explorer</span></button>
      <div className="brand"><div className="brand-mark"><span /><span /><span /></div><div><strong>Vesta</strong><small>ACCESS CONTROL</small></div></div>
      <div className="header-actions">
        <button className="icon-button" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} onClick={() => onTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}</button>
        <div className="identity"><span>{session.user.name || session.user.email}</span><small>{session.user.email}</small></div>
        <a className="icon-button" aria-label="Sign out" href="/auth/logout"><LogOut size={16} /></a>
      </div>
    </header>
  );
}

function SummaryCard({ label, value, detail, icon }: { label: string; value: number; detail: string; icon: ReactNode }) {
  return (
    <article>
      <div>{icon}<span>{label}</span></div>
      <strong>{value.toLocaleString()}</strong>
      <small>{detail}</small>
    </article>
  );
}

interface UsersViewProps {
  directory: Directory;
  catalog: PermissionCatalog;
  currentUserID: string;
  busy: boolean;
  onCreate(input: { email: string; name: string; password: string; roles: string[]; isAdmin: boolean }): Promise<DirectoryUser | null>;
  onSave(id: string, input: UpdateDirectoryUserInput): Promise<void>;
}

function UsersView({ directory, catalog, currentUserID, busy, onCreate, onSave }: UsersViewProps) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "suspended">("all");
  const [selectedID, setSelectedID] = useState(directory.users[0]?.id ?? "");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!directory.users.some((user) => user.id === selectedID)) setSelectedID(directory.users[0]?.id ?? "");
  }, [directory.users, selectedID]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return directory.users.filter((user) => {
      if (status === "active" && user.disabled) return false;
      if (status === "suspended" && !user.disabled) return false;
      const teams = teamIDsFor(directory, user.id)
        .map((id) => directory.teams.find((team) => team.id === id)?.name ?? "")
        .join(" ");
      return !query || `${user.name} ${user.email} ${user.roles.join(" ")} ${teams}`.toLowerCase().includes(query);
    });
  }, [directory, search, status]);
  const selected = directory.users.find((user) => user.id === selectedID) ?? null;

  return (
    <section className="access-section" aria-labelledby="users-heading">
      <div className="access-section-heading">
        <div><span className="eyebrow">ACCOUNT DIRECTORY</span><h2 id="users-heading">Users</h2></div>
        <button className="primary-button" aria-label="Open create user form" disabled={creating} onClick={() => setCreating(true)}><UserPlus size={14} /> Create user</button>
      </div>
      <div className="access-filters">
        <label className="access-search"><Search size={14} /><input aria-label="Search users" placeholder="Search name, email, role, or team" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <select aria-label="Filter users by status" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
      </div>
      <div className="access-split">
        <div className="access-list" aria-label="Users">
          <div className="access-list-header"><span>User</span><span>Access</span><span>Status</span></div>
          {filtered.length === 0 && <div className="access-empty">No users match this filter.</div>}
          {filtered.map((user) => {
            const teams = teamIDsFor(directory, user.id);
            return (
              <button key={user.id} className={`access-list-row ${selectedID === user.id && !creating ? "selected" : ""}`} onClick={() => { setSelectedID(user.id); setCreating(false); }}>
                <span className="access-person"><i>{(user.name || user.email).slice(0, 2).toUpperCase()}</i><span><strong>{user.name}</strong><small>{user.email}</small></span></span>
                <span><strong>{user.roles.length} role{user.roles.length === 1 ? "" : "s"}</strong><small>{teams.length} team{teams.length === 1 ? "" : "s"}</small></span>
                <span className={`status-pill ${user.disabled ? "suspended" : "active"}`}>{user.disabled ? "Suspended" : "Active"}</span>
                <ChevronRight size={14} />
              </button>
            );
          })}
        </div>
        {creating ? (
          <CreateUserEditor
            roles={catalog.roles}
            busy={busy}
            onCancel={() => setCreating(false)}
            onCreate={async (input) => {
              const user = await onCreate(input);
              if (user) {
                setSelectedID(user.id);
                setCreating(false);
              }
            }}
          />
        ) : selected ? (
          <UserEditor
            key={`${selected.id}:${selected.email}:${selected.roles.join(",")}:${selected.disabled}:${directory.memberships.length}`}
            user={selected}
            directory={directory}
            configuredRoles={catalog.roles}
            currentUserID={currentUserID}
            busy={busy}
            onSave={onSave}
          />
        ) : <div className="access-empty editor-empty">Select a user to manage access.</div>}
      </div>
    </section>
  );
}

function CreateUserEditor({
  roles, busy, onCancel, onCreate,
}: {
  roles: string[];
  busy: boolean;
  onCancel(): void;
  onCreate(input: { email: string; name: string; password: string; roles: string[]; isAdmin: boolean }): Promise<void>;
}) {
  const [draft, setDraft] = useState({ email: "", name: "", password: "", roles: [] as string[], isAdmin: false });
  return (
    <form className="access-editor" onSubmit={(event) => { event.preventDefault(); void onCreate(draft); }}>
      <div className="access-editor-heading"><div><span className="eyebrow">NEW ACCOUNT</span><h3>Create user</h3></div><button type="button" className="icon-button" aria-label="Cancel user creation" onClick={onCancel}><X size={15} /></button></div>
      <div className="access-form-grid">
        <label><span>Display name</span><input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label><span>Email</span><input required type="email" autoComplete="off" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></label>
        <label className="wide"><span>Temporary password</span><input required aria-label="Temporary password" type="password" minLength={12} maxLength={128} autoComplete="new-password" value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} /><small>12–128 characters. The user can change it after signing in.</small></label>
      </div>
      <RoleChecklist roles={roles} selected={draft.roles} onChange={(selected) => setDraft({ ...draft, roles: selected })} />
      <label className="toggle-row"><input type="checkbox" checked={draft.isAdmin} onChange={(event) => setDraft({ ...draft, isAdmin: event.target.checked })} /><span><strong>Administrator</strong><small>Can manage users, teams, and role assignments.</small></span></label>
      <footer><button type="button" className="toolbar-button" onClick={onCancel}>Cancel</button><button className="primary-button" disabled={busy}><Plus size={14} /> Create user</button></footer>
    </form>
  );
}

function UserEditor({
  user, directory, configuredRoles, currentUserID, busy, onSave,
}: {
  user: DirectoryUser;
  directory: Directory;
  configuredRoles: string[];
  currentUserID: string;
  busy: boolean;
  onSave(id: string, input: UpdateDirectoryUserInput): Promise<void>;
}) {
  const [draft, setDraft] = useState<UpdateDirectoryUserInput>({
    email: user.email,
    name: user.name,
    roles: [...user.roles],
    isAdmin: user.isAdmin,
    disabled: user.disabled,
    teamIds: teamIDsFor(directory, user.id),
  });
  const legacyRoles = draft.roles.filter((role) => !configuredRoles.includes(role));
  const isSelf = user.id === currentUserID;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!user.disabled && draft.disabled && !window.confirm(`Suspend ${user.name}? Their current session will stop working.`)) return;
    if (user.isAdmin && !draft.isAdmin && !window.confirm(`Remove administrator access from ${user.name}?`)) return;
    await onSave(user.id, draft);
  };

  return (
    <form className="access-editor" onSubmit={(event) => void submit(event)}>
      <div className="access-editor-heading">
        <div><span className="eyebrow">{user.disabled ? "SUSPENDED ACCOUNT" : "ACTIVE ACCOUNT"}</span><h3>{user.name}</h3><small>Created {new Date(user.createdAt).toLocaleDateString()}</small></div>
        <span className={`status-pill ${user.disabled ? "suspended" : "active"}`}>{user.disabled ? "Suspended" : "Active"}</span>
      </div>
      <div className="access-form-grid">
        <label><span>Display name</span><input required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label><span>Email</span><input required type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></label>
      </div>
      <RoleChecklist roles={configuredRoles} selected={draft.roles} onChange={(roles) => setDraft({ ...draft, roles })} />
      {legacyRoles.length > 0 && (
        <fieldset className="legacy-roles">
          <legend>Unmapped legacy roles</legend>
          <p>These roles are no longer in server configuration. They grant no current source access and cannot be newly assigned.</p>
          <div>{legacyRoles.map((role) => <button type="button" key={role} onClick={() => setDraft({ ...draft, roles: draft.roles.filter((item) => item !== role) })}>{role}<X size={12} /></button>)}</div>
        </fieldset>
      )}
      <fieldset className="team-checklist">
        <legend>Team membership</legend>
        {directory.teams.length === 0 && <p>No teams have been created.</p>}
        {directory.teams.map((team) => (
          <label key={team.id}><input type="checkbox" checked={draft.teamIds.includes(team.id)} onChange={(event) => setDraft({ ...draft, teamIds: event.target.checked ? [...draft.teamIds, team.id] : draft.teamIds.filter((id) => id !== team.id) })} /><span>{team.name}</span></label>
        ))}
      </fieldset>
      <div className="account-toggles">
        <label className="toggle-row"><input type="checkbox" checked={draft.isAdmin} disabled={isSelf} onChange={(event) => setDraft({ ...draft, isAdmin: event.target.checked })} /><span><strong>Administrator</strong><small>{isSelf ? "You cannot demote your own account." : "Can manage directory access."}</small></span></label>
        <label className="toggle-row danger-toggle"><input type="checkbox" checked={draft.disabled} disabled={isSelf} onChange={(event) => setDraft({ ...draft, disabled: event.target.checked })} /><span><strong>Suspend account</strong><small>{isSelf ? "You cannot suspend your own account." : "Stops login and invalidates active sessions."}</small></span></label>
      </div>
      <footer><span>{draft.roles.length === 0 && <><ShieldCheck size={13} /> Default deny: no log source access</>}</span><button className="primary-button" disabled={busy}><Check size={14} /> Save changes</button></footer>
    </form>
  );
}

function RoleChecklist({
  roles, selected, onChange,
}: { roles: string[]; selected: string[]; onChange(roles: string[]): void }) {
  return (
    <fieldset className="role-checklist">
      <legend>Access roles</legend>
      {roles.length === 0 && <p>No roles are configured. This account will have no source access.</p>}
      <div>{roles.map((role) => (
        <label key={role}><input type="checkbox" checked={selected.includes(role)} onChange={(event) => onChange(event.target.checked ? [...selected, role] : selected.filter((item) => item !== role))} /><KeyRound size={13} /><span>{role}</span></label>
      ))}</div>
    </fieldset>
  );
}

interface TeamsViewProps {
  directory: Directory;
  currentUserID: string;
  busy: boolean;
  onCreate(name: string): Promise<Team | null>;
  onRename(id: string, name: string): Promise<void>;
  onAdd(userID: string, teamID: string): Promise<void>;
  onRemove(userID: string, teamID: string): Promise<void>;
}

function TeamsView({ directory, currentUserID, busy, onCreate, onRename, onAdd, onRemove }: TeamsViewProps) {
  const [search, setSearch] = useState("");
  const [selectedID, setSelectedID] = useState(directory.teams[0]?.id ?? "");
  const [newName, setNewName] = useState("");

  useEffect(() => {
    if (!directory.teams.some((team) => team.id === selectedID)) setSelectedID(directory.teams[0]?.id ?? "");
  }, [directory.teams, selectedID]);

  const filtered = directory.teams.filter((team) => {
    const members = memberIDsFor(directory, team.id)
      .map((id) => directory.users.find((user) => user.id === id))
      .filter(Boolean)
      .map((user) => `${user?.name} ${user?.email}`)
      .join(" ");
    return `${team.name} ${members}`.toLowerCase().includes(search.trim().toLowerCase());
  });
  const selected = directory.teams.find((team) => team.id === selectedID) ?? null;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const team = await onCreate(newName);
    if (team) {
      setSelectedID(team.id);
      setNewName("");
    }
  };

  return (
    <section className="access-section" aria-labelledby="teams-heading">
      <div className="access-section-heading">
        <div><span className="eyebrow">COLLABORATION GROUPS</span><h2 id="teams-heading">Teams</h2></div>
        <form className="create-team-form" onSubmit={(event) => void create(event)}><input required aria-label="New team name" placeholder="New team name" value={newName} onChange={(event) => setNewName(event.target.value)} /><button className="primary-button" disabled={busy}><Plus size={14} /> Create team</button></form>
      </div>
      <div className="access-filters"><label className="access-search"><Search size={14} /><input aria-label="Search teams" placeholder="Search team or member" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
      <div className="access-split">
        <div className="access-list" aria-label="Teams">
          <div className="access-list-header team-list-header"><span>Team</span><span>Members</span></div>
          {filtered.length === 0 && <div className="access-empty">No teams match this filter.</div>}
          {filtered.map((team) => {
            const count = memberIDsFor(directory, team.id).length;
            return <button key={team.id} className={`access-list-row team-row ${selectedID === team.id ? "selected" : ""}`} onClick={() => setSelectedID(team.id)}><span className="access-team-icon"><UsersRound size={15} /></span><span><strong>{team.name}</strong><small>{count} member{count === 1 ? "" : "s"}</small></span><ChevronRight size={14} /></button>;
          })}
        </div>
        {selected ? <TeamEditor key={`${selected.id}:${selected.name}:${directory.memberships.length}`} team={selected} directory={directory} currentUserID={currentUserID} busy={busy} onRename={onRename} onAdd={onAdd} onRemove={onRemove} /> : <div className="access-empty editor-empty">Create a team to manage membership.</div>}
      </div>
    </section>
  );
}

function TeamEditor({
  team, directory, currentUserID, busy, onRename, onAdd, onRemove,
}: {
  team: Team;
  directory: Directory;
  currentUserID: string;
  busy: boolean;
  onRename(id: string, name: string): Promise<void>;
  onAdd(userID: string, teamID: string): Promise<void>;
  onRemove(userID: string, teamID: string): Promise<void>;
}) {
  const [name, setName] = useState(team.name);
  const [memberSearch, setMemberSearch] = useState("");
  const memberIDs = memberIDsFor(directory, team.id);
  const members = directory.users.filter((user) => memberIDs.includes(user.id) && `${user.name} ${user.email}`.toLowerCase().includes(memberSearch.toLowerCase()));
  const available = directory.users.filter((user) => !memberIDs.includes(user.id));
  const [candidate, setCandidate] = useState(available[0]?.id ?? "");

  useEffect(() => {
    if (!available.some((user) => user.id === candidate)) setCandidate(available[0]?.id ?? "");
  }, [available, candidate]);

  return (
    <section className="access-editor team-editor">
      <div className="access-editor-heading"><div><span className="eyebrow">TEAM DETAILS</span><h3>{team.name}</h3></div><span className="status-pill active">{memberIDs.length} members</span></div>
      <form className="team-rename-form" onSubmit={(event) => { event.preventDefault(); void onRename(team.id, name); }}>
        <label><span>Team name</span><div><input required value={name} onChange={(event) => setName(event.target.value)} /><button className="toolbar-button" disabled={busy || name.trim() === team.name}>Rename</button></div></label>
      </form>
      <div className="team-member-toolbar">
        <label className="access-search"><Search size={14} /><input aria-label="Search team members" placeholder="Search members" value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} /></label>
        <div className="member-add">
          <select aria-label="User to add" value={candidate} onChange={(event) => setCandidate(event.target.value)} disabled={available.length === 0}>{available.length === 0 ? <option value="">All users are members</option> : available.map((user) => <option value={user.id} key={user.id}>{user.name} · {user.email}</option>)}</select>
          <button className="primary-button" disabled={busy || !candidate} onClick={() => void onAdd(candidate, team.id)}><Plus size={14} /> Add</button>
        </div>
      </div>
      <div className="member-list">
        {members.length === 0 && <div className="access-empty">{memberIDs.length === 0 ? "This team has no members." : "No members match this search."}</div>}
        {members.map((user) => (
          <div key={user.id}><span className="access-person"><i>{(user.name || user.email).slice(0, 2).toUpperCase()}</i><span><strong>{user.name}</strong><small>{user.email}</small></span></span><span>{user.id === currentUserID && <small>You</small>}<button className="icon-button" aria-label={`Remove ${user.name} from ${team.name}`} disabled={busy} onClick={() => void onRemove(user.id, team.id)}><X size={14} /></button></span></div>
        ))}
      </div>
    </section>
  );
}

function PermissionsView({ directory, catalog }: { directory: Directory; catalog: PermissionCatalog }) {
  const unmapped = Array.from(new Set(directory.users.flatMap((user) => user.roles).filter((role) => !catalog.roles.includes(role)))).sort();
  const denied = directory.users.filter((user) => effectiveSourceCount(user, catalog) === 0);
  return (
    <section className="access-section permissions-section" aria-labelledby="permissions-heading">
      <div className="access-section-heading">
        <div><span className="eyebrow">READ-ONLY CONFIGURATION</span><h2 id="permissions-heading">Permissions</h2><p>Role policy comes from the Vesta server configuration. Assign roles on the Users tab.</p></div>
        <span className="policy-badge"><ShieldCheck size={14} /> Default deny</span>
      </div>
      <div className="permission-explainer"><CircleAlert size={16} /><p>A user needs at least one source role. If a tenant lists additional roles, the user also needs at least one of those tenant roles.</p></div>
      <div className="permission-role-grid">
        {catalog.roles.map((role) => {
          const users = directory.users.filter((user) => user.roles.includes(role));
          return <article key={role}><div><KeyRound size={15} /><strong>{role}</strong></div><span>{users.length}</span><small>assigned user{users.length === 1 ? "" : "s"}</small></article>;
        })}
        {catalog.roles.length === 0 && <div className="access-empty">No access roles are configured.</div>}
      </div>
      <div className="permission-layout">
        <div className="policy-map">
          <div className="policy-column-heading"><div><span className="eyebrow">POLICY MAP</span><h3>Sources and tenants</h3></div><small>{catalog.sources.length} sources</small></div>
          {catalog.sources.map((source) => (
            <article className="policy-source" key={source.id}>
              <header><div><span className="connection-pulse" /><strong>{source.name}</strong><code>{source.id}</code></div><RoleChips roles={source.roles} empty="No source roles" /></header>
              <div className="policy-tenants">
                {source.tenants.map((tenant) => <div key={`${tenant.accountId}:${tenant.projectId}`}><span><strong>{tenant.name}</strong><small>{tenant.accountId}:{tenant.projectId}</small></span><RoleChips roles={tenant.roles} empty="No additional role" /></div>)}
              </div>
            </article>
          ))}
        </div>
        <aside className="policy-audit">
          <div className="policy-column-heading"><div><span className="eyebrow">ACCESS CHECK</span><h3>Attention needed</h3></div></div>
          <section><div className="audit-number">{denied.length}</div><strong>Default-deny users</strong><p>These accounts cannot access any configured log source.</p>{denied.slice(0, 5).map((user) => <span key={user.id}>{user.name}<small>{user.email}</small></span>)}{denied.length > 5 && <em>+{denied.length - 5} more</em>}</section>
          <section><div className="audit-number warning">{unmapped.length}</div><strong>Unmapped legacy roles</strong><p>These labels are stored on users but grant no current access.</p><RoleChips roles={unmapped} empty="None" /></section>
        </aside>
      </div>
    </section>
  );
}

function RoleChips({ roles, empty }: { roles: string[] | null | undefined; empty: string }) {
  const values = roles ?? [];
  return <div className="role-chips">{values.length === 0 ? <span className="empty-chip">{empty}</span> : values.map((role) => <span key={role}>{role}</span>)}</div>;
}
