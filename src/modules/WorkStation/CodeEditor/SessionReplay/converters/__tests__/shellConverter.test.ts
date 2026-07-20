/**
 * Shell converter: command keyword extraction.
 */
import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { convertToShellOperation } from "../shellConverter";

function minimalSessionEvent(
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    chunk_id: null,
    id: "evt-1",
    sessionId: "sess-1",
    createdAt: "2026-03-29T12:00:00.000Z",
    functionName: "inspect_terminals",
    uiCanonical: "inspect_terminals",
    actionType: "tool_call",
    args: {},
    result: {},
    source: "assistant",
    displayText: "",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "agent",
    ...overrides,
  };
}

describe("shell command display", () => {
  it("uses shared command display fields from shell extraction", () => {
    const event = minimalSessionEvent({
      functionName: "run_shell",
      uiCanonical: "run_shell",
      args: { command: "cd foo && npm run build" },
    });

    const operation = convertToShellOperation(event, true);

    expect(operation).not.toBeNull();
    expect(operation?.shortCommand).toBe("cd");
    expect(operation?.commandKeywords).toBe("cd, npm");
  });

  it("carries the agent-provided description for Station labels", () => {
    const event = minimalSessionEvent({
      functionName: "run_shell",
      uiCanonical: "run_shell",
      args: {
        command: "npx eslint src/ --format json",
        description: "Run full ESLint summary",
      },
    });

    const operation = convertToShellOperation(event, true);

    expect(operation).not.toBeNull();
    expect(operation?.description).toBe("Run full ESLint summary");
  });
});

describe("convertToShellOperation", () => {
  it("prefers authoritative Rust shell extraction over stale payload fields", () => {
    const event = minimalSessionEvent({
      functionName: "run_shell",
      uiCanonical: "run_shell",
      args: { command: "pnpm test --old-filter" },
      result: { output: "stale partial output" },
      extracted: {
        kind: "shell",
        command: "pnpm test",
        output: "all tests passed",
        exitCode: 0,
        cwd: "/repo",
        executionTime: 1250,
        isFailure: false,
        gitArtifacts: [],
      },
    });

    const operation = convertToShellOperation(event, true);

    expect(operation).toMatchObject({
      command: "pnpm test",
      output: "all tests passed",
      exitCode: 0,
      cwd: "/repo",
      executionTime: 1250,
    });
  });

  it("keeps completed inspect_terminals result output visible", () => {
    const event = minimalSessionEvent({
      args: { action: "list" },
      result: { output: '[{"session_id":"pty-1"}]' },
    });

    const operation = convertToShellOperation(event, true);

    expect(operation).not.toBeNull();
    expect(operation?.command).toBe("inspect_terminals list");
    expect(operation?.output).toBe('[{"session_id":"pty-1"}]');
    expect(operation?.isLoading).toBe(false);
  });

  it("keeps running inspect_terminals stream output visible", () => {
    const event = minimalSessionEvent({
      args: { action: "read_output", streamOutput: "terminal output" },
      displayStatus: "running",
    });

    const operation = convertToShellOperation(event, true);

    expect(operation).not.toBeNull();
    expect(operation?.command).toBe("inspect_terminals read_output");
    expect(operation?.streamOutput).toBe("terminal output");
    expect(operation?.isLoading).toBe(true);
  });

  it("keeps run_shell stream output visible from displayStatus", () => {
    const event = minimalSessionEvent({
      functionName: "run_shell",
      uiCanonical: "run_shell",
      args: { command: "pnpm test", streamOutput: "running tests" },
      displayStatus: "running",
    });

    const operation = convertToShellOperation(event, true);

    expect(operation).not.toBeNull();
    expect(operation?.command).toBe("pnpm test");
    expect(operation?.streamOutput).toBe("running tests");
    expect(operation?.isLoading).toBe(true);
  });

  it("renders completed background run_shell output without loading state", () => {
    const event = minimalSessionEvent({
      functionName: "run_shell",
      uiCanonical: "run_shell",
      args: {
        command: "pnpm dev",
        streamOutput: "dev server ready",
        shellPid: 123,
        shellProcessStatus: "background",
      },
      displayStatus: "completed",
    });

    const operation = convertToShellOperation(event, true);

    expect(operation).not.toBeNull();
    expect(operation?.command).toBe("pnpm dev");
    expect(operation?.output).toBe("dev server ready");
    expect(operation?.streamOutput).toBeUndefined();
    expect(operation?.isLoading).toBe(false);
  });
});
