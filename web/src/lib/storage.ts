import { createStore, del, get, set } from "idb-keyval";
import type { HistoryEntry, PersistedTab } from "../types";

const store = createStore("vesta-workspace", "workspace");
const TABS_KEY = "tabs-v1";
const HISTORY_KEY = "history-v1";
const ACTIVE_KEY = "active-tab-v1";

export async function loadWorkspace(): Promise<{ tabs: PersistedTab[]; history: HistoryEntry[]; activeId?: string }> {
  const [tabs, history, activeId] = await Promise.all([
    get<PersistedTab[]>(TABS_KEY, store),
    get<HistoryEntry[]>(HISTORY_KEY, store),
    get<string>(ACTIVE_KEY, store),
  ]);
  return { tabs: tabs ?? [], history: history ?? [], activeId };
}

export async function saveWorkspace(tabs: PersistedTab[], history: HistoryEntry[], activeId: string): Promise<void> {
  await Promise.all([
    set(TABS_KEY, tabs, store),
    set(HISTORY_KEY, history.slice(0, 100), store),
    set(ACTIVE_KEY, activeId, store),
  ]);
}

export async function clearHistory(): Promise<void> {
  await del(HISTORY_KEY, store);
}

