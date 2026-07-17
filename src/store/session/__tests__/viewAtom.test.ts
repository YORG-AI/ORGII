import { createStore } from "jotai/vanilla";
import { beforeEach, vi } from "vitest";

const STORAGE_KEY = "orgii-v2-session-view";

type StorageMap = Record<string, string>;

function installMemoryStorage(
  target: "localStorage" | "sessionStorage"
): StorageMap {
  const store: StorageMap = {};
  const mock: Storage = {
    get length() {
      return Object.keys(store).length;
    },
    clear: () => {
      for (const key of Object.keys(store)) delete store[key];
    },
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
  (globalThis as unknown as Record<typeof target, Storage>)[target] = mock;
  return store;
}

let memoryStore: StorageMap = installMemoryStorage("localStorage");
installMemoryStorage("sessionStorage");

beforeEach(() => {
  memoryStore = installMemoryStorage("localStorage");
  installMemoryStorage("sessionStorage");
  vi.resetModules();
});

async function loadAtoms() {
  // `jumpToSessionAtom` calls `markSessionVisited`, which reads the
  // global instrumented Jotai store. Tests don't render the AppShell
  // (which would normally bootstrap it), so we need to call
  // `createInstrumentedStore()` first to satisfy that dependency.
  // Each `vi.resetModules()` invalidates the cached module so we
  // re-bootstrap inside `loadAtoms`.
  const { createInstrumentedStore } =
    await import("@src/util/core/state/instrumentedStore");
  createInstrumentedStore();
  const mod = await import("../viewAtom");
  const repoAtoms = await import("@src/store/repo/atoms");
  const repoDerived = await import("@src/store/repo/derived");
  const sessionCoreMetadata =
    await import("@src/engines/SessionCore/core/atoms/metadata");
  const sessionAtoms = await import("@src/store/session/sessionAtom/atoms");
  const workspaceAtoms = await import("@src/store/ui/workspaceFoldersAtom");
  return {
    sessionViewAtom: mod.sessionViewAtom,
    activeSessionIdAtom: mod.activeSessionIdAtom,
    workstationActiveSessionIdAtom: mod.workstationActiveSessionIdAtom,
    claimPipelineSessionAtom: mod.claimPipelineSessionAtom,
    jumpToSessionAtom: mod.jumpToSessionAtom,
    openSessionAtom: mod.openSessionAtom,
    closeSessionAtom: mod.closeSessionAtom,
    sessionReloadEpochMapAtom: sessionCoreMetadata.sessionReloadEpochMapAtom,
    loadStatusAtom: sessionCoreMetadata.loadStatusAtom,
    reposAtom: repoAtoms.reposAtom,
    selectedRepoIdAtom: repoAtoms.selectedRepoIdAtom,
    lastUsedRepoAtom: repoAtoms.lastUsedRepoAtom,
    sessionRepoHintAtom: repoDerived.sessionRepoHintAtom,
    sessionsAtom: sessionAtoms.sessionsAtom,
    activeFolderIdAtom: workspaceAtoms.activeFolderIdAtom,
    workspaceFoldersAtom: workspaceAtoms.workspaceFoldersAtom,
  };
}

describe("sessionViewAtom cold-start hydration", () => {
  it("exposes null activeSessionId by default", async () => {
    const { activeSessionIdAtom } = await loadAtoms();
    const store = createStore();
    expect(store.get(activeSessionIdAtom)).toBeNull();
  });

  it("ignores persisted activeSessionId from a previous app run", async () => {
    memoryStore[STORAGE_KEY] = JSON.stringify({
      activeSessionId: "osagent-stale-from-last-run",
      sessionName: "Stale",
      repoPath: undefined,
    });

    const { activeSessionIdAtom, sessionViewAtom } = await loadAtoms();
    const store = createStore();
    const view = store.get(sessionViewAtom);
    const activeId = store.get(activeSessionIdAtom);

    expect(activeId).toBeNull();
    expect(view.activeSessionId).toBeNull();
  });

  it("still restores sessionName and repoPath from persisted state", async () => {
    memoryStore[STORAGE_KEY] = JSON.stringify({
      activeSessionId: "osagent-stale",
      sessionName: "Earlier label",
      repoPath: "/tmp/repo",
    });

    const { sessionViewAtom } = await loadAtoms();
    const store = createStore();
    const view = store.get(sessionViewAtom);

    expect(view.sessionName).toBe("Earlier label");
    expect(view.repoPath).toBe("/tmp/repo");
  });

  it("supports explicit user action writes after cold start", async () => {
    const { activeSessionIdAtom } = await loadAtoms();
    const store = createStore();
    store.set(activeSessionIdAtom, "cliagent-just-opened");
    expect(store.get(activeSessionIdAtom)).toBe("cliagent-just-opened");
  });
});

// ---------------------------------------------------------------------------
// Two-atom dual-write semantics
// ---------------------------------------------------------------------------
//
// Every "WorkStation owner" action must update both
// `workstationActiveSessionIdAtom` (the persisted memory) AND
// `activeSessionIdAtom` (the transient pipeline) in lockstep. If either of
// these tests ever fails, a kanban (or other secondary) surface that
// claims the pipeline alone will permanently hijack what WorkStation
// shows on its next visible frame — the exact regression the split was
// introduced to prevent.
// ---------------------------------------------------------------------------

describe("jumpToSessionAtom", () => {
  it("writes both workstation memory and pipeline atoms (string payload)", async () => {
    const {
      jumpToSessionAtom,
      activeSessionIdAtom,
      workstationActiveSessionIdAtom,
    } = await loadAtoms();
    const store = createStore();

    store.set(jumpToSessionAtom, "osagent-target");

    expect(store.get(workstationActiveSessionIdAtom)).toBe("osagent-target");
    expect(store.get(activeSessionIdAtom)).toBe("osagent-target");
  });

  it("bumps reload epoch when jumping to the already-active pipeline session", async () => {
    const {
      jumpToSessionAtom,
      activeSessionIdAtom,
      sessionReloadEpochMapAtom,
    } = await loadAtoms();
    const store = createStore();

    store.set(activeSessionIdAtom, "osagent-current");

    store.set(jumpToSessionAtom, "osagent-current");

    expect(store.get(activeSessionIdAtom)).toBe("osagent-current");
    expect(store.get(sessionReloadEpochMapAtom).get("osagent-current")).toBe(1);
  });

  it("clears both atoms when jumping to null", async () => {
    const {
      jumpToSessionAtom,
      activeSessionIdAtom,
      workstationActiveSessionIdAtom,
      sessionViewAtom,
    } = await loadAtoms();
    const store = createStore();

    store.set(sessionViewAtom, {
      activeSessionId: "previously-active",
      sessionName: undefined,
      repoPath: undefined,
    });
    store.set(activeSessionIdAtom, "previously-active");

    store.set(jumpToSessionAtom, null);

    expect(store.get(workstationActiveSessionIdAtom)).toBeNull();
    expect(store.get(activeSessionIdAtom)).toBeNull();
  });

  it("accepts rich payload to fold name + repoPath into a single write", async () => {
    const { jumpToSessionAtom, sessionViewAtom, activeSessionIdAtom } =
      await loadAtoms();
    const store = createStore();

    store.set(jumpToSessionAtom, {
      sessionId: "osagent-rich",
      sessionName: "Refactor pass",
      repoPath: "/repos/orgii",
    });

    const view = store.get(sessionViewAtom);
    expect(view.activeSessionId).toBe("osagent-rich");
    expect(view.sessionName).toBe("Refactor pass");
    expect(view.repoPath).toBe("/repos/orgii");
    expect(store.get(activeSessionIdAtom)).toBe("osagent-rich");
  });

  it("preserves existing sessionName/repoPath when called with bare string", async () => {
    const { jumpToSessionAtom, sessionViewAtom } = await loadAtoms();
    const store = createStore();

    store.set(sessionViewAtom, {
      activeSessionId: "first",
      sessionName: "Existing label",
      repoPath: "/repos/keep-me",
    });

    store.set(jumpToSessionAtom, "second");

    const view = store.get(sessionViewAtom);
    expect(view.activeSessionId).toBe("second");
    expect(view.sessionName).toBe("Existing label");
    expect(view.repoPath).toBe("/repos/keep-me");
  });

  it("does not switch My Station repo when selected session belongs to another repo", async () => {
    const {
      jumpToSessionAtom,
      reposAtom,
      selectedRepoIdAtom,
      lastUsedRepoAtom,
      sessionsAtom,
      sessionRepoHintAtom,
    } = await loadAtoms();
    const store = createStore();

    store.set(reposAtom, [
      {
        id: "repo-current",
        name: "Current",
        path: "/repos/current",
        kind: "git",
      },
      {
        id: "repo-session",
        name: "Session Repo",
        path: "/repos/session",
        kind: "git",
      },
    ]);
    store.set(selectedRepoIdAtom, "repo-current");
    store.set(lastUsedRepoAtom, "repo-current");
    store.set(sessionsAtom, [
      {
        session_id: "session-in-other-repo",
        status: "running",
        created_at: "2026-07-09T00:00:00.000Z",
        updated_at: "2026-07-09T00:00:00.000Z",
        repoPath: "/repos/session",
      },
    ]);

    store.set(jumpToSessionAtom, {
      sessionId: "session-in-other-repo",
      sessionName: "Other repo work",
      repoPath: "/repos/session",
    });

    expect(store.get(selectedRepoIdAtom)).toBe("repo-current");
    expect(store.get(lastUsedRepoAtom)).toBe("repo-current");
    expect(store.get(sessionRepoHintAtom)).toEqual({
      type: "repo",
      repoId: "repo-session",
      repoName: "Session Repo",
    });
  });

  it("does not switch active workspace folder when selected session belongs to another folder", async () => {
    const {
      jumpToSessionAtom,
      reposAtom,
      selectedRepoIdAtom,
      sessionsAtom,
      sessionRepoHintAtom,
      activeFolderIdAtom,
      workspaceFoldersAtom,
    } = await loadAtoms();
    const store = createStore();

    store.set(reposAtom, [
      {
        id: "repo-current",
        name: "Current",
        path: "/repos/current",
        kind: "git",
      },
      {
        id: "repo-session",
        name: "Session Repo",
        path: "/repos/session",
        kind: "git",
      },
    ]);
    store.set(selectedRepoIdAtom, "repo-current");
    store.set(workspaceFoldersAtom, [
      {
        id: "folder-current",
        name: "Current",
        path: "/repos/current",
        uri: "file:///repos/current",
        repoId: "repo-current",
        isPrimary: true,
      },
      {
        id: "folder-session",
        name: "Session Folder",
        path: "/repos/session",
        uri: "file:///repos/session",
        repoId: "repo-session",
        isPrimary: false,
      },
    ]);
    store.set(activeFolderIdAtom, "folder-current");
    store.set(sessionsAtom, [
      {
        session_id: "session-in-other-folder",
        status: "running",
        created_at: "2026-07-09T00:00:00.000Z",
        updated_at: "2026-07-09T00:00:00.000Z",
        repoPath: "/repos/session",
      },
    ]);

    store.set(jumpToSessionAtom, {
      sessionId: "session-in-other-folder",
      sessionName: "Other folder work",
      repoPath: "/repos/session",
    });

    expect(store.get(activeFolderIdAtom)).toBe("folder-current");
    expect(store.get(selectedRepoIdAtom)).toBe("repo-current");
    expect(store.get(sessionRepoHintAtom)).toEqual({
      type: "folder",
      folderId: "folder-session",
      folderName: "Session Repo",
      repoId: "repo-session",
    });
  });
});

describe("claimPipelineSessionAtom", () => {
  it("loads a secondary session without changing WorkStation memory", async () => {
    const {
      activeSessionIdAtom,
      claimPipelineSessionAtom,
      loadStatusAtom,
      sessionViewAtom,
      workstationActiveSessionIdAtom,
    } = await loadAtoms();
    const store = createStore();

    store.set(sessionViewAtom, {
      activeSessionId: "osagent-workstation",
      sessionName: "Primary work",
      repoPath: "/repos/primary",
    });

    store.set(
      claimPipelineSessionAtom,
      "claudecodeapp-48238728-ab4f-4697-850d-459b12e03e72"
    );

    expect(store.get(activeSessionIdAtom)).toBe(
      "claudecodeapp-48238728-ab4f-4697-850d-459b12e03e72"
    );
    expect(store.get(loadStatusAtom)).toBe("loading");
    expect(store.get(workstationActiveSessionIdAtom)).toBe(
      "osagent-workstation"
    );
  });

  it("bumps reload epoch when reclaiming the current pipeline session", async () => {
    const {
      activeSessionIdAtom,
      claimPipelineSessionAtom,
      sessionReloadEpochMapAtom,
    } = await loadAtoms();
    const store = createStore();

    store.set(activeSessionIdAtom, "claudecodeapp-history");
    store.set(claimPipelineSessionAtom, "claudecodeapp-history");

    expect(store.get(activeSessionIdAtom)).toBe("claudecodeapp-history");
    expect(
      store.get(sessionReloadEpochMapAtom).get("claudecodeapp-history")
    ).toBe(1);
  });
});

describe("openSessionAtom", () => {
  it("writes workstation memory and pipeline + carries metadata", async () => {
    const {
      openSessionAtom,
      activeSessionIdAtom,
      workstationActiveSessionIdAtom,
      sessionViewAtom,
    } = await loadAtoms();
    const store = createStore();

    store.set(openSessionAtom, {
      sessionId: "cliagent-open",
      sessionName: "Code review",
      repoPath: "/repos/x",
    });

    expect(store.get(workstationActiveSessionIdAtom)).toBe("cliagent-open");
    expect(store.get(activeSessionIdAtom)).toBe("cliagent-open");
    const view = store.get(sessionViewAtom);
    expect(view.sessionName).toBe("Code review");
    expect(view.repoPath).toBe("/repos/x");
  });
});

describe("closeSessionAtom", () => {
  it("clears both workstation memory and pipeline", async () => {
    const {
      closeSessionAtom,
      sessionViewAtom,
      activeSessionIdAtom,
      workstationActiveSessionIdAtom,
    } = await loadAtoms();
    const store = createStore();

    store.set(sessionViewAtom, {
      activeSessionId: "to-be-closed",
      sessionName: "Doomed",
      repoPath: "/repos/x",
    });
    store.set(activeSessionIdAtom, "to-be-closed");

    store.set(closeSessionAtom);

    expect(store.get(workstationActiveSessionIdAtom)).toBeNull();
    expect(store.get(activeSessionIdAtom)).toBeNull();
    const view = store.get(sessionViewAtom);
    expect(view.sessionName).toBeUndefined();
    expect(view.repoPath).toBeUndefined();
  });
});

describe("pipeline / memory independence", () => {
  it("a pipeline-only write does NOT touch workstation memory", async () => {
    // This is the *key invariant* enabling kanban detail panels (and
    // any other secondary surface) to claim the live event stream
    // without permanently changing what WorkStation will show next.
    const { activeSessionIdAtom, workstationActiveSessionIdAtom } =
      await loadAtoms();
    const store = createStore();

    // Cold start: both null. Write pipeline only.
    store.set(activeSessionIdAtom, "kanban-clicked-session");

    expect(store.get(activeSessionIdAtom)).toBe("kanban-clicked-session");
    expect(store.get(workstationActiveSessionIdAtom)).toBeNull();
  });

  it("a memory-only write does NOT touch pipeline", async () => {
    const {
      activeSessionIdAtom,
      workstationActiveSessionIdAtom,
      sessionViewAtom,
    } = await loadAtoms();
    const store = createStore();

    store.set(workstationActiveSessionIdAtom, "stored-by-bridge");

    expect(store.get(workstationActiveSessionIdAtom)).toBe("stored-by-bridge");
    expect(store.get(sessionViewAtom).activeSessionId).toBe("stored-by-bridge");
    // Pipeline untouched — stays null until a chat surface or the
    // WorkStation bridge effect re-asserts it.
    expect(store.get(activeSessionIdAtom)).toBeNull();
  });
});
