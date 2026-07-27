import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface MemoryStorage extends Storage {
  values: Record<string, string>;
}

function installMemoryStorage(): MemoryStorage {
  const values: Record<string, string> = {};
  const storage: MemoryStorage = {
    values,
    get length() {
      return Object.keys(values).length;
    },
    clear: () => {
      for (const key of Object.keys(values)) delete values[key];
    },
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = String(value);
    },
    removeItem: (key) => {
      delete values[key];
    },
    key: (index) => Object.keys(values)[index] ?? null,
  };
  globalThis.localStorage = storage;
  return storage;
}

let memoryStorage = installMemoryStorage();

beforeEach(() => {
  memoryStorage = installMemoryStorage();
  vi.resetModules();
});

async function loadCacheAtoms() {
  const sessionView = await import("@src/store/session/viewAtom");
  const cache = await import("../editorCache");
  return {
    workstationActiveSessionIdAtom: sessionView.workstationActiveSessionIdAtom,
    editorCacheAtom: cache.editorCacheAtom,
    activeEditorRepoAtom: cache.activeEditorRepoAtom,
    activeRepoCacheAtom: cache.activeRepoCacheAtom,
    editorCacheSizeAtom: cache.editorCacheSizeAtom,
    saveRepoCacheAtom: cache.saveRepoCacheAtom,
    clearAllEditorCacheAtom: cache.clearAllEditorCacheAtom,
  };
}

function fileTab(id: string) {
  return {
    id,
    type: "file" as const,
    title: id,
    data: { filePath: `/${id}.ts` },
  };
}

describe("editor repo cache workspace scoping", () => {
  it("keeps the same repo independent in session A and B", async () => {
    const atoms = await loadCacheAtoms();
    const store = createStore();

    store.set(atoms.workstationActiveSessionIdAtom, "session-a");
    store.set(atoms.activeEditorRepoAtom, "/repo");
    store.set(atoms.saveRepoCacheAtom, {
      repoPath: "/repo",
      fileTabs: [fileTab("a")],
      activeFileTabId: "a",
      lastAccessedAt: 1,
    });

    store.set(atoms.workstationActiveSessionIdAtom, "session-b");
    expect(store.get(atoms.activeEditorRepoAtom)).toBeNull();
    expect(store.get(atoms.editorCacheAtom)["/repo"]).toBeUndefined();

    store.set(atoms.activeEditorRepoAtom, "/repo");
    store.set(atoms.saveRepoCacheAtom, {
      repoPath: "/repo",
      fileTabs: [fileTab("b")],
      activeFileTabId: "b",
      lastAccessedAt: 2,
    });

    expect(
      store.get(atoms.activeRepoCacheAtom)?.fileTabs.map((tab) => tab.id)
    ).toEqual(["b"]);

    store.set(atoms.workstationActiveSessionIdAtom, "session-a");
    expect(store.get(atoms.activeEditorRepoAtom)).toBe("/repo");
    expect(
      store.get(atoms.activeRepoCacheAtom)?.fileTabs.map((tab) => tab.id)
    ).toEqual(["a"]);
    expect(store.get(atoms.editorCacheSizeAtom)).toBe(1);
  });

  it("keeps Global Workspace independent from session workspaces", async () => {
    const atoms = await loadCacheAtoms();
    const store = createStore();

    store.set(atoms.saveRepoCacheAtom, {
      repoPath: "/repo",
      fileTabs: [fileTab("global")],
      activeFileTabId: "global",
      lastAccessedAt: 1,
    });
    store.set(atoms.workstationActiveSessionIdAtom, "session-a");

    expect(store.get(atoms.editorCacheAtom)).toEqual({});

    store.set(atoms.workstationActiveSessionIdAtom, null);
    expect(store.get(atoms.editorCacheAtom)["/repo"]?.activeFileTabId).toBe(
      "global"
    );
  });

  it("clear all only clears the currently presented workspace", async () => {
    const atoms = await loadCacheAtoms();
    const store = createStore();

    store.set(atoms.workstationActiveSessionIdAtom, "session-a");
    store.set(atoms.saveRepoCacheAtom, {
      repoPath: "/repo",
      fileTabs: [fileTab("a")],
      activeFileTabId: "a",
      lastAccessedAt: 1,
    });
    store.set(atoms.workstationActiveSessionIdAtom, "session-b");
    store.set(atoms.saveRepoCacheAtom, {
      repoPath: "/repo",
      fileTabs: [fileTab("b")],
      activeFileTabId: "b",
      lastAccessedAt: 1,
    });

    store.set(atoms.clearAllEditorCacheAtom);
    expect(store.get(atoms.editorCacheAtom)).toEqual({});

    store.set(atoms.workstationActiveSessionIdAtom, "session-a");
    expect(store.get(atoms.editorCacheAtom)["/repo"]?.activeFileTabId).toBe(
      "a"
    );
  });

  it("seeds legacy v2 cache and active repo into Global Workspace only", async () => {
    memoryStorage.setItem(
      "orgii-v2-editor-cache",
      JSON.stringify({
        "/legacy": {
          repoPath: "/legacy",
          fileTabs: [fileTab("legacy")],
          activeFileTabId: "legacy",
          lastAccessedAt: 1,
        },
      })
    );
    memoryStorage.setItem("orgii-v2-active-repo", JSON.stringify("/legacy"));

    const atoms = await loadCacheAtoms();
    const store = createStore();

    expect(store.get(atoms.activeEditorRepoAtom)).toBe("/legacy");
    expect(store.get(atoms.editorCacheAtom)["/legacy"]?.activeFileTabId).toBe(
      "legacy"
    );

    store.set(atoms.workstationActiveSessionIdAtom, "session-a");
    expect(store.get(atoms.activeEditorRepoAtom)).toBeNull();
    expect(store.get(atoms.editorCacheAtom)).toEqual({});
  });
});
