import {
  CLAUDE_CODE_HISTORY_SESSION_PREFIX,
  CLI_SESSION_PREFIX,
  CODEX_APP_SESSION_PREFIX,
  COLLABORATION_SNAPSHOT_SESSION_PREFIX,
  OPENCODE_HISTORY_SESSION_PREFIX,
  OS_AGENT_SESSION_PREFIX,
  SDE_AGENT_SESSION_PREFIX,
  WARP_HISTORY_SESSION_PREFIX,
  WINDSURF_HISTORY_SESSION_PREFIX,
  getDispatchCategory,
  getExternalHistorySourceId,
  getRustAgentType,
  isAgentSession,
  isClaudeCodeHistorySession,
  isCliSession,
  isCodexAppSession,
  isCollaborationSnapshotSession,
  isExternalHistorySession,
  isImportedHistorySession,
  isOpenCodeHistorySession,
  isWarpHistorySession,
  isWindsurfHistorySession,
} from "../sessionDispatch";

describe("sessionDispatch constants", () => {
  it("exports expected prefix strings", () => {
    expect(OS_AGENT_SESSION_PREFIX).toBe("osagent-");
    expect(SDE_AGENT_SESSION_PREFIX).toBe("sdeagent-");
    expect(CLI_SESSION_PREFIX).toBe("cliagent-");
    expect(CODEX_APP_SESSION_PREFIX).toBe("codexapp-");
    expect(CLAUDE_CODE_HISTORY_SESSION_PREFIX).toBe("claudecodeapp-");
    expect(COLLABORATION_SNAPSHOT_SESSION_PREFIX).toBe("imported-session-");
    expect(OPENCODE_HISTORY_SESSION_PREFIX).toBe("opencodeapp-");
    expect(WINDSURF_HISTORY_SESSION_PREFIX).toBe("windsurfapp-");
    expect(WARP_HISTORY_SESSION_PREFIX).toBe("warpapp-");
  });
});

describe("isCliSession", () => {
  it("returns true for cliagent prefix", () => {
    expect(isCliSession("cliagent-xyz")).toBe(true);
  });

  it("returns false for non-matching", () => {
    expect(isCliSession("osagent-x")).toBe(false);
  });

  it("returns false for null and undefined", () => {
    expect(isCliSession(null)).toBe(false);
    expect(isCliSession(undefined)).toBe(false);
  });
});

describe("isAgentSession", () => {
  it("returns true for sdeagent prefix", () => {
    expect(isAgentSession("sdeagent-1")).toBe(true);
  });

  it("returns true for osagent prefix", () => {
    expect(isAgentSession("osagent-1")).toBe(true);
  });

  it("returns false for non-matching", () => {
    expect(isAgentSession("cliagent-1")).toBe(false);
  });

  it("returns false for null and undefined", () => {
    expect(isAgentSession(null)).toBe(false);
    expect(isAgentSession(undefined)).toBe(false);
  });
});

describe("getDispatchCategory", () => {
  it("returns correct category per prefix", () => {
    expect(getDispatchCategory("osagent-x")).toBe("rust_agent");
    expect(getDispatchCategory("sdeagent-x")).toBe("rust_agent");
    expect(getDispatchCategory("cliagent-x")).toBe("cli_agent");
    expect(getDispatchCategory("cursoride-x")).toBe("cursor_ide");
    expect(getDispatchCategory("codexapp-x")).toBe("external_history");
    expect(getDispatchCategory("claudecodeapp-x")).toBe("external_history");
    expect(getDispatchCategory("opencodeapp-x")).toBe("external_history");
    expect(getDispatchCategory("windsurfapp-x")).toBe("external_history");
    expect(getDispatchCategory("warpapp-x")).toBe("external_history");
    expect(getDispatchCategory("imported-session-x")).toBe("external_history");
  });

  it("returns rust_agent for unknown id (default)", () => {
    expect(getDispatchCategory("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "rust_agent"
    );
  });
});

describe("external history source detection", () => {
  it("recognizes ORGII-owned collaboration snapshots without widening native agents", () => {
    expect(
      isCollaborationSnapshotSession("imported-session-collaboration")
    ).toBe(true);
    expect(isImportedHistorySession("imported-session-collaboration")).toBe(
      true
    );
    expect(isExternalHistorySession("imported-session-collaboration")).toBe(
      true
    );
    expect(isCollaborationSnapshotSession("imported-session-")).toBe(false);
    expect(isImportedHistorySession("imported-session-")).toBe(false);
    expect(isImportedHistorySession("sdeagent-native")).toBe(false);
    expect(isImportedHistorySession("osagent-native")).toBe(false);
  });

  it("recognizes Codex App imported history sessions", () => {
    expect(isExternalHistorySession("codexapp-rollout-1")).toBe(true);
    expect(isCodexAppSession("codexapp-rollout-1")).toBe(true);
    expect(getExternalHistorySourceId("codexapp-rollout-1")).toBe("codex_app");
  });

  it("recognizes Claude Code imported history sessions", () => {
    expect(isExternalHistorySession("claudecodeapp-session-1")).toBe(true);
    expect(isClaudeCodeHistorySession("claudecodeapp-session-1")).toBe(true);
    expect(getExternalHistorySourceId("claudecodeapp-session-1")).toBe(
      "claude_code"
    );
  });

  it("recognizes OpenCode imported history sessions", () => {
    expect(isExternalHistorySession("opencodeapp-session-1")).toBe(true);
    expect(isOpenCodeHistorySession("opencodeapp-session-1")).toBe(true);
    expect(getExternalHistorySourceId("opencodeapp-session-1")).toBe(
      "opencode"
    );
  });

  it("recognizes Windsurf imported history sessions", () => {
    expect(isExternalHistorySession("windsurfapp-session-1")).toBe(true);
    expect(isWindsurfHistorySession("windsurfapp-session-1")).toBe(true);
    expect(getExternalHistorySourceId("windsurfapp-session-1")).toBe(
      "windsurf"
    );
  });

  it("recognizes Warp imported history sessions", () => {
    expect(isExternalHistorySession("warpapp-session-1")).toBe(true);
    expect(isWarpHistorySession("warpapp-session-1")).toBe(true);
    expect(getExternalHistorySourceId("warpapp-session-1")).toBe("warp");
  });

  it("routes Cursor App history through the Cursor IDE category", () => {
    expect(isExternalHistorySession("cursoride-session-1")).toBe(false);
    expect(getExternalHistorySourceId("cursoride-session-1")).toBe(
      "cursor_ide"
    );
  });
});

describe("getRustAgentType", () => {
  it("returns os for osagent prefix", () => {
    expect(getRustAgentType("osagent-abc")).toBe("os");
  });

  it("returns os for builtin:os defId", () => {
    expect(getRustAgentType("builtin:os")).toBe("os");
  });

  it("returns sde for sdeagent prefix", () => {
    expect(getRustAgentType("sdeagent-abc")).toBe("sde");
  });

  it("returns sde for builtin:sde defId", () => {
    expect(getRustAgentType("builtin:sde")).toBe("sde");
  });

  it("returns custom for cli prefix", () => {
    expect(getRustAgentType("cliagent-abc")).toBe("custom");
  });

  it("returns custom for unknown defId", () => {
    expect(getRustAgentType("builtin:gateway")).toBe("custom");
  });

  it("returns custom for null/undefined", () => {
    expect(getRustAgentType(null)).toBe("custom");
    expect(getRustAgentType(undefined)).toBe("custom");
  });
});
