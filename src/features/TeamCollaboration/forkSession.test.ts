import { exists } from "@tauri-apps/plugin-fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { deleteSession, saveSession } from "@src/api/tauri/agent";
import Message from "@src/components/Message";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { org2CloudAccessSettingsAtom } from "@src/features/Org2Cloud/org2CloudAccessSettings";
import { org2CloudOrgsAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { COLLAB_IDENTITY_KIND } from "@src/store/collaboration/types";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { reposAtom } from "@src/store/repo";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type {
  Session,
  SessionForkedFrom,
} from "@src/store/session/sessionAtom/types";
import { createInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { forkCheckoutRequestAtom } from "./components/ForkCheckoutPickerDialog";
import { forkSessionSetupRequestAtom } from "./components/ForkSessionSetupDialog";
import { forkSession } from "./engine/collabSyncEngineHelpers";
import type { ForkSessionResult } from "./engine/collabSyncEngineHelpers";
import {
  ForkCancelledError,
  __FORK_RELAY_INTERNALS,
  buildForkHandoffPrompt,
  buildPendingForkHandoff,
  forkTeammateSession,
  getSessionForkedFrom,
  markForkHandoffConsumed,
  resolveForkWorkspacePath,
} from "./forkSession";
import {
  resolveLocalCheckoutForScopeKey,
  resolveMatchingOrgRepoScope,
  resolveShareableScopeKeys,
} from "./repoScopeResolver";
import { sessionOrgTagsAtom, tokensForSession } from "./sessionOrgTagsAtom";

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    clear: vi.fn(),
    getPersistedEvents: vi.fn(),
  },
}));

vi.mock("@src/api/tauri/agent", () => ({
  deleteSession: vi.fn(),
  saveSession: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(),
}));

vi.mock("./engine/collabSyncEngineHelpers", () => ({
  forkSession: vi.fn(),
}));

// Local-checkout resolution rides git-remote IPC in production; mocked so
// workspace-resolution behavior is deterministic per test.
vi.mock("./repoScopeResolver", () => ({
  resolveLocalCheckoutForScopeKey: vi.fn(async () => null),
  resolveMatchingOrgRepoScope: vi.fn(
    async (repoScopeKeys: string[] | null | undefined, orgScopes: string[]) =>
      orgScopes.find((scope) => repoScopeKeys?.includes(scope)) ?? null
  ),
  resolveShareableScopeKeys: vi.fn(async () => []),
}));

vi.mock("@src/components/Message", () => ({
  default: {
    info: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@src/i18n", () => ({
  default: { t: (key: string) => key },
}));

const eventStoreMock = vi.mocked(eventStoreProxy);
const deleteSessionMock = vi.mocked(deleteSession);
const saveSessionMock = vi.mocked(saveSession);
const forkSessionMock = vi.mocked(forkSession);
const resolveCheckoutMock = vi.mocked(resolveLocalCheckoutForScopeKey);
const resolveMatchingScopeMock = vi.mocked(resolveMatchingOrgRepoScope);
const resolveScopeKeysMock = vi.mocked(resolveShareableScopeKeys);
const messageMock = vi.mocked(Message);
const existsMock = vi.mocked(exists);

// forkTeammateSession reads repos/sessions (workspace candidates) and cloud
// orgs (auto-tag) from the global store.
const store = createInstrumentedStore();

const FORK_RESULT: ForkSessionResult = {
  localSessionId: "agentsession-fork-1",
  name: "⑂ Remote session",
  eventCount: 2,
};

function makeRemote(
  overrides: Partial<RemoteTeammateSessionMetadata> = {}
): RemoteTeammateSessionMetadata {
  return {
    id: "org-1:m2:remote-1",
    orgId: "org-1",
    ownerMemberId: "m2",
    ownerUserId: "m2",
    ownerDisplayName: "Bob",
    ownerIdentityKind: COLLAB_IDENTITY_KIND.HUMAN,
    sourceSessionId: "remote-1",
    title: "Remote session",
    repoPath: "/repo/shared",
    lastActivityAt: "2026-07-01T00:00:00.000Z",
    eventsEpoch: 1,
    eventsFrozenSeq: 1,
    eventsCount: 2,
    eventsTailHash: undefined,
    ...overrides,
  };
}

function makeForkOptions(
  overrides: Partial<RemoteTeammateSessionMetadata> = {}
) {
  return {
    client: { getSessionEventSegments: vi.fn() },
    orgId: "org-1",
    remoteSession: makeRemote(overrides),
    execution: {
      agentDefinitionId: "builtin:sde",
      accountId: "openai-local",
      model: "gpt-5.2-codex",
    },
  };
}

function makeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: "e1",
    sessionId: "agentsession-fork-1",
    createdAt: "2026-07-01T00:00:00.000Z",
    functionName: "assistant_message",
    actionType: "assistant",
    source: "assistant",
    displayText: "hello from the teammate",
    displayStatus: "completed",
    args: {},
    result: {},
    ...overrides,
  } as unknown as SessionEvent;
}

const FORKED_FROM: SessionForkedFrom = {
  orgId: "org-1",
  sourceSessionId: "remote-1",
  ownerMemberId: "m2",
  ownerDisplayName: "Bob",
  atCount: 2,
  forkedAt: "2026-07-02T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem(__FORK_RELAY_INTERNALS.FORK_RELAY_STORAGE_KEY);
  forkSessionMock.mockResolvedValue(FORK_RESULT);
  resolveCheckoutMock.mockResolvedValue(null);
  resolveMatchingScopeMock.mockImplementation(
    async (repoScopeKeys, orgScopes) =>
      orgScopes?.find((scope) => repoScopeKeys?.includes(scope)) ?? null
  );
  resolveScopeKeysMock.mockResolvedValue([]);
  existsMock.mockResolvedValue(true);
  saveSessionMock.mockResolvedValue(undefined);
  deleteSessionMock.mockResolvedValue({
    deletedSessionIds: ["agentsession-fork-1"],
  });
  eventStoreMock.clear.mockResolvedValue(undefined);
  eventStoreMock.getPersistedEvents.mockResolvedValue([]);
  store.set(sessionsAtom, []);
  store.set(reposAtom, []);
  store.set(org2CloudOrgsAtom, []);
  store.set(org2CloudAccessSettingsAtom, {});
  store.set(sessionOrgTagsAtom, {});
  store.set(forkCheckoutRequestAtom, null);
  store.set(forkSessionSetupRequestAtom, null);
});

describe("resolveForkWorkspacePath", () => {
  it("ignores stale imported paths and probes only checkouts that exist locally", async () => {
    store.set(sessionsAtom, [
      { session_id: "stale", repoPath: "/Users/owner/ORG2" } as Session,
      { session_id: "local", repoPath: "C:\\Repos\\ORGII" } as Session,
    ]);
    existsMock.mockImplementation(async (path) =>
      String(path).startsWith("C:\\Repos\\ORGII")
    );
    resolveCheckoutMock.mockImplementation(
      async (_scopeKey, candidates) => candidates[0] ?? null
    );

    await expect(
      resolveForkWorkspacePath(
        makeRemote({ repoScopeKey: "github.com/org2ai/ORG2" })
      )
    ).resolves.toBe("C:\\Repos\\ORGII");
    expect(resolveCheckoutMock).toHaveBeenCalledWith("github.com/org2ai/ORG2", [
      "C:\\Repos\\ORGII",
    ]);
  });

  it("does not treat a stale owner path as a same-machine checkout", async () => {
    store.set(sessionsAtom, [
      { session_id: "stale", repoPath: "/repo/shared" } as Session,
    ]);
    existsMock.mockResolvedValue(false);

    await expect(
      resolveForkWorkspacePath(makeRemote({ repoScopeKey: undefined }))
    ).resolves.toBeNull();
  });

  it("prefers an imported session's canonical repo root over its nested folder", async () => {
    store.set(sessionsAtom, [
      {
        session_id: "codexapp-nested",
        repoPath: "/repo/shared/src-tauri",
        repoRootPath: "/repo/shared",
      } as Session,
    ]);
    existsMock.mockResolvedValue(true);
    resolveCheckoutMock.mockImplementation(
      async (_scopeKey, candidates) => candidates[0] ?? null
    );

    await resolveForkWorkspacePath(
      makeRemote({ repoScopeKey: "github.com/org2ai/ORG2" })
    );

    expect(resolveCheckoutMock).toHaveBeenCalledWith("github.com/org2ai/ORG2", [
      "/repo/shared",
    ]);
  });
});

describe("forkTeammateSession (design §16.11 relay completion)", () => {
  it("waits for one explicit workspace/account/model setup before fetching the fork", async () => {
    const forkPromise = forkTeammateSession({
      ...makeForkOptions({ repoScopeKey: undefined }),
      promptForExecution: true,
    });
    const request = store.get(forkSessionSetupRequestAtom);
    expect(request).toMatchObject({
      sourceTitle: "Remote session",
    });
    expect(forkSessionMock).not.toHaveBeenCalled();

    request?.resolve({
      workspaceRepoPath: "/my/checkout/shared",
      execution: {
        agentDefinitionId: "builtin:sde",
        accountId: "openai-local",
        model: "gpt-5.2-codex",
      },
    });
    await forkPromise;

    expect(forkSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRepoPath: "/my/checkout/shared",
        execution: {
          agentDefinitionId: "builtin:sde",
          accountId: "openai-local",
          model: "gpt-5.2-codex",
        },
      })
    );
  });

  it("accepts a checkout from the same GitHub fork network during setup", async () => {
    resolveScopeKeysMock.mockResolvedValue(["github.com/org2ai/org2"]);
    resolveMatchingScopeMock.mockResolvedValue("github.com/vantanode/org2");

    const forkPromise = forkTeammateSession({
      ...makeForkOptions({ repoScopeKey: "github.com/vantanode/org2" }),
      promptForExecution: true,
    });
    store.get(forkSessionSetupRequestAtom)?.resolve({
      workspaceRepoPath: "C:\\Repos\\ORGII",
      execution: {
        agentDefinitionId: "builtin:sde",
        accountId: "openai-local",
        model: "gpt-5.2-codex",
      },
    });

    await forkPromise;

    expect(resolveMatchingScopeMock).toHaveBeenCalledWith(
      ["github.com/org2ai/org2"],
      ["github.com/vantanode/org2"]
    );
    expect(forkSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRepoPath: "C:\\Repos\\ORGII" })
    );
  });

  it("registers a REAL backend row so the fork is dispatchable and reload-proof", async () => {
    const result = await forkTeammateSession(makeForkOptions());

    expect(result).toEqual(FORK_RESULT);
    expect(saveSessionMock).toHaveBeenCalledTimes(1);
    const record = saveSessionMock.mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(record.sessionId).toBe("agentsession-fork-1");
    expect(record.name).toBe("⑂ Remote session");
    // The OWNER's absolute path (/repo/shared) is not a local checkout here
    // ⇒ the fork gets NO workspace rather than a dead foreign path, plus a
    // non-blocking hint.
    expect(record.workspacePath).toBeUndefined();
    expect(messageMock.info).toHaveBeenCalledWith(
      "navigation:collaboration.session.forkNoLocalCheckout"
    );
    // agentsession-* has no builtin prefix mapping in agent-core — the
    // persisted definition id is what makes the lazy init_session on the
    // first agent_send_message resolve an agent at all.
    expect(record.agentDefinitionId).toBe("builtin:sde");
    expect(record.orgId).toBe("org-1");
    // UnifiedSessionRecord requires session_type (passed via the SessionMeta
    // schema catchall); "sde" = coding session.
    expect(record.sessionType).toBe("sde");
  });

  it("asks the user to choose the LOCAL checkout for a repo-scoped fork", async () => {
    store.set(sessionsAtom, [
      { session_id: "s-local", repoPath: "/my/checkout/shared" } as Session,
    ]);
    resolveScopeKeysMock.mockResolvedValue(["github.com/acme/shared"]);

    const forkPromise = forkTeammateSession(
      makeForkOptions({ repoScopeKey: "github.com/acme/shared" })
    );
    const request = store.get(forkCheckoutRequestAtom);
    expect(request).not.toBeNull();
    request?.resolve("/my/checkout/shared");
    await forkPromise;

    // Eligibility is explicit: the picker chooses, then remotes are verified.
    expect(resolveCheckoutMock).not.toHaveBeenCalled();
    expect(resolveScopeKeysMock).toHaveBeenCalledWith("/my/checkout/shared");
    // The engine fork receives the override; the backend row matches it.
    expect(forkSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRepoPath: "/my/checkout/shared" })
    );
    const record = saveSessionMock.mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(record.workspacePath).toBe("/my/checkout/shared");
    expect(messageMock.info).not.toHaveBeenCalled();
  });

  it("keeps the owner's path when it IS one of our local paths (same-machine fallback)", async () => {
    // No scope key on the record (repo without a git remote), but the
    // owner's absolute path is a known local session workspace.
    store.set(sessionsAtom, [
      { session_id: "s-local", repoPath: "/repo/shared" } as Session,
    ]);

    await forkTeammateSession(makeForkOptions({ repoScopeKey: undefined }));

    expect(forkSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRepoPath: "/repo/shared" })
    );
    expect(messageMock.info).not.toHaveBeenCalled();
  });

  it("auto-tags a CLOUD-org fork back to the source org (relay closes the loop)", async () => {
    store.set(org2CloudOrgsAtom, [
      { orgId: "org-1", name: "Cloud Team", role: "member" },
    ]);

    await forkTeammateSession(makeForkOptions());

    // `cloud:`-prefixed token — the tag makes the forker's continuation push
    // back to the org regardless of local repo scope resolution.
    expect(
      tokensForSession(store.get(sessionOrgTagsAtom), "agentsession-fork-1")
    ).toEqual(["cloud:org-1"]);
  });

  it("inherits the SOURCE's sharing level as the fork's per-session intent", async () => {
    store.set(org2CloudOrgsAtom, [
      { orgId: "org-1", name: "Cloud Team", role: "member" },
    ]);

    await forkTeammateSession(makeForkOptions({ accessMode: "full_replay" }));

    // Without this stamp a fork in a floor=off org has no ladder entry,
    // floors to metadata_only on the wire, and teammates can never open
    // its replay — with no error anywhere.
    expect(
      store.get(org2CloudAccessSettingsAtom)["org-1"]?.sessionModes?.[
        "agentsession-fork-1"
      ]
    ).toBe("full_replay");
  });

  it("stamps no sharing level when the source row carries none", async () => {
    store.set(org2CloudOrgsAtom, [
      { orgId: "org-1", name: "Cloud Team", role: "member" },
    ]);

    await forkTeammateSession(makeForkOptions({ accessMode: undefined }));

    expect(
      store.get(org2CloudAccessSettingsAtom)["org-1"]?.sessionModes?.[
        "agentsession-fork-1"
      ]
    ).toBeUndefined();
  });

  it("NEVER auto-tags a GUEST (share-token) fork to the owner's org", async () => {
    store.set(org2CloudOrgsAtom, [
      { orgId: "org-1", name: "Cloud Team", role: "member" },
    ]);

    await forkTeammateSession({ ...makeForkOptions(), shareToken: "tok-1" });

    // A tag would make the guest continuation push back into the owner's
    // org — the fork must stay untagged (Personal) even when org-1 happens
    // to be in the local cloud-org list.
    expect(store.get(sessionOrgTagsAtom)).toEqual({});
    // The token reaches the engine fork (anon segments fetch + Personal).
    expect(forkSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ shareToken: "tok-1" })
    );
    expect(saveSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: undefined })
    );
  });

  it("GUEST fork still enforces the same-scope checkout gate (dismiss ⇒ cancelled)", async () => {
    const forkPromise = forkTeammateSession({
      ...makeForkOptions({ repoScopeKey: "github.com/acme/shared" }),
      shareToken: "tok-1",
    });
    const request = store.get(forkCheckoutRequestAtom);
    expect(request).not.toBeNull();
    expect(request?.sourceScopeKey).toBe("github.com/acme/shared");
    request?.resolve(null);

    await expect(forkPromise).rejects.toBeInstanceOf(ForkCancelledError);
    expect(forkSessionMock).not.toHaveBeenCalled();
    expect(saveSessionMock).not.toHaveBeenCalled();
  });

  it("GUEST fork rejects a picked checkout whose remotes do NOT match the source scope", async () => {
    resolveScopeKeysMock.mockResolvedValue(["github.com/other/repo"]);

    const forkPromise = forkTeammateSession({
      ...makeForkOptions({ repoScopeKey: "github.com/acme/shared" }),
      shareToken: "tok-1",
    });
    store.get(forkCheckoutRequestAtom)?.resolve("/my/checkout/other");

    await expect(forkPromise).rejects.toBeInstanceOf(ForkCancelledError);
    expect(forkSessionMock).not.toHaveBeenCalled();
  });

  it("does NOT tag self-hosted-org forks (the self-hosted engine ignores tags)", async () => {
    // org-1 is not a cloud org here ⇒ tagging would be a silent no-op, so
    // the residual is documented instead of papered over.
    await forkTeammateSession(makeForkOptions());
    expect(store.get(sessionOrgTagsAtom)).toEqual({});
  });

  it("records durable provenance readable through getSessionForkedFrom", async () => {
    await forkTeammateSession(makeForkOptions());

    // A bare backend-rebuilt row (no forkedFrom field — list reloads drop
    // TS-only fields) still resolves its provenance from the registry.
    const provenance = getSessionForkedFrom({
      session_id: "agentsession-fork-1",
    });
    expect(provenance).toMatchObject({
      orgId: "org-1",
      sourceSessionId: "remote-1",
      ownerMemberId: "m2",
      ownerDisplayName: "Bob",
      atCount: 2,
    });
  });

  it("prefers the live Session.forkedFrom field over the registry", async () => {
    await forkTeammateSession(makeForkOptions());
    const rowField: SessionForkedFrom = { ...FORKED_FROM, atCount: 99 };
    expect(
      getSessionForkedFrom({
        session_id: "agentsession-fork-1",
        forkedFrom: rowField,
      })
    ).toBe(rowField);
  });

  it("returns null (and registers nothing) when the engine fork has nothing to inherit", async () => {
    forkSessionMock.mockResolvedValueOnce(null);

    const result = await forkTeammateSession(makeForkOptions());

    expect(result).toBeNull();
    expect(saveSessionMock).not.toHaveBeenCalled();
    expect(
      getSessionForkedFrom({ session_id: "agentsession-fork-1" })
    ).toBeUndefined();
  });

  it("throws when backend registration fails and does NOT arm the handoff", async () => {
    saveSessionMock.mockRejectedValueOnce(new Error("ipc down"));
    store.set(sessionsAtom, [
      {
        session_id: "agentsession-fork-1",
        status: "completed",
        created_at: "2026-07-01T00:00:00.000Z",
        updated_at: "2026-07-01T00:00:00.000Z",
      },
    ]);

    await expect(forkTeammateSession(makeForkOptions())).rejects.toMatchObject({
      kind: "backend_registration",
      sourceSessionId: "remote-1",
      cause: expect.objectContaining({ message: "ipc down" }),
    });
    expect(deleteSessionMock).toHaveBeenCalledWith("agentsession-fork-1");
    expect(eventStoreMock.clear).toHaveBeenCalledWith("agentsession-fork-1");
    expect(store.get(sessionsAtom)).toEqual([]);
    // A fork that cannot be dispatched must not look armed/complete.
    expect(
      await buildPendingForkHandoff("agentsession-fork-1", "go on")
    ).toBeNull();
    expect(
      getSessionForkedFrom({ session_id: "agentsession-fork-1" })
    ).toBeUndefined();
  });

  it("persists the explicitly selected local account and model", async () => {
    forkSessionMock.mockResolvedValueOnce({
      ...FORK_RESULT,
      accountId: "openai-local",
      model: "gpt-5.2-codex",
    });

    await forkTeammateSession({
      ...makeForkOptions(),
      execution: {
        agentDefinitionId: "builtin:sde",
        accountId: "openai-local",
        model: "gpt-5.2-codex",
      },
    });

    expect(forkSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: {
          agentDefinitionId: "builtin:sde",
          accountId: "openai-local",
          model: "gpt-5.2-codex",
        },
      })
    );
    expect(saveSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "openai-local",
        model: "gpt-5.2-codex",
      })
    );
  });

  it("survives a corrupt registry payload (provenance is best-effort)", async () => {
    localStorage.setItem(
      __FORK_RELAY_INTERNALS.FORK_RELAY_STORAGE_KEY,
      "{not json"
    );
    const result = await forkTeammateSession(makeForkOptions());
    expect(result).toEqual(FORK_RESULT);
    expect(
      getSessionForkedFrom({ session_id: "agentsession-fork-1" })
    ).toBeDefined();
  });
});

describe("forkTeammateSession workspaceRepoPath key-presence (agent-pickup design §4)", () => {
  it("uses a provided path verbatim without probing the resolver", async () => {
    await forkTeammateSession({
      ...makeForkOptions(),
      workspaceRepoPath: "/picked/by/user",
    });

    // The runner dialog's pick-a-folder choice: already user-confirmed, so
    // no scope-key probe and no rewriting.
    expect(resolveCheckoutMock).not.toHaveBeenCalled();
    expect(forkSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRepoPath: "/picked/by/user" })
    );
    const record = saveSessionMock.mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(record.workspacePath).toBe("/picked/by/user");
    expect(messageMock.info).not.toHaveBeenCalled();
  });

  it("explicit undefined means fork WITHOUT a workspace — no resolver, no hint", async () => {
    await forkTeammateSession({
      ...makeForkOptions(),
      workspaceRepoPath: undefined,
    });

    expect(resolveCheckoutMock).not.toHaveBeenCalled();
    expect(forkSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRepoPath: null })
    );
    const record = saveSessionMock.mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(record.workspacePath).toBeUndefined();
    // The caller explicitly chose "run without workspace" (runner dialog) —
    // the "no local checkout found" hint would be misleading noise.
    expect(messageMock.info).not.toHaveBeenCalled();
  });

  it("explicit null behaves like explicit undefined (no workspace)", async () => {
    await forkTeammateSession({
      ...makeForkOptions(),
      workspaceRepoPath: null,
    });

    expect(resolveCheckoutMock).not.toHaveBeenCalled();
    expect(forkSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRepoPath: null })
    );
    expect(messageMock.info).not.toHaveBeenCalled();
  });

  it("an ABSENT key always asks the user to choose a verified checkout for a repo-scoped fork", async () => {
    store.set(sessionsAtom, [
      { session_id: "s-local", repoPath: "/my/checkout/shared" } as Session,
    ]);
    resolveCheckoutMock.mockResolvedValue("/my/checkout/shared");
    resolveScopeKeysMock.mockResolvedValue(["github.com/acme/shared"]);

    const forkPromise = forkTeammateSession(
      makeForkOptions({ repoScopeKey: "github.com/acme/shared" })
    );
    const request = store.get(forkCheckoutRequestAtom);
    expect(request).not.toBeNull();
    expect(request?.sourceScopeKey).toBe("github.com/acme/shared");
    request?.resolve("/my/checkout/shared");
    await forkPromise;

    // The pre-resolver must not silently pick a workspace: the dialog owns
    // the choice, then defense-in-depth remote verification checks it.
    expect(resolveCheckoutMock).not.toHaveBeenCalled();
    expect(forkSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceRepoPath: "/my/checkout/shared" })
    );
  });
});

describe("first-send handoff (LLM context continuity)", () => {
  it("wraps the first send with the inherited digest and keeps the user's words as displayText", async () => {
    await forkTeammateSession(makeForkOptions());
    eventStoreMock.getPersistedEvents.mockResolvedValue([
      makeEvent({
        id: "u1",
        source: "user",
        actionType: "user_message",
        displayText: "please fix the login bug",
      }),
      makeEvent({
        id: "t1",
        actionType: "tool_call",
        functionName: "edit_file",
        displayText: "",
        args: { text: "patch auth.ts" },
        result: { content: "file updated" },
      }),
    ]);

    const handoff = await buildPendingForkHandoff(
      "agentsession-fork-1",
      "continue where Bob left off"
    );

    expect(handoff).not.toBeNull();
    expect(handoff!.displayText).toBe("continue where Bob left off");
    expect(handoff!.content).toContain("taking over a teammate's shared");
    expect(handoff!.content).toContain("Original owner: Bob");
    expect(handoff!.content).toContain("User: please fix the login bug");
    expect(handoff!.content).toContain("Tool: edit_file");
    expect(handoff!.content).toContain("Input: patch auth.ts");
    expect(handoff!.content).toContain("Result at that time: file updated");
    expect(handoff!.content).toContain("continue where Bob left off");
  });

  it("is one-shot: consumed after a successful send, durable until then", async () => {
    await forkTeammateSession(makeForkOptions());

    // Not consumed yet — a failed send may retry with the handoff intact.
    expect(
      await buildPendingForkHandoff("agentsession-fork-1", "first try")
    ).not.toBeNull();
    expect(
      await buildPendingForkHandoff("agentsession-fork-1", "retry")
    ).not.toBeNull();

    markForkHandoffConsumed("agentsession-fork-1");
    expect(
      await buildPendingForkHandoff("agentsession-fork-1", "second message")
    ).toBeNull();
    // Provenance outlives the handoff.
    expect(
      getSessionForkedFrom({ session_id: "agentsession-fork-1" })
    ).toBeDefined();
  });

  it("returns null for non-forked sessions without touching the event store", async () => {
    expect(
      await buildPendingForkHandoff("sdeagent-ordinary", "hello")
    ).toBeNull();
    expect(eventStoreMock.getPersistedEvents).not.toHaveBeenCalled();
  });

  it("slices to the fork point so the just-typed user event is not doubled into the digest", async () => {
    await forkTeammateSession(makeForkOptions()); // atCount = 2
    eventStoreMock.getPersistedEvents.mockResolvedValue([
      makeEvent({ id: "e1", displayText: "inherited one" }),
      makeEvent({ id: "e2", displayText: "inherited two" }),
      // Appended by the composer before dispatch — NOT inherited history.
      makeEvent({
        id: "e3",
        source: "user",
        actionType: "user_message",
        displayText: "my brand new message",
      }),
    ]);

    const handoff = await buildPendingForkHandoff(
      "agentsession-fork-1",
      "my brand new message"
    );
    expect(handoff!.content).toContain("inherited one");
    expect(handoff!.content).toContain("inherited two");
    // Present once as the continuation request, not also as transcript.
    expect(handoff!.content).not.toContain("User: my brand new message");
  });
});

describe("buildForkHandoffPrompt", () => {
  it("skips thinking/reasoning events and truncates long item text", () => {
    const longText = "x".repeat(
      __FORK_RELAY_INTERNALS.MAX_ITEM_TEXT_LENGTH + 100
    );
    const prompt = buildForkHandoffPrompt(
      [
        makeEvent({
          id: "think",
          actionType: "llm_thinking",
          displayText: "SECRET internal monologue",
        }),
        makeEvent({ id: "long", displayText: longText }),
      ],
      FORKED_FROM,
      "carry on"
    );

    expect(prompt).not.toContain("SECRET internal monologue");
    expect(prompt).toContain("…");
    expect(prompt).not.toContain(longText);
    expect(prompt).toContain("carry on");
  });

  it("caps the digest at MAX_HANDOFF_ITEMS keeping the most recent items", () => {
    const events = Array.from(
      { length: __FORK_RELAY_INTERNALS.MAX_HANDOFF_ITEMS + 10 },
      (_unused, index) =>
        makeEvent({ id: `e${index}`, displayText: `item number ${index}` })
    );
    const prompt = buildForkHandoffPrompt(events, FORKED_FROM, "go");
    expect(prompt).not.toContain("item number 0\n");
    expect(prompt).toContain(
      `item number ${__FORK_RELAY_INTERNALS.MAX_HANDOFF_ITEMS + 9}`
    );
  });

  it("states the fallback when no usable transcript items exist", () => {
    const prompt = buildForkHandoffPrompt([], FORKED_FROM, "go");
    expect(prompt).toContain("No usable transcript items were found.");
  });
});
