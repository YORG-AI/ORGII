import type { Session } from "@src/store/session";

import { sessionToKanbanTask } from "./sessionToKanbanTask";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: "session-1",
    status: "running",
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

function toTask(session: Session) {
  return sessionToKanbanTask(
    session,
    new Set(),
    new Set(),
    "never",
    Date.parse("2026-07-12T01:00:00.000Z")
  );
}

describe("sessionToKanbanTask workspace label", () => {
  it("shows the repo name instead of an agent-generated worktree directory", () => {
    const task = toTask(
      makeSession({
        repo_name: "ORGII",
        repoPath: "/Users/me/GitHub/ORGII",
        worktreePath: "/tmp/orgii/sdeagent-97c3d918-5dec",
      })
    );

    expect(task.workspaceName).toBe("ORGII");
  });

  it("falls back to the repo root basename when the repo name is absent", () => {
    const task = toTask(
      makeSession({
        repoPath: "C:\\Users\\me\\GitHub\\ORGII",
        worktreePath: "C:\\tmp\\sdeagent-97c3d918-5dec",
      })
    );

    expect(task.workspaceName).toBe("ORGII");
  });

  it("uses the worktree basename only for legacy sessions without repo data", () => {
    const task = toTask(makeSession({ worktreePath: "/tmp/legacy-worktree" }));

    expect(task.workspaceName).toBe("legacy-worktree");
  });
});

describe("sessionToKanbanTask agent label", () => {
  it.each([
    ["cursoride-session-1", "cursor_cli", "Cursor App"],
    ["cliagent-cursor-1", "cursor_cli", "Cursor CLI"],
    ["claudecodeapp-session-1", "claude_code", "Claude App"],
    ["cliagent-claude-1", "claude_code", "Claude CLI"],
  ] as const)("labels %s as %s", (sessionId, cliAgentType, expected) => {
    const task = toTask(makeSession({ session_id: sessionId, cliAgentType }));

    expect(task.agentLabel).toBe(expected);
  });
});

describe("sessionToKanbanTask card copy", () => {
  it("renders session cards title-only when the first message matches", () => {
    const task = toTask(
      makeSession({
        session_id: "cliagent-claude-1",
        name: "hi",
        user_input: "hi",
        cliAgentType: "claude_code",
      })
    );

    expect(task.title).toBe("hi");
    expect(task.description).toBeUndefined();
  });
});
