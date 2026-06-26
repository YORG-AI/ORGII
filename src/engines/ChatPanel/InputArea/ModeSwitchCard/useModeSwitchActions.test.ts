import { beforeEach, describe, expect, it, vi } from "vitest";

import { switchMode } from "./useModeSwitchActions";

const storeGetSpy = vi.hoisted(() => vi.fn());
const sendMessageSpy = vi.hoisted(() => vi.fn());
const respondModeSwitchSpy = vi.hoisted(() => vi.fn());
const rpcPatchSpy = vi.hoisted(() => vi.fn());
const updateByIdSpy = vi.hoisted(() => vi.fn());
const getSnapshotSpy = vi.hoisted(() => vi.fn());
const upsertSessionSpy = vi.hoisted(() => vi.fn());
const beginOptimisticTurnSpy = vi.hoisted(() => vi.fn());
const isAgentSessionSpy = vi.hoisted(() => vi.fn());
const isCursorIdeSessionSpy = vi.hoisted(() => vi.fn());

vi.mock("@src/util/core/state/instrumentedStore", () => ({
  getInstrumentedStore: () => ({ get: storeGetSpy }),
}));

vi.mock("@src/engines/SessionCore/services/SessionService", () => ({
  SessionService: { sendMessage: sendMessageSpy },
}));

vi.mock("@src/api/tauri/agent", () => ({
  respondModeSwitch: respondModeSwitchSpy,
}));

vi.mock("@src/api/tauri/cursorBridge", () => ({
  cursorBridgeSetMode: vi.fn(),
}));

vi.mock("@src/api/tauri/rpc", () => ({
  rpc: { sessionAggregate: { patch: rpcPatchSpy } },
}));

vi.mock("@src/engines/SessionCore/control/optimisticTurnStatus", () => ({
  beginOptimisticTurn: beginOptimisticTurnSpy,
  failOptimisticTurn: vi.fn(),
}));

vi.mock("@src/engines/SessionCore/core/atoms", () => ({
  eventsAtom: { __tag: "eventsAtom" },
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    updateById: updateByIdSpy,
    getLatestSessionSnapshot: getSnapshotSpy,
  },
}));

vi.mock("@src/store/session/creatorDefaultModelAtom", () => ({
  creatorDefaultModelSelectionAtom: {
    __tag: "creatorDefaultModelSelectionAtom",
  },
}));

vi.mock("@src/store/session/cursorModeOverrideAtom", () => ({
  cursorModeOverrideAtomFamily: () => ({ __tag: "cursorModeOverride" }),
}));

vi.mock("@src/store/session/sessionAtom", () => ({
  sessionByIdAtom: (id: string) => ({ __tag: "sessionByIdAtom", id }),
  upsertSession: upsertSessionSpy,
}));

vi.mock("@src/store/session/viewAtom", () => ({
  activeSessionIdAtom: { __tag: "activeSessionIdAtom" },
}));

vi.mock("@src/util/session/resolveModelForMessage", () => ({
  resolveModelForMessage: () => ({ model: "test-model", accountId: "acct-1" }),
}));

vi.mock("@src/util/session/sessionDispatch", () => ({
  composerIdFromSessionId: () => "composer-1",
  isAgentSession: isAgentSessionSpy,
  isCursorIdeSession: isCursorIdeSessionSpy,
}));

const SESSION_ID = "agent-builtin:sde-abc";

function setupStore(opts: { lastUserText?: string; agentExecMode?: string }) {
  const sessionRow = {
    id: SESSION_ID,
    agentExecMode: opts.agentExecMode ?? "build",
    model: "test-model",
    accountId: "acct-1",
  };
  storeGetSpy.mockImplementation((atom: { __tag?: string }) => {
    if (atom?.__tag === "activeSessionIdAtom") return SESSION_ID;
    if (atom?.__tag === "sessionByIdAtom") return sessionRow;
    if (atom?.__tag === "creatorDefaultModelSelectionAtom") return undefined;
    return undefined;
  });
  getSnapshotSpy.mockReturnValue({
    events: opts.lastUserText
      ? [{ source: "user", displayText: opts.lastUserText }]
      : [],
  });
}

describe("switchMode → switchAgentMode resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isCursorIdeSessionSpy.mockReturnValue(false);
    isAgentSessionSpy.mockReturnValue(true);
    delete (window as { __ORGII_E2E_MODE_SWITCH_MOCK__?: boolean })
      .__ORGII_E2E_MODE_SWITCH_MOCK__;
    sendMessageSpy.mockResolvedValue(undefined);
    respondModeSwitchSpy.mockResolvedValue(undefined);
    rpcPatchSpy.mockResolvedValue(undefined);
    updateByIdSpy.mockResolvedValue(undefined);
  });

  it("resumes the turn even when the user's message opens with switch-style wording", async () => {
    // Regression: this command-style prompt previously matched the deleted
    // text guard (`/切.*模式/`) and the resume was skipped, stranding the turn.
    setupStore({
      lastUserText: "切模式检查，你找到 root cause 写个修复 plan 给我",
    });

    await switchMode("event-1", "plan");

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        content: "",
        isResume: true,
        mode: "plan",
      })
    );
    expect(beginOptimisticTurnSpy).toHaveBeenCalledWith(SESSION_ID);
  });

  it("resumes the turn for an ordinary task prompt", async () => {
    setupStore({ lastUserText: "add a unit test for the parser" });

    await switchMode("event-2", "plan");

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ content: "", isResume: true, mode: "plan" })
    );
  });

  it("does not resume when there is no prior user message to anchor on", async () => {
    setupStore({ lastUserText: undefined });

    await switchMode("event-3", "plan");

    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(beginOptimisticTurnSpy).not.toHaveBeenCalled();
  });
});
