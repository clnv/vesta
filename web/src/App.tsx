import {
  Braces, ChartNoAxesCombined, ChevronDown, CircleStop, Copy, Download, EyeOff, FileJson, History, KeyRound,
  LockKeyhole, LogOut, Moon, Play, Share2, Star, Sun, Table2, Users, X,
} from "lucide-react";
import type { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccessManagementPage } from "./components/AccessManagementPage";
import { FolderDialog } from "./components/FolderDialog";
import { PasswordPanel } from "./components/PasswordPanel";
import { QueryEditor, type QueryEditorHandle } from "./components/QueryEditor";
import { ResultSettingsPanel } from "./components/ResultSettingsPanel";
import { ResultViewer } from "./components/ResultViewer";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import {
  APIError, createPersonalQuery, createShare, createTeamFolder, createTeamQuery, getSession,
  getStarLibrary, login, openShare, streamQuery, updatePersonalQuery, updateTeamQuery,
} from "./lib/api";
import { blobToDataURL, chartElementToPNG } from "./lib/chartExport";
import { formatRows, shareBundle } from "./lib/format";
import { columnsFromQuery, DEFAULT_QUERY, hasTimeFilter, renderDirectiveFromQuery } from "./lib/logsql";
import { clearHistory as clearStoredHistory, loadWorkspace, saveWorkspace } from "./lib/storage";
import { sharedTabId, shareTokenFromHash, shareURL } from "./lib/share";
import { tabFromTeamStar } from "./lib/teamStars";
import type {
  ExplorerTab, HistoryEntry, PersonalQuery, PersistedTab, Session, SharePayload,
  StarQuery, StreamEvent, TeamLibrary, TeamQuery,
} from "./types";

type Theme = "light" | "dark";
type AppRoute = "explorer" | "admin-access";
type ShareParts = { link: boolean; query: boolean; results: boolean };
type SessionState = { kind: "loading" } | { kind: "signed-out" } | { kind: "ready"; session: Session } | { kind: "error"; message: string };
const EMPTY_EDITOR_FIELDS: string[] = [];
const DEFAULT_SHARE_PARTS: ShareParts = { link: true, query: true, results: false };
const EDITOR_PANE_STORAGE_KEY = "vesta-editor-pane-percent";
const DEFAULT_EDITOR_PANE_PERCENT = 36;
const MIN_EDITOR_PANE_PERCENT = 20;
const MAX_EDITOR_PANE_PERCENT = 80;

function clampEditorPanePercent(value: number): number {
  return Math.min(MAX_EDITOR_PANE_PERCENT, Math.max(MIN_EDITOR_PANE_PERCENT, value));
}

function savedEditorPanePercent(): number {
  try {
    const saved = localStorage.getItem(EDITOR_PANE_STORAGE_KEY);
    if (saved === null) return DEFAULT_EDITOR_PANE_PERCENT;
    const value = Number(saved);
    return Number.isFinite(value) ? clampEditorPanePercent(value) : DEFAULT_EDITOR_PANE_PERCENT;
  } catch {
    return DEFAULT_EDITOR_PANE_PERCENT;
  }
}

function currentRoute(): AppRoute {
  return window.location.pathname === "/admin/access" ? "admin-access" : "explorer";
}

function runtimeTab(tab: PersistedTab): ExplorerTab {
  const resultMode = tab.resultMode === "json" || tab.resultMode === "chart" ? tab.resultMode : "table";
  return {
    id: tab.id,
    title: tab.title,
    sourceId: tab.sourceId,
    query: tab.query,
    lastExecutedQuery: tab.lastExecutedQuery,
    resultMode,
    status: "idle",
    rows: [],
    protected: tab.protected,
  };
}

function runtimeHistory(entry: HistoryEntry): HistoryEntry {
  return {
    id: entry.id,
    query: entry.query,
    sourceId: entry.sourceId,
    executedAt: entry.executedAt,
    status: entry.status,
    elapsedMs: entry.elapsedMs,
  };
}

function newTab(session: Session, title = "New query"): ExplorerTab {
  const source = session.sources[0];
  return {
    id: crypto.randomUUID(),
    title,
    sourceId: source?.id ?? "",
    query: DEFAULT_QUERY,
    lastExecutedQuery: "",
    resultMode: "table",
    status: "idle",
    rows: [],
    contextError: source ? undefined : "Your account has no authorized VictoriaLogs sources.",
  };
}

function isContextAllowed(session: Session, sourceId: string): boolean {
  return session.sources.some((source) => source.id === sourceId);
}

function persistenceShape(tab: ExplorerTab): PersistedTab {
  return {
    id: tab.id,
    title: tab.title,
    sourceId: tab.sourceId,
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
  const [sidebarMode, setSidebarMode] = useState<"history" | "stars">("stars");
  const [shareOpen, setShareOpen] = useState(false);
  const [shareParts, setShareParts] = useState<ShareParts>(DEFAULT_SHARE_PARTS);
  const [starOpen, setStarOpen] = useState(false);
  const [starCollection, setStarCollection] = useState<"private" | "team">("private");
  const [starName, setStarName] = useState("");
  const [starTeam, setStarTeam] = useState("");
  const [starFolder, setStarFolder] = useState("");
  const [personalQueries, setPersonalQueries] = useState<PersonalQuery[]>([]);
  const [teamLibraries, setTeamLibraries] = useState<TeamLibrary[]>([]);
  const [folderDialogTeam, setFolderDialogTeam] = useState("");
  const [folderCreating, setFolderCreating] = useState(false);
  const [folderCreateError, setFolderCreateError] = useState("");
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [route, setRoute] = useState<AppRoute>(currentRoute);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("vesta-theme") as Theme) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  const [editorPanePercent, setEditorPanePercent] = useState(savedEditorPanePercent);
  const editorRef = useRef<QueryEditorHandle>(null);
  const folderTriggerRef = useRef<HTMLElement | null>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const paneResizeRef = useRef<{ pointerId: number; startY: number; startEditorHeight: number; totalHeight: number } | null>(null);

  const session = sessionState.kind === "ready" ? sessionState.session : null;
  const activeTab = tabs.find((tab) => tab.id === activeId);
  const activeVisualization = useMemo(
    () => activeTab ? renderDirectiveFromQuery(activeTab.lastExecutedQuery || activeTab.query) : null,
    [activeTab?.lastExecutedQuery, activeTab?.query],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("vesta-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(EDITOR_PANE_STORAGE_KEY, String(editorPanePercent));
  }, [editorPanePercent]);

  useEffect(() => () => {
    document.body.classList.remove("resizing-panes");
  }, []);

  useEffect(() => {
    const handlePopState = () => setRoute(currentRoute());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const openAccessManagement = useCallback(() => {
    window.history.pushState({ vestaFromExplorer: true }, "", "/admin/access");
    setRoute(currentRoute());
    setShareOpen(false);
    setStarOpen(false);
    setExportOpen(false);
  }, []);

  const returnToExplorer = useCallback(() => {
    if (window.history.state?.vestaFromExplorer) {
      window.history.back();
      return;
    }
    window.history.replaceState(null, "", "/");
    setRoute("explorer");
  }, []);

  useEffect(() => {
    const returnHash = sessionStorage.getItem("vesta:return-hash");
    if (!window.location.hash && returnHash) {
      window.location.hash = returnHash;
      sessionStorage.removeItem("vesta:return-hash");
    }
    void (async () => {
      try {
        const currentSession = await getSession();
        const library = await getStarLibrary();
        const restored = await loadWorkspace();
        let restoredTabs = restored.tabs.map((tab) => {
          const runtime = runtimeTab(tab);
          return isContextAllowed(currentSession, runtime.sourceId)
            ? runtime
            : { ...runtime, contextError: "This saved source is no longer authorized." };
        });
        let shared: SharePayload | null = null;
        const privateToken = shareTokenFromHash(window.location.hash);
        if (privateToken) {
          try {
            shared = (await openShare(privateToken, currentSession.csrfToken)).payload;
          } catch (error) {
            setToast(error instanceof Error ? error.message : "This shared query could not be opened");
          }
        }
        if (shared) {
          const sharedId = sharedTabId(window.location.hash);
          const sharedTab: ExplorerTab = {
            id: sharedId,
            title: shared.title || "Shared query",
            sourceId: shared.sourceId,
            query: shared.query,
            lastExecutedQuery: "",
            resultMode: shared.resultMode,
            status: "idle",
            rows: [],
            protected: true,
            contextError: isContextAllowed(currentSession, shared.sourceId) ? undefined : "You are not authorized for the source in this shared link.",
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
        setHistoryEntries(restored.history
          .filter((entry) => isContextAllowed(currentSession, entry.sourceId))
          .map(runtimeHistory)
          .slice(0, 100));
        setPersonalQueries(library.self);
        setTeamLibraries(library.teams);
        setStarTeam(currentSession.user.teams?.[0]?.id ?? "");
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
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const updateTab = useCallback((id: string, update: Partial<ExplorerTab> | ((tab: ExplorerTab) => Partial<ExplorerTab>)) => {
    setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, ...(typeof update === "function" ? update(tab) : update) } : tab));
  }, []);

  const runQuery = useCallback(async (tabId: string, explicitQuery: string) => {
    if (!session) return;
    const tab = tabs.find((candidate) => candidate.id === tabId);
    const query = explicitQuery.trim();
    if (!tab) return;
    if (!query) {
      updateTab(tabId, { status: "error", error: "Place the cursor inside a query or select one before running." });
      return;
    }
    const visualization = renderDirectiveFromQuery(query);
    const executableQuery = visualization?.executableQuery || query;
    if (tab.contextError) {
      updateTab(tabId, { status: "error", error: tab.contextError });
      return;
    }
    if (!hasTimeFilter(executableQuery)) {
      updateTab(tabId, { status: "error", error: "Add an explicit _time: filter before running this query." });
      return;
    }

    controllers.current.get(tabId)?.abort();
    const controller = new AbortController();
    controllers.current.set(tabId, controller);
    const historyId = crypto.randomUUID();
    const historyEntry: HistoryEntry = { id: historyId, query, sourceId: tab.sourceId, executedAt: Date.now(), status: "running" };
    setHistoryEntries((current) => [historyEntry, ...current].slice(0, 100));
    updateTab(tabId, {
      status: "running",
      lastExecutedQuery: query,
      rows: [],
      error: undefined,
      warning: undefined,
      stats: undefined,
      protected: false,
      resultMode: visualization
        ? visualization.visualization === "table" ? "table" : "chart"
        : tab.resultMode === "chart" ? "table" : tab.resultMode,
    });

    let pendingRows: Record<string, unknown>[] = [];
    const flushRows = () => {
      if (pendingRows.length === 0 || controllers.current.get(tabId) !== controller) return;
      const chunk = pendingRows;
      pendingRows = [];
      updateTab(tabId, (current) => ({ rows: [...current.rows, ...chunk] }));
    };
    const flushTimer = window.setInterval(flushRows, 80);
    try {
      await streamQuery({ sourceId: tab.sourceId, query: executableQuery }, session.csrfToken, controller.signal, (event: StreamEvent) => {
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

  const executeActive = useCallback((explicit?: string) => {
    if (!activeTab) return;
    const query = explicit ?? editorRef.current?.executableQuery() ?? activeTab.query;
    void runQuery(activeTab.id, query);
  }, [activeTab, runQuery]);

  const cancel = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    updateTab(id, { status: "cancelled" });
  }, [updateTab]);

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
    const duplicate: ExplorerTab = { ...source, id: crypto.randomUUID(), title: `${source.title} copy`, status: "idle", rows: [], error: undefined, stats: undefined, protected: false };
    setTabs((current) => [...current, duplicate]);
    setActiveId(duplicate.id);
  };

  const setSource = (sourceId: string) => {
    if (!session || !activeTab) return;
    const source = session.sources.find((candidate) => candidate.id === sourceId);
    if (!source) return;
    updateTab(activeTab.id, { sourceId, contextError: undefined, rows: [], status: "idle" });
  };

  const copyText = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setToast(message);
    } catch {
      setToast("Clipboard access was denied by the browser.");
    }
  };

  const copyRichText = async (text: string, html: string, message: string, image?: Blob) => {
    try {
      if (typeof ClipboardItem === "undefined" || typeof navigator.clipboard.write !== "function") {
        await navigator.clipboard.writeText(text);
        setToast(`${message} as Markdown`);
        return;
      }
      await navigator.clipboard.write([new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
        ...(image ? { "image/png": image } : {}),
      })]);
      setToast(message);
    } catch {
      if (image && typeof ClipboardItem !== "undefined" && typeof navigator.clipboard.write === "function") {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": image })]);
          setToast("Chart image copied; rich share format is unavailable.");
          return;
        } catch {
          // Continue to the portable text fallback.
        }
      }
      try {
        await navigator.clipboard.writeText(text);
        setToast(`${message} as Markdown`);
      } catch {
        setToast("Clipboard access was denied by the browser.");
      }
    }
  };

  const renderedChartPNG = async (): Promise<Blob | null> => {
    const chart = document.querySelector<HTMLElement>(".results-panel .chart-view");
    if (!chart) return null;
    try {
      return await chartElementToPNG(chart);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "The chart image could not be created.");
      return null;
    }
  };

  const createSystemShareLink = async (query: string): Promise<string | null> => {
    if (!activeTab || !session) return null;
    const payload: SharePayload = {
      query,
      sourceId: activeTab.sourceId,
      title: activeTab.title,
      resultMode: activeTab.resultMode,
    };
    try {
      const result = await createShare(payload, session.csrfToken);
      return shareURL(result.token);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Share link could not be created");
      return null;
    }
  };

  const toggleSharePart = (part: keyof ShareParts) => {
    if (part === "results" && activeTab?.rows.length === 0) return;
    setShareParts((current) => ({ ...current, [part]: !current[part] }));
  };

  const copySelectedShare = async () => {
    if (!activeTab || !session || !Object.values(shareParts).some(Boolean)) return;
    if (shareParts.results && activeTab.rows.length === 0) {
      setToast("Run the query before including results.");
      return;
    }
    const editorQuery = editorRef.current?.executableQuery() ?? activeTab.query;
    const query = shareParts.results && activeTab.lastExecutedQuery ? activeTab.lastExecutedQuery : editorQuery;
    let link = "";
    if (shareParts.link) {
      const createdLink = await createSystemShareLink(query);
      if (!createdLink) return;
      link = createdLink;
    }
    const chartImage = shareParts.results && activeTab.resultMode === "chart" ? await renderedChartPNG() : null;
    const bundle = shareBundle({
      query,
      link,
      rows: activeTab.rows,
      mode: activeTab.resultMode,
      hiddenResultFields: session.user.settings.hiddenResultFields,
      chartImageDataURL: chartImage ? await blobToDataURL(chartImage) : undefined,
      include: shareParts,
    });
    const labels = [
      shareParts.link ? "Link" : "",
      shareParts.query ? "query" : "",
      shareParts.results ? (chartImage ? "chart" : bundle.truncated ? "result excerpt" : "results") : "",
    ].filter(Boolean);
    await copyRichText(
      bundle.text,
      bundle.html,
      `${labels.join(", ")} copied`,
      chartImage ?? undefined,
    );
    setShareOpen(false);
  };

  const openShareMenu = () => {
    const opening = !shareOpen;
    setShareOpen(opening);
    if (opening) {
      setShareParts(DEFAULT_SHARE_PARTS);
    }
    setStarOpen(false);
    setExportOpen(false);
  };

  const download = (format: "csv" | "ndjson") => {
    if (!activeTab || !session || activeTab.rows.length === 0) return;
    const text = formatRows(
      activeTab.rows,
      activeTab.resultMode,
      format,
      columnsFromQuery(activeTab.lastExecutedQuery || activeTab.query),
      session.user.settings.hiddenResultFields,
    );
    const url = URL.createObjectURL(new Blob([text], { type: format === "csv" ? "text/csv" : "application/x-ndjson" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${activeTab.title.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase() || "vesta-results"}.${format === "csv" ? "csv" : "ndjson"}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setExportOpen(false);
  };

  const recall = (entry: HistoryEntry) => {
    if (!activeTab || !session || !isContextAllowed(session, entry.sourceId)) return;
    updateTab(activeTab.id, { query: entry.query, sourceId: entry.sourceId, protected: false, contextError: undefined });
    editorRef.current?.focus();
  };

  const clearHistory = () => {
    setHistoryEntries([]);
    void clearStoredHistory();
    setToast("Local query history cleared");
  };

  const refreshStarLibrary = async () => {
    try {
      const library = await getStarLibrary();
      setPersonalQueries(library.self);
      setTeamLibraries(library.teams);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Starred queries could not be loaded");
    }
  };

  const refreshAccountData = async () => {
    try {
      const [currentSession, library] = await Promise.all([getSession(), getStarLibrary()]);
      setSessionState({ kind: "ready", session: currentSession });
      setPersonalQueries(library.self);
      setTeamLibraries(library.teams);
      setStarTeam((current) => currentSession.user.teams.some((team) => team.id === current) ? current : currentSession.user.teams[0]?.id ?? "");
      setTabs((current) => current.map((tab) => isContextAllowed(currentSession, tab.sourceId)
        ? { ...tab, contextError: undefined }
        : { ...tab, contextError: "This source is no longer authorized." }));
      setHistoryEntries((current) => current.filter((entry) => isContextAllowed(currentSession, entry.sourceId)));
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Account data could not be refreshed");
    }
  };

  const openFolderDialog = (teamId: string) => {
    folderTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFolderCreateError("");
    setFolderDialogTeam(teamId);
  };

  const closeFolderDialog = () => {
    setFolderDialogTeam("");
    setFolderCreateError("");
    requestAnimationFrame(() => folderTriggerRef.current?.focus());
  };

  const createFolder = async (name: string) => {
    if (!session || !folderDialogTeam) return;
    setFolderCreating(true);
    setFolderCreateError("");
    try {
      await createTeamFolder(folderDialogTeam, name, session.csrfToken);
      await refreshStarLibrary();
      setToast("Team folder created");
      closeFolderDialog();
    } catch (error) {
      setFolderCreateError(error instanceof Error ? error.message : "Team folder could not be created");
    } finally {
      setFolderCreating(false);
    }
  };

  const openStar = (item: StarQuery) => {
    if (!session) return;
    if (!isContextAllowed(session, item.sourceId)) {
      setToast("You are not authorized for this query’s source.");
      return;
    }
    const tab = tabFromTeamStar(item);
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
    setToast(`Opened an editable copy of “${item.title}”`);
  };

  const editPersonalStar = async (item: PersonalQuery, title: string): Promise<boolean> => {
    if (!session) return false;
    try {
      await updatePersonalQuery(item.id, title.trim(), session.csrfToken);
      await refreshStarLibrary();
      setToast("Private star updated");
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Private star could not be updated");
      return false;
    }
  };

  const editTeamStar = async (item: TeamQuery, title: string, folderId: string): Promise<boolean> => {
    if (!session) return false;
    try {
      await updateTeamQuery(item.id, title.trim(), folderId, session.csrfToken);
      await refreshStarLibrary();
      setToast("Team star updated");
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Team star could not be updated");
      return false;
    }
  };

  const starPrivately = async () => {
    if (!activeTab || !session) return;
    const title = starName.trim();
    if (!title) {
      setToast("Give this star a name.");
      return;
    }
    const payload: SharePayload = {
      query: editorRef.current?.executableQuery() ?? activeTab.query,
      sourceId: activeTab.sourceId,
      title,
      resultMode: activeTab.resultMode,
    };
    try {
      await createPersonalQuery(payload, session.csrfToken);
      await refreshStarLibrary();
      setSidebarMode("stars");
      setToast("Query starred privately");
      setStarOpen(false);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Query could not be starred privately");
    }
  };

  const starForTeam = async () => {
    if (!activeTab || !session) return;
    const title = starName.trim();
    if (!title) {
      setToast("Give this team star a name.");
      return;
    }
    const teamId = starTeam || session.user.teams[0]?.id || "";
    if (!teamId) {
      setToast("Join a team before starring a query.");
      return;
    }
    const payload: SharePayload = {
      query: editorRef.current?.executableQuery() ?? activeTab.query,
      sourceId: activeTab.sourceId,
      title,
      resultMode: activeTab.resultMode,
    };
    try {
      await createTeamQuery(teamId, starFolder, payload, session.csrfToken);
      await refreshStarLibrary();
      setSidebarMode("stars");
      setToast("Query starred for the team");
      setStarOpen(false);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Query could not be starred for the team");
    }
  };

  const activeSource = useMemo(() => session?.sources.find((source) => source.id === activeTab?.sourceId), [activeTab?.sourceId, session]);

  if (sessionState.kind === "loading") return <Splash />;
  if (sessionState.kind === "signed-out") return <SignIn />;
  if (sessionState.kind === "error") return <FatalError message={sessionState.message} />;
  if (!session) return <Splash />;
  if (route === "admin-access") {
    return (
      <>
        <AccessManagementPage
          session={session}
          theme={theme}
          onTheme={setTheme}
          onBack={returnToExplorer}
          onMessage={setToast}
          onSessionChanged={refreshAccountData}
        />
        <div className="screenreader-status" aria-live="polite">{toast}</div>
        {toast && <div className="toast"><span>{toast}</span></div>}
      </>
    );
  }
  if (!activeTab) return <Splash />;

  const running = activeTab.status === "running";
  const stale = Boolean(activeTab.lastExecutedQuery && activeTab.query !== activeTab.lastExecutedQuery);
  const workbenchStyle = {
    "--editor-pane-size": `${editorPanePercent}fr`,
    "--results-pane-size": `${100 - editorPanePercent}fr`,
  } as CSSProperties;

  const startPaneResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const workbench = event.currentTarget.closest<HTMLElement>(".query-workbench");
    const editor = workbench?.querySelector<HTMLElement>(".editor-panel");
    const results = workbench?.querySelector<HTMLElement>(".results-panel");
    if (!editor || !results) return;
    paneResizeRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startEditorHeight: editor.getBoundingClientRect().height,
      totalHeight: editor.getBoundingClientRect().height + results.getBoundingClientRect().height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-panes");
    event.preventDefault();
  };

  const movePaneResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = paneResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const nextHeight = resize.startEditorHeight + event.clientY - resize.startY;
    setEditorPanePercent(clampEditorPanePercent((nextHeight / resize.totalHeight) * 100));
  };

  const stopPaneResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = paneResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    paneResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    document.body.classList.remove("resizing-panes");
  };

  const resizePaneWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let next = editorPanePercent;
    if (event.key === "ArrowUp") next -= 4;
    else if (event.key === "ArrowDown") next += 4;
    else if (event.key === "Home") next = MIN_EDITOR_PANE_PERCENT;
    else if (event.key === "End") next = MAX_EDITOR_PANE_PERCENT;
    else return;
    event.preventDefault();
    setEditorPanePercent(clampEditorPanePercent(next));
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand"><div className="brand-mark"><span /><span /><span /></div><div><strong>Vesta</strong><small>LOG EXPLORER</small></div></div>
        <div className="header-context"><span className="connection-pulse" />{activeSource?.name ?? "Unavailable source"}</div>
        <div className="header-actions">
          <button className="icon-button" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}</button>
          <button className="icon-button" aria-label="Change password" onClick={() => setPasswordOpen(true)}><KeyRound size={16} /></button>
          {session.user.isAdmin && <button className="icon-button" aria-label="Manage users, teams, and permissions" onClick={openAccessManagement}><Users size={16} /></button>}
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
          history={historyEntries}
          personalQueries={personalQueries}
          teamLibraries={teamLibraries}
          onRecall={recall}
          onOpenStar={openStar}
          onEditPersonalStar={editPersonalStar}
          onEditTeamStar={editTeamStar}
          onCreateFolder={openFolderDialog}
          onClearHistory={clearHistory}
        />

        <section className="query-workbench" style={workbenchStyle}>
          <div className="query-toolbar">
            <label className="compact-select"><span>Source</span><select value={activeTab.sourceId} onChange={(event) => setSource(event.target.value)} disabled={running}>{session.sources.map((source) => <option value={source.id} key={source.id}>{source.name}</option>)}</select><ChevronDown size={13} /></label>
            <div className="toolbar-divider" />
            <button className="primary-button" onClick={() => executeActive()} disabled={running || Boolean(activeTab.contextError)}><Play size={15} fill="currentColor" /> Run <kbd>⇧↵</kbd></button>
            <button className="toolbar-button danger" onClick={() => cancel(activeTab.id)} disabled={!running}><CircleStop size={15} /> Cancel</button>
            <div className="toolbar-spacer" />
            <div className="menu-wrap">
              <button
                className="toolbar-button"
                title="Save this query to your private or team stars"
                onClick={() => {
                  const opening = !starOpen;
                  setStarOpen(opening);
                  if (opening) {
                    setStarCollection("private");
                    setStarName("");
                  }
                  setShareOpen(false);
                  setExportOpen(false);
                }}
              >
                <Star size={15} fill={starOpen ? "currentColor" : "none"} /> Star <ChevronDown size={13} />
              </button>
              {starOpen && <div className="popover-menu star-popover">
                <div className="star-scope-tabs" role="tablist" aria-label="Star collection">
                  <button
                    id="private-star-tab"
                    type="button"
                    role="tab"
                    aria-selected={starCollection === "private"}
                    aria-controls="private-star-panel"
                    className={starCollection === "private" ? "active" : ""}
                    onClick={() => setStarCollection("private")}
                  >
                    <LockKeyhole size={14} /> Private
                  </button>
                  <button
                    id="team-star-tab"
                    type="button"
                    role="tab"
                    aria-selected={starCollection === "team"}
                    aria-controls="team-star-panel"
                    className={starCollection === "team" ? "active" : ""}
                    disabled={(session.user.teams ?? []).length === 0}
                    title={(session.user.teams ?? []).length === 0 ? "Join a team to use team stars" : "Save to a team collection"}
                    onClick={() => setStarCollection("team")}
                  >
                    <Users size={14} /> Team
                  </button>
                </div>
                <form
                  id={`${starCollection}-star-panel`}
                  className="star-popover-form"
                  role="tabpanel"
                  aria-labelledby={`${starCollection}-star-tab`}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!starName.trim()) return;
                    void (starCollection === "private" ? starPrivately() : starForTeam());
                  }}
                >
                  <div className="share-audience star-form-fields">
                    <label className="star-name-field">
                      <span>NAME</span>
                      <input autoFocus maxLength={256} required value={starName} onChange={(event) => setStarName(event.target.value)} placeholder="Name this starred query" />
                    </label>
                    {starCollection === "team" && <>
                      <label>
                        <span>TEAM</span>
                        <select value={starTeam} onChange={(event) => { setStarTeam(event.target.value); setStarFolder(""); }}>
                          {(session.user.teams ?? []).map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
                        </select>
                      </label>
                      <label>
                        <span>FOLDER</span>
                        <select value={starFolder} onChange={(event) => setStarFolder(event.target.value)}>
                          <option value="">No folder</option>
                          {(teamLibraries.find((library) => library.team.id === starTeam)?.folders ?? []).map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}
                        </select>
                      </label>
                    </>}
                    <small>{starCollection === "private" ? "Only you can view and reuse this star." : "Every authorized team member can view and reuse this star."}</small>
                  </div>
                  <button className="star-submit" type="submit" disabled={!starName.trim()}>
                    {starCollection === "private" ? <LockKeyhole size={15} /> : <Users size={15} />}
                    <span><strong>{starCollection === "private" ? "Save private star" : "Save team star"}</strong></span>
                  </button>
                </form>
              </div>}
            </div>
            <div className="menu-wrap">
              <button className="toolbar-button" onClick={openShareMenu}><Share2 size={15} /> Share <ChevronDown size={13} /></button>
              {shareOpen && <div className="popover-menu share-popover">
                <form onSubmit={(event) => { event.preventDefault(); void copySelectedShare(); }}>
                  <div className="share-popover-heading">
                    <strong>Choose what to copy</strong>
                    <small>Combine any of these in one share.</small>
                  </div>
                  <fieldset className="share-options">
                    <legend>INCLUDE</legend>
                    <label className={shareParts.link ? "active" : ""}>
                      <input type="checkbox" checked={shareParts.link} onChange={() => toggleSharePart("link")} />
                      <Share2 size={15} />
                      <span><strong>Link</strong><small>Opens in Vesta</small></span>
                    </label>
                    <label className={shareParts.query ? "active" : ""}>
                      <input type="checkbox" checked={shareParts.query} onChange={() => toggleSharePart("query")} />
                      <Braces size={15} />
                      <span><strong>Query</strong><small>LogsQL text</small></span>
                    </label>
                    <label className={shareParts.results ? "active" : ""}>
                      <input type="checkbox" checked={shareParts.results} disabled={activeTab.rows.length === 0} onChange={() => toggleSharePart("results")} />
                      <Copy size={15} />
                      <span><strong>Results</strong><small>{activeTab.rows.length === 0 ? "Run query first" : activeTab.resultMode === "chart" ? "Chart + source data" : `${activeTab.rows.length.toLocaleString()} rows`}</small></span>
                    </label>
                  </fieldset>
                  <div className="share-access-note"><Users size={14} /><span><strong>Available to signed-in users</strong><small>Source permissions still apply.</small></span></div>
                  <button className="share-submit" type="submit" disabled={!Object.values(shareParts).some(Boolean)}>
                    <Copy size={15} /><span><strong>Copy selected</strong><small>Rich format with Markdown fallback</small></span>
                  </button>
                </form>
              </div>}
            </div>
            <div className="menu-wrap">
              <button className="icon-button" aria-label="Download results" onClick={() => { setExportOpen(!exportOpen); setShareOpen(false); setStarOpen(false); }} disabled={activeTab.rows.length === 0}><Download size={16} /></button>
              {exportOpen && <div className="popover-menu compact"><button onClick={() => download("csv")}><Table2 size={15} /> CSV</button><button onClick={() => download("ndjson")}><FileJson size={15} /> NDJSON</button></div>}
            </div>
          </div>

          <div className="notices">
            {activeTab.protected && <div className="protected-banner"><Share2 size={16} /><span><strong>Shared query.</strong> Review the LogsQL and context, then choose Run explicitly.</span><button onClick={() => updateTab(activeTab.id, { protected: false })}><X size={14} /></button></div>}
            {activeTab.contextError && <div className="error-banner"><X size={16} /><span>{activeTab.contextError}</span></div>}
          </div>

          <div className="editor-panel" id="query-editor-panel">
            <div className="panel-caption"><span>LOGSQL</span><span>{hasTimeFilter(activeTab.query) ? <><i className="valid-dot" /> explicit time filter</> : <><i className="invalid-dot" /> _time: required</>}</span></div>
            <QueryEditor
              key={activeTab.id}
              ref={editorRef}
              value={activeTab.query}
              fields={EMPTY_EDITOR_FIELDS}
              dark={theme === "dark"}
              onChange={(query) => updateTab(activeTab.id, { query, error: undefined })}
              onRun={(query) => executeActive(query)}
            />
          </div>

          <div
            className="pane-resizer"
            role="separator"
            aria-label="Resize query editor and results"
            aria-controls="query-editor-panel query-results-panel"
            aria-orientation="horizontal"
            aria-valuemin={MIN_EDITOR_PANE_PERCENT}
            aria-valuemax={MAX_EDITOR_PANE_PERCENT}
            aria-valuenow={Math.round(editorPanePercent)}
            aria-valuetext={`${Math.round(editorPanePercent)}% editor height`}
            tabIndex={0}
            title="Drag to resize · Double-click to reset"
            onPointerDown={startPaneResize}
            onPointerMove={movePaneResize}
            onPointerUp={stopPaneResize}
            onPointerCancel={stopPaneResize}
            onLostPointerCapture={() => {
              paneResizeRef.current = null;
              document.body.classList.remove("resizing-panes");
            }}
            onDoubleClick={() => setEditorPanePercent(DEFAULT_EDITOR_PANE_PERCENT)}
            onKeyDown={resizePaneWithKeyboard}
          >
            <span />
          </div>

          <div className="results-panel" id="query-results-panel">
            <div className="results-header">
              <div className="result-tabs" role="tablist" aria-label="Result view">
                {activeVisualization && activeVisualization.visualization !== "table" && (
                  <button className={activeTab.resultMode === "chart" ? "active" : ""} onClick={() => updateTab(activeTab.id, { resultMode: "chart" })}>
                    <ChartNoAxesCombined size={14} /> Chart
                  </button>
                )}
                <button className={activeTab.resultMode === "table" ? "active" : ""} onClick={() => updateTab(activeTab.id, { resultMode: "table" })}><Table2 size={14} /> Table</button>
                <button className={activeTab.resultMode === "json" ? "active" : ""} onClick={() => updateTab(activeTab.id, { resultMode: "json" })}><Braces size={14} /> JSON</button>
              </div>
              <button
                className={`result-field-settings ${session.user.settings.hiddenResultFields.length > 0 ? "active" : ""}`}
                aria-label={`Edit hidden result fields (${session.user.settings.hiddenResultFields.length} hidden)`}
                title="Choose fields to hide from query results"
                onClick={() => {
                  setSettingsOpen(true);
                  setShareOpen(false);
                  setStarOpen(false);
                  setExportOpen(false);
                }}
              >
                <EyeOff size={13} />
                <span>Hidden fields</span>
                <strong>{session.user.settings.hiddenResultFields.length}</strong>
              </button>
              <div className="result-stats" aria-live="polite">
                {stale && <span className="stale-badge">Query changed since run</span>}
                <span className={`run-state ${activeTab.status}`}>{running && <i />} {activeTab.status}</span>
                <span>{(activeTab.stats?.rows ?? activeTab.rows.length).toLocaleString()} rows</span>
                {activeTab.stats && <><span>{humanBytes(activeTab.stats.bytes)}</span><span>{activeTab.stats.elapsedMs.toLocaleString()} ms</span></>}
              </div>
            </div>
            {activeTab.warning && <div className="warning-banner">{activeTab.warning}</div>}
            {activeTab.status === "truncated" && <div className="warning-banner"><strong>Result truncated.</strong> {activeTab.stats?.reason}</div>}
            {activeTab.error && <div className="error-banner"><X size={15} /><span>{activeTab.error}</span></div>}
            <ResultViewer
              rows={activeTab.rows}
              mode={activeTab.resultMode}
              query={activeTab.lastExecutedQuery || activeTab.query}
              visualization={activeVisualization}
              hiddenResultFields={session.user.settings.hiddenResultFields}
              onCopy={(value) => void copyText(value, "Value copied")}
            />
          </div>
        </section>
      </main>
      <div className="screenreader-status" aria-live="polite">{toast}</div>
      {toast && <div className="toast"><span>{toast}</span></div>}
      {folderDialogTeam && (
        <FolderDialog
          teamName={teamLibraries.find((library) => library.team.id === folderDialogTeam)?.team.name ?? "this team"}
          busy={folderCreating}
          error={folderCreateError}
          onClose={closeFolderDialog}
          onCreate={(name) => void createFolder(name)}
        />
      )}
      {passwordOpen && <PasswordPanel csrfToken={session.csrfToken} onClose={() => setPasswordOpen(false)} onMessage={setToast} />}
      {settingsOpen && (
        <ResultSettingsPanel
          settings={session.user.settings}
          csrfToken={session.csrfToken}
          onClose={() => setSettingsOpen(false)}
          onMessage={setToast}
          onSaved={(settings) => setSessionState((current) => current.kind === "ready"
            ? { kind: "ready", session: { ...current.session, user: { ...current.session.user, settings } } }
            : current)}
        />
      )}
    </div>
  );
}

function Splash() {
  return <div className="center-screen"><div className="brand-mark large"><span /><span /><span /></div><h1>Vesta</h1><p>Opening your LogsQL workspace…</p><div className="loading-line"><i /></div></div>;
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      if (window.location.hash) sessionStorage.setItem("vesta:return-hash", window.location.hash);
      await login(email, password);
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign in failed");
      setBusy(false);
    }
  };

  return (
    <div className="center-screen signin">
      <div className="brand-mark large"><span /><span /><span /></div>
      <span className="eyebrow">VICTORIALOGS EXPLORER</span>
      <h1>Your logs, queried as written.</h1>
      <p>Sign in with the local account stored in this Vesta instance.</p>
      <form className="signin-form" onSubmit={(event) => void submit(event)}>
        <label><span>Email</span><input required autoComplete="username" type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label><span>Password</span><input required autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {message && <div className="signin-error">{message}</div>}
        <button className="primary-button large-button" disabled={busy}><Play size={16} /> {busy ? "Signing in…" : "Sign in"}</button>
      </form>
      <small>Users, passwords, teams, folders, stars, and share links are stored in SQLite.</small>
    </div>
  );
}

function FatalError({ message }: { message: string }) {
  return <div className="center-screen"><div className="error-symbol">!</div><h1>Vesta could not start</h1><p>{message}</p><button className="toolbar-button" onClick={() => window.location.reload()}><History size={15} /> Try again</button></div>;
}
