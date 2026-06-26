import { describe, expect, it, vi } from "vitest";

import {
  type SessionAggregateRecord,
  toFrontendSession,
  toFrontendSessions,
} from "..";

// Mock the Tauri invocation
vi.mock("@src/util/platform/tauri/init", () => ({
  invokeTauri: vi.fn(),
}));

// ============================================================================
// Helper: Create mock SessionAggregateRecord
// ============================================================================

function makeAggregateRecord(
  overrides: Partial<SessionAggregateRecord> = {}
): SessionAggregateRecord {
  return {
    sessionId: "test-session-1",
    name: "Test Session",
    status: "running",
    createdAt: "2024-01-01T10:00:00Z",
    updatedAt: "2024-01-01T11:00:00Z",
    category: "cli_agent",
    keySource: "own_key",
    totalTokens: 1500,
    background: false,
    isActive: true,
    pinned: false,
    ...overrides,
  };
}

// ============================================================================
// toFrontendSession
// ============================================================================

describe("toFrontendSession", () => {
  it("converts basic fields correctly", () => {
    const record = makeAggregateRecord({
      sessionId: "session-abc",
      name: "My Session",
      status: "completed",
      createdAt: "2024-02-15T08:00:00Z",
      updatedAt: "2024-02-15T09:30:00Z",
      isActive: false,
    });

    const result = toFrontendSession(record);

    expect(result.session_id).toBe("session-abc");
    expect(result.name).toBe("My Session");
    expect(result.status).toBe("completed");
    expect(result.created_at).toBe("2024-02-15T08:00:00Z");
    expect(result.updated_at).toBe("2024-02-15T09:30:00Z");
    expect(result.created_time).toBe("2024-02-15T08:00:00Z");
    expect(result.updated_time).toBe("2024-02-15T09:30:00Z");
    expect(result.is_active).toBe(false);
  });

  it("passes category and key source through", () => {
    const cliRecord = makeAggregateRecord({
      category: "cli_agent",
      keySource: "own_key",
    });
    const rustRecord = makeAggregateRecord({
      category: "rust_agent",
      keySource: "hosted_key",
    });

    expect(toFrontendSession(cliRecord).category).toBe("cli_agent");
    expect(toFrontendSession(rustRecord).category).toBe("rust_agent");
    expect(toFrontendSession(cliRecord).keySource).toBe("own_key");
    expect(toFrontendSession(rustRecord).keySource).toBe("hosted_key");
  });

  it("converts optional fields", () => {
    const record = makeAggregateRecord({
      userInput: "Fix the bug",
      repoName: "my-repo",
      branch: "feature/test",
      model: "gpt-4",
      cliAgentType: "claude_code",
      accountId: "acc-123",
      tier: "premium",
      pid: 12345,
    });

    const result = toFrontendSession(record);

    expect(result.user_input).toBe("Fix the bug");
    expect(result.repo_name).toBe("my-repo");
    expect(result.branch).toBe("feature/test");
    expect(result.model).toBe("gpt-4");
    expect(result.cliAgentType).toBe("claude_code");
    expect(result.accountId).toBe("acc-123");
    expect(result.tier).toBe("premium");
    expect(result.pid).toBe(12345);
  });

  it("handles undefined optional fields with defaults", () => {
    const record = makeAggregateRecord({
      repoName: undefined,
      branch: undefined,
      pid: undefined,
    });

    const result = toFrontendSession(record);

    expect(result.repo_name).toBe("");
    expect(result.branch).toBe("");
    expect(result.pid).toBe(null);
  });

  it("converts worktree fields", () => {
    const record = makeAggregateRecord({
      worktreePath: "/path/to/worktree",
      worktreeBranch: "worktree-branch",
      baseBranch: "main",
      mergeStatus: "pending",
    });

    const result = toFrontendSession(record);

    expect(result.worktreePath).toBe("/path/to/worktree");
    expect(result.worktreeBranch).toBe("worktree-branch");
    expect(result.baseBranch).toBe("main");
    expect(result.mergeStatus).toBe("pending");
  });

  it("converts background flag", () => {
    const bgRecord = makeAggregateRecord({ background: true });
    const fgRecord = makeAggregateRecord({ background: false });

    expect(toFrontendSession(bgRecord).background).toBe(true);
    expect(toFrontendSession(fgRecord).background).toBe(false);
  });
});

// ============================================================================
// toFrontendSessions
// ============================================================================

describe("toFrontendSessions", () => {
  it("converts an array of records", () => {
    const records = [
      makeAggregateRecord({ sessionId: "s1", name: "Session 1" }),
      makeAggregateRecord({ sessionId: "s2", name: "Session 2" }),
      makeAggregateRecord({ sessionId: "s3", name: "Session 3" }),
    ];

    const result = toFrontendSessions(records);

    expect(result).toHaveLength(3);
    expect(result[0].session_id).toBe("s1");
    expect(result[1].session_id).toBe("s2");
    expect(result[2].session_id).toBe("s3");
    expect(result[0].name).toBe("Session 1");
    expect(result[1].name).toBe("Session 2");
  });

  it("returns empty array for empty input", () => {
    const result = toFrontendSessions([]);
    expect(result).toEqual([]);
  });

  it("preserves all session properties through batch conversion", () => {
    const records = [
      makeAggregateRecord({
        sessionId: "batch-1",
        category: "rust_agent",
        keySource: "hosted_key",
        status: "running",
        pid: 1111,
        background: true,
      }),
    ];

    const result = toFrontendSessions(records);

    expect(result[0].session_id).toBe("batch-1");
    expect(result[0].category).toBe("rust_agent");
    expect(result[0].keySource).toBe("hosted_key");
    expect(result[0].status).toBe("running");
    expect(result[0].pid).toBe(1111);
    expect(result[0].background).toBe(true);
  });
});

// ============================================================================
// Type Contracts
// ============================================================================

describe("type contracts", () => {
  it("SessionAggregateRecord has required fields", () => {
    const record = makeAggregateRecord();

    // Required fields should be present
    expect(typeof record.sessionId).toBe("string");
    expect(typeof record.name).toBe("string");
    expect(typeof record.status).toBe("string");
    expect(typeof record.createdAt).toBe("string");
    expect(typeof record.updatedAt).toBe("string");
    expect(typeof record.category).toBe("string");
    expect(typeof record.keySource).toBe("string");
    expect(typeof record.totalTokens).toBe("number");
    expect(typeof record.background).toBe("boolean");
    expect(typeof record.isActive).toBe("boolean");
  });

  it("category values are constrained to DispatchCategory", () => {
    const categories = ["cli_agent", "rust_agent"] as const;

    categories.forEach((cat) => {
      const record = makeAggregateRecord({ category: cat });
      expect(["cli_agent", "rust_agent"]).toContain(record.category);
    });
  });

  it("keySource values are constrained", () => {
    const keySources = ["own_key", "hosted_key"] as const;

    keySources.forEach((ks) => {
      const record = makeAggregateRecord({ keySource: ks });
      expect(["own_key", "hosted_key"]).toContain(record.keySource);
    });
  });
});
