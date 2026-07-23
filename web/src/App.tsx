import {
  Braces, ChevronDown, CircleStop, Copy, Download, FileJson, History, LogOut,
  Moon, Play, Radio, Share2, Sun, Table2, TerminalSquare, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { QueryEditor, type QueryEditorHandle } from "./components/QueryEditor";
import { ResultViewer } from "./components/ResultViewer";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { APIError, fetchFields, getSession, streamQuery } from "./lib/api";
import { clipboardRows, formatRows, shareBundle } from "./lib/format";
import { DEFAULT_QUERY, hasTimeFilter, insertFilter, quoteLogSQLValue } from "./lib/logsql";
import { appendToRing } from "./lib/ring";
import { clearHistory as clearStoredHistory, loadWorkspace, saveWorkspace } from "./lib/storage";
import { decodeShare, MAX_SHARE_URL_LENGTH, sharedTabId, shareURL } from "./lib/share";
import type { ExplorerTab, FieldValue, HistoryEntry, PersistedTab, RunStatus, Session, SharePayload, StreamEvent, Tenant } from "./types";

type Theme = "light" | "dark";
type SessionState = { kind: "loading" } | { kind: "signed-out" } | { kind: "ready"; session: Session } | { kind: "error"; message: string };

function runtimeTab(tab: PersistedTab): ExplorerTab {
  return { ...tab, resultMode: tab.resultMode === "json" ? "json" : "table", status: "idle", rows: [], droppedRows: 0 };
}

function newTab(session: Session, title = "New query"): ExplorerTab {
  const source = session.sources[0];
  return {
    id: crypto.randomUUID(),
    title,
    sourceId: source?.id ?? "",
    tenant: source?.tenants[0] ?? { accountId: "", projectId: "", name: "No tenant" },
    query: DEFAULT_QUERY,
    lastExecutedQuery: "",
    resultMode: "table",
    status: "idle",
    rows: [],
    droppedRows: 0,
    contextError: source ? undefined : "Your account has no authorized VictoriaLogs sources.",
  };
}

function isContextAllowed(session: Session, sourceId: string, tenant: Tenant): boolean {
  return session.sources.some((source) => source.id === sourceId && source.tenants.some((candidate) => candidate.accountId === tenant.accountId && candidate.projectId === tenant.projectId));
}

function persistenceShape(tab: ExplorerTab): PersistedTab {
  return {
    id: tab.id,
    title: tab.title,
    sourceId: tab.sourceId,
    tenant: tab.tenant,
    query: tab.query,
    lastExecutedQuery: tab.lastExecutedQuery,
    resultMode: tab.resultMode,
    protected: tab.protected,
  };
}

function humanBytes(bytes = 0): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1 << 20) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1 << 20)).toFixed(1)} MiB`;
}

export default function App() {
  const [sessionState, setSessionState] = useState<SessionState>({ kind: "loading" });
  const [tabs, setTabs] = useState<ExplorerTab[]>([]);
  const [activeId, setActiveId] = useState("");
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<"fields" | "history">("fields");
  const [fields, setFields] = useState<FieldValue[]>([]);
  const [values, setValues] = useState<FieldValue[]>([]);
  const [selectedField, setSelectedField] = useState("");
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("vesta-theme") as Theme) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  const editorRef = useRef<QueryEditorHandle>(null);
  const controllers = useRef(new Map<string, AbortController>());

  const session = sessionState.kind === "ready" ? sessionState.session : null;
  const activeTab = tabs.find((tab) => tab.id === activeId);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("vesta-theme", theme);
  }, [theme]);

  useEffect(() => {
    const returnHash = sessionStorage.getItem("vesta:return-hash");
    if (!window.location.hash && returnHash) {
      window.location.hash = returnHash;
      sessionStorage.removeItem("vesta:return-hash");
    }
    void (async () => {
      try {
        const currentSession = await getSession();
        const restored = await loadWorkspace();
        let restoredTabs = restored.tabs.map((tab) => {
          const runtime = runtimeTab(tab);
          return isContextAllowed(currentSession, runtime.sourceId, runtime.tenant)
            ? runtime
            : { ...runtime, contextError: "This saved source or tenant is no longer authorized." };
        });
        const shared = decodeShare(window.location.hash);
        if (shared) {
          const sharedId = sharedTabId(window.location.hash);
          const sharedTab: ExplorerTab = {
            id: sharedId,
            title: shared.title || "Shared query",
            sourceId: shared.sourceId,
            tenant: shared.tenant,
            query: shared.query,
            lastExecutedQuery: "",
            resultMode: shared.resultMode,
            status: "idle",
            rows: [],
            droppedRows: 0,
            protected: true,
            contextError: isContextAllowed(currentSession, shared.sourceId, shared.tenant) ? undefined : "You are not authorized for the source or tenant in this shared link.",
          };
          restoredTabs = [...restoredTabs.filter((tab) => tab.id !== sharedId), sharedTab];
          setActiveId(sharedId);
        } else {
          setActiveId(restored.activeId && restoredTabs.some((tab) => tab.id === restored.activeId) ? restored.activeId : restoredTabs[0]?.id ?? "");
        }
        if (restoredTabs.length === 0) {
          const initial = newTab(currentSession);
          restoredTabs = [initial];
          setActiveId(initial.id);
        }
        setTabs(restoredTabs);
        setHistoryEntries(restored.history.filter((entry) => isContextAllowed(currentSession, entry.sourceId, entry.tenant)).slice(0, 100));
        setSessionState({ kind: "ready", session: currentSession });
        setWorkspaceReady(true);
      } catch (error) {
        if (error instanceof APIError && error.status === 401) setSessionState({ kind: "signed-out" });
        else setSessionState({ kind: "error", message: error instanceof Error ? error.message : "Vesta could not start" });
      }
    })();
    return () => controllers.current.forEach((controller) => controller.abort());
  }, []);

  useEffect(() => {
    if (!workspaceReady || !activeId) return;
    const timeout = window.setTimeout(() => {
      void saveWorkspace(tabs.map(persistenceShape), historyEntries.slice(0, 100), activeId);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [activeId, historyEntries, tabs, workspaceReady]);

  useEffect(() => {
    setFields([]);
    setValues([]);
    setSelectedField("");
  }, [activeId]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const updateTab = useCallback((id: string, update: Partial<ExplorerTab> | ((tab: ExplorerTab) => Partial<ExplorerTab>)) => {
    setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, ...(typeof update === "function" ? update(tab) : update) } : tab));
  }, []);

  const runQuery = useCallback(async (tabId: string, explicitQuery: string, tail: boolean) => {
    if (!session) return;
    const tab = tabs.find((candidate) => candidate.id === tabId);
    const query = explicitQuery.trim();
    if (!tab || !query) return;
    if (tab.contextError) {
      updateTab(tabId, { status: "error", error: tab.contextError });
      return;
    }
    if (!hasTimeFilter(query)) {
      updateTab(tabId, { status: "error", error: "Add an explicit _time: filter before running this query." });
      return;
    }

    controllers.current.get(tabId)?.abort();
    const controller = new AbortController();
    controllers.current.set(tabId, controller);
    const historyId = crypto.randomUUID();
    const initialStatus: RunStatus = tail ? "tailing" : "running";
    setHistoryEntries((current) => [{ id: historyId, query, sourceId: tab.sourceId, tenant: tab.tenant, executedAt: Date.now(), status: initialStatus }, ...current].slice(0, 100));
    updateTab(tabId, {
      status: tail ? "tailing" : "running",
      lastExecutedQuery: query,
      rows: [],
      droppedRows: 0,
      error: undefined,
      warning: undefined,
      stats: undefined,
      protected: false,
    });

    let pendingRows: Record<string, unknown>[] = [];
    const flushRows = () => {
      if (pendingRows.length === 0 || controllers.current.get(tabId) !== controller) return;
      const chunk = pendingRows;
      pendingRows = [];
      updateTab(tabId, (current) => {
        if (!tail) return { rows: [...current.rows, ...chunk] };
        const next = appendToRing(current.rows, chunk, 10_000);
        return { rows: next.rows, droppedRows: current.droppedRows + next.dropped };
      });
    };
    const flushTimer = window.setInterval(flushRows, 80);
    try {
      await streamQuery(tail ? "/api/v1/tail" : "/api/v1/query", { sourceId: tab.sourceId, tenant: tab.tenant, query }, session.csrfToken, controller.signal, (event: StreamEvent) => {
        if (controllers.current.get(tabId) !== controller) return;
        if (event.type === "meta") updateTab(tabId, { warning: event.warning || undefined, stats: { requestId: event.requestId, rows: 0, bytes: 0, elapsedMs: 0 } });
        if (event.type === "row" && event.row) pendingRows.push(event.row);
        if (event.type === "end") {
          flushRows();
          updateTab(tabId, {
            status: event.status ?? "complete",
            error: event.status === "error" ? event.reason : undefined,
            stats: {
              requestId: event.requestId,
              rows: event.rows ?? 0,
              bytes: event.bytes ?? 0,
              elapsedMs: event.elapsedMs ?? 0,
              victoriaDurationSeconds: event.victoriaDurationSeconds,
              reason: event.reason,
            },
          });
          setHistoryEntries((current) => current.map((entry) => entry.id === historyId ? { ...entry, status: event.status ?? "complete", elapsedMs: event.elapsedMs } : entry));
        }
      });
    } catch (error) {
      if (controllers.current.get(tabId) !== controller) return;
      if (error instanceof DOMException && error.name === "AbortError") {
        updateTab(tabId, { status: "cancelled" });
        setHistoryEntries((current) => current.map((entry) => entry.id === historyId ? { ...entry, status: "cancelled" } : entry));
      } else {
        const message = error instanceof Error ? error.message : "Query failed";
        updateTab(tabId, { status: "error", error: message });
        setHistoryEntries((current) => current.map((entry) => entry.id === historyId ? { ...entry, status: "error" } : entry));
      }
    } finally {
      window.clearInterval(flushTimer);
      flushRows();
      if (controllers.current.get(tabId) === controller) controllers.current.delete(tabId);
    }
  }, [session, tabs, updateTab]);

  const executeActive = useCallback((tail = false, explicit?: string) => {
    if (!activeTab) return;
    const query = explicit ?? editorRef.current?.executableQuery() ?? activeTab.query;
    void runQuery(activeTab.id, query, tail);
  }, [activeTab, runQuery]);

  const cancel = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    updateTab(id, { status: "cancelled" });
  }, [updateTab]);

  const refreshFields = async () => {
    if (!session || !activeTab || !hasTimeFilter(activeTab.query) || activeTab.contextError) return;
    setMetadataLoading(true);
    try {
      const result = await fetchFields({ sourceId: activeTab.sourceId, tenant: activeTab.tenant, query: activeTab.query }, session.csrfToken);
      setFields(result);
      setSelectedField("");
      setValues([]);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not load fields");
    } finally {
      setMetadataLoading(false);
    }
  };

  const openField = async (field: string) => {
    if (!field) {
      setSelectedField("");
      setValues([]);
      return;
    }
    if (!session || !activeTab) return;
    setSelectedField(field);
    setMetadataLoading(true);
    try {
      setValues(await fetchFields({ sourceId: activeTab.sourceId, tenant: activeTab.tenant, query: activeTab.query }, session.csrfToken, field));
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not load field values");
    } finally {
      setMetadataLoading(false);
    }
  };

  const addTab = () => {
    if (!session) return;
    const tab = newTab(session);
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
  };

  const closeTab = (id: string) => {
    cancel(id);
    setTabs((current) => {
      if (current.length === 1 && session) {
        const replacement = newTab(session);
        setActiveId(replacement.id);
        return [replacement];
      }
      const index = current.findIndex((tab) => tab.id === id);
      const next = current.filter((tab) => tab.id !== id);
      if (activeId === id) setActiveId(next[Math.min(index, next.length - 1)]?.id ?? "");
      return next;
    });
  };

  const duplicateTab = (id: string) => {
    const source = tabs.find((tab) => tab.id === id);
    if (!source) return;
    const duplicate: ExplorerTab = { ...source, id: crypto.randomUUID(), title: `${source.title} copy`, status: "idle", rows: [], droppedRows: 0, error: undefined, stats: undefined, protected: false };
    setTabs((current) => [...current, duplicate]);
    setActiveId(duplicate.id);
  };

  const setSource = (sourceId: string) => {
    if (!session || !activeTab) return;
    const source = session.sources.find((candidate) => candidate.id === sourceId);
    if (!source) return;
    updateTab(activeTab.id, { sourceId, tenant: source.tenants[0], contextError: undefined, rows: [], status: "idle" });
  };

  const setTenant = (key: string) => {
    if (!session || !activeTab) return;
    const source = session.sources.find((candidate) => candidate.id === activeTab.sourceId);
    const tenant = source?.tenants.find((candidate) => `${candidate.accountId}:${candidate.projectId}` === key);
    if (tenant) updateTab(activeTab.id, { tenant, contextError: undefined, rows: [], status: "idle" });
  };

  const copyText = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setToast(message);
    } catch {
      setToast("Clipboard access was denied by the browser.");
    }
  };

  const copyRichText = async (text: string, html: string, message: string) => {
    try {
      if (typeof ClipboardItem === "undefined" || typeof navigator.clipboard.write !== "function") {
        await navigator.clipboard.writeText(text);
        setToast(`${message} as Markdown`);
        return;
      }
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      })]);
      setToast(message);
    } catch {
      try {
        await navigator.clipboard.writeText(text);
        setToast(`${message} as Markdown`);
      } catch {
        setToast("Clipboard access was denied by the browser.");
      }
    }
  };

  const copyQuery = () => {
    if (!activeTab) return;
    void copyText(editorRef.current?.executableQuery() ?? activeTab.query, "Query copied");
    setShareOpen(false);
  };

  const copyLink = () => {
    if (!activeTab) return;
    const payload: SharePayload = {
      v: 1,
      query: editorRef.current?.executableQuery() ?? activeTab.query,
      sourceId: activeTab.sourceId,
      tenant: activeTab.tenant,
      title: activeTab.title,
      resultMode: activeTab.resultMode,
    };
    const link = shareURL(payload);
    if (link.length > MAX_SHARE_URL_LENGTH) setToast("This query is too large for a reliable link. Use Copy query instead.");
    else void copyText(link, "Protected query link copied");
    setShareOpen(false);
  };

  const copyQueryLinkAndResults = () => {
    if (!activeTab || !session || activeTab.rows.length === 0) return;
    const query = activeTab.lastExecutedQuery || activeTab.query;
    const payload: SharePayload = {
      v: 1,
      query,
      sourceId: activeTab.sourceId,
      tenant: activeTab.tenant,
      title: activeTab.title,
      resultMode: activeTab.resultMode,
    };
    const link = shareURL(payload);
    if (link.length > MAX_SHARE_URL_LENGTH) {
      setToast("This query is too large for a reliable link. Use the individual copy actions instead.");
    } else {
      const bundle = shareBundle({
        query,
        link,
        rows: activeTab.rows,
        mode: activeTab.resultMode,
      });
      void copyRichText(bundle.text, bundle.html, bundle.truncated ? "Rich query, link, and result excerpt copied" : "Rich query, link, and results copied");
    }
    setShareOpen(false);
  };

  const copyResults = () => {
    if (!activeTab || activeTab.rows.length === 0) return;
    const result = clipboardRows(activeTab.rows, activeTab.resultMode);
    void copyText(result.text, result.truncated ? "Result excerpt copied (5 MiB clipboard limit)" : "Results copied");
    setShareOpen(false);
  };

  const download = (format: "csv" | "ndjson") => {
    if (!activeTab || activeTab.rows.length === 0) return;
    const text = formatRows(activeTab.rows, activeTab.resultMode, format);
    const url = URL.createObjectURL(new Blob([text], { type: format === "csv" ? "text/csv" : "application/x-ndjson" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${activeTab.title.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase() || "vesta-results"}.${format === "csv" ? "csv" : "ndjson"}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setExportOpen(false);
  };

  const recall = (entry: HistoryEntry) => {
    if (!activeTab || !session || !isContextAllowed(session, entry.sourceId, entry.tenant)) return;
    updateTab(activeTab.id, { query: entry.query, sourceId: entry.sourceId, tenant: entry.tenant, protected: false, contextError: undefined });
    setSidebarMode("fields");
    editorRef.current?.focus();
  };

  const clearHistory = () => {
    setHistoryEntries([]);
    void clearStoredHistory();
    setToast("Local query history cleared");
  };

  const beginLogin = () => {
    if (window.location.hash) sessionStorage.setItem("vesta:return-hash", window.location.hash);
    window.location.assign("/auth/login");
  };

  const activeSource = useMemo(() => session?.sources.find((source) => source.id === activeTab?.sourceId), [activeTab?.sourceId, session]);
  const fieldsForEditor = fields.map((field) => field.value);

  if (sessionState.kind === "loading") return <Splash />;
  if (sessionState.kind === "signed-out") return <SignIn onLogin={beginLogin} />;
  if (sessionState.kind === "error") return <FatalError message={sessionState.message} />;
  if (!activeTab || !session) return <Splash />;

  const running = activeTab.status === "running" || activeTab.status === "tailing";
  const stale = Boolean(activeTab.lastExecutedQuery && activeTab.query !== activeTab.lastExecutedQuery);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand"><div className="brand-mark"><span /><span /><span /></div><div><strong>Vesta</strong><small>LOG EXPLORER</small></div></div>
        <div className="header-context"><span className="connection-pulse" />{activeSource?.name ?? "Unavailable source"}<span>/</span>{activeTab.tenant.name}</div>
        <div className="header-actions">
          <button className="icon-button" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}</button>
          <div className="identity"><span>{session.user.name || session.user.email}</span><small>{session.user.email}</small></div>
          <a className="icon-button" aria-label="Sign out" href="/auth/logout"><LogOut size={16} /></a>
        </div>
      </header>

      <TabBar
        tabs={tabs}
        activeId={activeId}
        onSelect={setActiveId}
        onAdd={addTab}
        onDuplicate={duplicateTab}
        onClose={closeTab}
        onRename={(id, title) => updateTab(id, { title })}
      />

      <main className="workspace">
        <Sidebar
          mode={sidebarMode}
          onMode={setSidebarMode}
          fields={fields}
          values={values}
          selectedField={selectedField}
          loading={metadataLoading}
          history={historyEntries}
          canInspect={hasTimeFilter(activeTab.query) && !Boolean(activeTab.contextError)}
          onRefresh={() => void refreshFields()}
          onField={(field) => void openField(field)}
          onInsert={(field, value, exclude) => updateTab(activeTab.id, { query: insertFilter(activeTab.query, `${exclude ? "-" : ""}${field}:=${quoteLogSQLValue(value)}`) })}
          onRecall={recall}
          onClearHistory={clearHistory}
        />

        <section className="query-workbench">
          <div className="query-toolbar">
            <label className="compact-select"><span>Source</span><select value={activeTab.sourceId} onChange={(event) => setSource(event.target.value)} disabled={running}>{session.sources.map((source) => <option value={source.id} key={source.id}>{source.name}</option>)}</select><ChevronDown size={13} /></label>
            <label className="compact-select"><span>Tenant</span><select value={`${activeTab.tenant.accountId}:${activeTab.tenant.projectId}`} onChange={(event) => setTenant(event.target.value)} disabled={running}>{activeSource?.tenants.map((tenant) => <option value={`${tenant.accountId}:${tenant.projectId}`} key={`${tenant.accountId}:${tenant.projectId}`}>{tenant.name}</option>)}</select><ChevronDown size={13} /></label>
            <div className="toolbar-divider" />
            <button className="primary-button" onClick={() => executeActive(false)} disabled={running || Boolean(activeTab.contextError)}><Play size={15} fill="currentColor" /> Run <kbd>⇧↵</kbd></button>
            <button className="toolbar-button" onClick={() => executeActive(true)} disabled={running || Boolean(activeTab.contextError)}><Radio size={15} /> Live tail</button>
            <button className="toolbar-button danger" onClick={() => cancel(activeTab.id)} disabled={!running}><CircleStop size={15} /> Cancel</button>
            <div className="toolbar-spacer" />
            <div className="menu-wrap">
              <button className="toolbar-button" onClick={() => { setShareOpen(!shareOpen); setExportOpen(false); }}><Share2 size={15} /> Share <ChevronDown size={13} /></button>
              {shareOpen && <div className="popover-menu">
                <button onClick={copyQueryLinkAndResults} disabled={activeTab.rows.length === 0}><Copy size={15} /><span><strong>Copy query, link &amp; results</strong><small>Rich HTML · Markdown fallback</small></span></button>
                <button onClick={copyQuery}><TerminalSquare size={15} /><span><strong>Copy query</strong><small>Selected text or full editor</small></span></button>
                <button onClick={copyLink}><Share2 size={15} /><span><strong>Copy protected link</strong><small>Opens without running</small></span></button>
                <button onClick={copyResults} disabled={activeTab.rows.length === 0}><Copy size={15} /><span><strong>Copy results</strong><small>TSV or NDJSON · max 5 MiB</small></span></button>
              </div>}
            </div>
            <div className="menu-wrap">
              <button className="icon-button" aria-label="Download results" onClick={() => { setExportOpen(!exportOpen); setShareOpen(false); }} disabled={activeTab.rows.length === 0}><Download size={16} /></button>
              {exportOpen && <div className="popover-menu compact"><button onClick={() => download("csv")}><Table2 size={15} /> CSV</button><button onClick={() => download("ndjson")}><FileJson size={15} /> NDJSON</button></div>}
            </div>
          </div>

          <div className="notices">
            {activeTab.protected && <div className="protected-banner"><Share2 size={16} /><span><strong>Protected shared query.</strong> Review the LogsQL and context, then choose Run explicitly.</span><button onClick={() => updateTab(activeTab.id, { protected: false })}><X size={14} /></button></div>}
            {activeTab.contextError && <div className="error-banner"><X size={16} /><span>{activeTab.contextError}</span></div>}
          </div>

          <div className="editor-panel">
            <div className="panel-caption"><span>LOGSQL</span><span>{hasTimeFilter(activeTab.query) ? <><i className="valid-dot" /> explicit time filter</> : <><i className="invalid-dot" /> _time: required</>}</span></div>
            <QueryEditor
              key={activeTab.id}
              ref={editorRef}
              value={activeTab.query}
              fields={fieldsForEditor}
              dark={theme === "dark"}
              onChange={(query) => updateTab(activeTab.id, { query, error: undefined })}
              onRun={(query) => executeActive(false, query)}
            />
          </div>

          <div className="results-panel">
            <div className="results-header">
              <div className="result-tabs" role="tablist" aria-label="Result view">
                <button className={activeTab.resultMode === "table" ? "active" : ""} onClick={() => updateTab(activeTab.id, { resultMode: "table" })}><Table2 size={14} /> Table</button>
                <button className={activeTab.resultMode === "json" ? "active" : ""} onClick={() => updateTab(activeTab.id, { resultMode: "json" })}><Braces size={14} /> JSON</button>
              </div>
              <div className="result-stats" aria-live="polite">
                {stale && <span className="stale-badge">Query changed since run</span>}
                <span className={`run-state ${activeTab.status}`}>{running && <i />} {activeTab.status}</span>
                <span>{(activeTab.stats?.rows ?? activeTab.rows.length).toLocaleString()} rows</span>
                {activeTab.stats && <><span>{humanBytes(activeTab.stats.bytes)}</span><span>{activeTab.stats.elapsedMs.toLocaleString()} ms</span></>}
                {activeTab.droppedRows > 0 && <span className="warning-text">{activeTab.droppedRows.toLocaleString()} live rows dropped</span>}
              </div>
            </div>
            {activeTab.warning && <div className="warning-banner">{activeTab.warning}</div>}
            {activeTab.status === "truncated" && <div className="warning-banner"><strong>Result truncated.</strong> {activeTab.stats?.reason}</div>}
            {activeTab.error && <div className="error-banner"><X size={15} /><span>{activeTab.error}</span></div>}
            <ResultViewer rows={activeTab.rows} mode={activeTab.resultMode} onCopy={(value) => void copyText(value, "Value copied")} />
          </div>
        </section>
      </main>
      <div className="screenreader-status" aria-live="polite">{toast}</div>
      {toast && <div className="toast"><span>{toast}</span></div>}
    </div>
  );
}

function Splash() {
  return <div className="center-screen"><div className="brand-mark large"><span /><span /><span /></div><h1>Vesta</h1><p>Opening your LogsQL workspace…</p><div className="loading-line"><i /></div></div>;
}

function SignIn({ onLogin }: { onLogin(): void }) {
  return <div className="center-screen signin"><div className="brand-mark large"><span /><span /><span /></div><span className="eyebrow">VICTORIALOGS EXPLORER</span><h1>Your logs, queried as written.</h1><p>Vesta keeps time and result semantics inside LogsQL—where they are visible, reviewable, and shareable.</p><button className="primary-button large-button" onClick={onLogin}><Play size={16} /> Sign in with your organization</button><small>Shared links open as protected drafts and never auto-run.</small></div>;
}

function FatalError({ message }: { message: string }) {
  return <div className="center-screen"><div className="error-symbol">!</div><h1>Vesta could not start</h1><p>{message}</p><button className="toolbar-button" onClick={() => window.location.reload()}><History size={15} /> Try again</button></div>;
}
