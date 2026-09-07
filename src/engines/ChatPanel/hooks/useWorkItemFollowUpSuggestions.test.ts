import { describe, expect, it, vi } from "vitest";

import type {
  SessionFollowUpSuggestion,
  SessionFollowUpSuggestionsResponse,
} from "@src/api/services/sessionFollowUpSuggestions";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { Session } from "@src/store/session/sessionAtom/types";

import {
  advanceFollowUpLifecycleObservation,
  createFollowUpRequestCoordinator,
  initializeFollowUpLifecycleObservation,
  isFollowUpResultCurrent,
  latestCompletedAssistantFingerprint,
  resolveEnabledFollowUpScope,
  resolveFollowUpProviderIdentity,
  resolveWorkItemFollowUpScope,
  selectFollowUpConversation,
} from "./useWorkItemFollowUpSuggestions";

function session(overrides: Partial<Session> = {}): Session {
  return {
    session_id: "session-1",
    status: "completed",
    created_at: "2026-08-19T00:00:00.000Z",
    updated_at: "2026-08-19T00:00:01.000Z",
    orgId: "org-1",
    workItemId: "WI-1",
    model: "gpt-5.6-sol",
    accountId: "codex-oauth",
    ...overrides,
  };
}

function event(
  id: string,
  source: "user" | "assistant" | "system",
  displayText: string,
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    chunk_id: id,
    id,
    sessionId: "session-1",
    createdAt: "2026-08-19T00:00:00.000Z",
    functionName: "message",
    uiCanonical: "message",
    actionType: source,
    args: {},
    result: {},
    source,
    displayText,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    ...overrides,
  };
}

const suggestions: SessionFollowUpSuggestion[] = [
  { label: "Open PR", prompt: "Open the PR.", primary: true },
  { label: "Run checks", prompt: "Run the checks.", primary: false },
  { label: "Review risks", prompt: "Review the risks.", primary: false },
];

function response(): SessionFollowUpSuggestionsResponse {
  return {
    suggestions,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("work item follow-up suggestion scope and context", () => {
  it("spends no follow-up budget unless the preference is explicitly enabled", () => {
    const scope = {
      sessionId: "session-1",
      orgId: "org-1",
      workItemId: "WI-1",
    };
    expect(resolveEnabledFollowUpScope(false, scope)).toBeNull();
    expect(resolveEnabledFollowUpScope(true, scope)).toBe(scope);
  });

  it("requires a writable explicit work-item session and trims its scope", () => {
    expect(
      resolveWorkItemFollowUpScope({
        sessionId: "session-1",
        inputAreaSessionId: "session-1",
        session: session({ orgId: " org-1 ", workItemId: " WI-1 " }),
      })
    ).toEqual({ sessionId: "session-1", orgId: "org-1", workItemId: "WI-1" });

    for (const candidate of [
      session({ orgId: undefined }),
      session({ workItemId: undefined }),
      session({ readOnly: true }),
      session({ session_id: "another-session" }),
    ]) {
      expect(
        resolveWorkItemFollowUpScope({
          sessionId: "session-1",
          inputAreaSessionId: "session-1",
          session: candidate,
        })
      ).toBeNull();
    }
    expect(
      resolveWorkItemFollowUpScope({
        sessionId: "session-1",
        inputAreaSessionId: "agent-org-member",
        session: session(),
      })
    ).toBeNull();
  });

  it("selects only the six newest user/assistant message rows", () => {
    const events = [
      event("u-0", "user", "oldest"),
      event("a-0", "assistant", "old reply"),
      event("tool", "assistant", "tool", { displayVariant: "tool_call" }),
      event("sys", "system", "internal"),
      event("u-1", "user", "one"),
      event("a-1", "assistant", "two"),
      event("u-2", "user", "three"),
      event("a-2", "assistant", "four"),
      event("u-3", "user", "five"),
      event("a-3", "assistant", "six"),
    ];

    expect(selectFollowUpConversation(events)).toEqual([
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
      { role: "assistant", content: "four" },
      { role: "user", content: "five" },
      { role: "assistant", content: "six" },
    ]);
    expect(latestCompletedAssistantFingerprint(events)).toBe("a-3\0six");
  });

  it("uses the current session model/account without provider allowlisting", () => {
    for (const candidate of [
      session({ cliAgentType: "codex" }),
      session({ model: "claude-opus-4-1", accountId: "claude-oauth" }),
      session({ model: "MiniMax-M2.5", accountId: "minimax-key" }),
    ]) {
      expect(
        resolveFollowUpProviderIdentity(candidate.accountId, candidate.model)
      ).toEqual({
        model: candidate.model,
        accountId: candidate.accountId,
      });
    }
    expect(
      resolveFollowUpProviderIdentity(undefined, "gpt-5.6-sol")
    ).toBeNull();
    expect(
      resolveFollowUpProviderIdentity("codex-oauth", undefined)
    ).toBeNull();
  });
});

describe("follow-up turn lifecycle", () => {
  it("baselines existing terminal history instead of backfilling it", () => {
    const historical = {
      phase: "idle" as const,
      generation: 7,
      terminal: { generation: 7, status: "completed" as const, at: 1 },
      assistantFingerprint: "assistant-7\0done",
    };
    const observation = initializeFollowUpLifecycleObservation(
      "scope",
      historical
    );

    expect(observation.handledTerminalGeneration).toBe(7);
    expect(
      advanceFollowUpLifecycleObservation(observation, historical, true)
        .generate
    ).toBe(false);
  });

  it("generates once across a running to completed generation", () => {
    const initial = initializeFollowUpLifecycleObservation("scope", {
      phase: "idle",
      generation: 3,
      terminal: { generation: 3, status: "completed", at: 1 },
      assistantFingerprint: "assistant-3\0old",
    });
    const running = advanceFollowUpLifecycleObservation(
      initial,
      {
        phase: "working",
        generation: 4,
        terminal: { generation: 3, status: "completed", at: 1 },
        assistantFingerprint: "assistant-3\0old",
      },
      true
    );
    expect(running.clear).toBe(true);
    expect(running.generate).toBe(false);

    const completed = advanceFollowUpLifecycleObservation(
      running.observation,
      {
        phase: "idle",
        generation: 4,
        terminal: { generation: 4, status: "completed", at: 2 },
        assistantFingerprint: "assistant-4\0new",
      },
      true
    );
    expect(completed.generate).toBe(true);
    expect(completed.observation.handledTerminalGeneration).toBe(4);
    expect(
      advanceFollowUpLifecycleObservation(
        completed.observation,
        {
          phase: "idle",
          generation: 4,
          terminal: { generation: 4, status: "completed", at: 2 },
          assistantFingerprint: "assistant-4\0new",
        },
        true
      ).generate
    ).toBe(false);
  });

  it("does not generate for failure or a completion observed while disabled", () => {
    const running = initializeFollowUpLifecycleObservation("scope", {
      phase: "working",
      generation: 9,
      terminal: null,
      assistantFingerprint: "assistant-8\0old",
    });
    const failed = advanceFollowUpLifecycleObservation(
      running,
      {
        phase: "idle",
        generation: 9,
        terminal: { generation: 9, status: "failed", at: 2 },
        assistantFingerprint: "assistant-9\0error",
      },
      true
    );
    expect(failed.generate).toBe(false);

    const disabled = advanceFollowUpLifecycleObservation(
      running,
      {
        phase: "idle",
        generation: 9,
        terminal: { generation: 9, status: "completed", at: 2 },
        assistantFingerprint: "assistant-9\0done",
      },
      false
    );
    expect(disabled.generate).toBe(false);
    expect(disabled.observation.handledTerminalGeneration).toBe(9);
    expect(
      advanceFollowUpLifecycleObservation(
        disabled.observation,
        {
          phase: "idle",
          generation: 9,
          terminal: { generation: 9, status: "completed", at: 2 },
          assistantFingerprint: "assistant-9\0done",
        },
        true
      ).generate
    ).toBe(false);
  });

  it("requires observing the generation in working before its terminal", () => {
    const dispatching = initializeFollowUpLifecycleObservation("scope", {
      phase: "dispatching",
      generation: 12,
      terminal: null,
      assistantFingerprint: "assistant-11\0old",
    });

    expect(
      advanceFollowUpLifecycleObservation(
        dispatching,
        {
          phase: "idle",
          generation: 12,
          terminal: { generation: 12, status: "completed", at: 2 },
          assistantFingerprint: "assistant-12\0new",
        },
        true
      ).generate
    ).toBe(false);
  });
});

describe("follow-up request coordinator", () => {
  const request = {
    sessionId: "session-1",
    generation: 4,
    messages: [
      { role: "user" as const, content: "Please finish it." },
      { role: "assistant" as const, content: "It is done." },
    ],
  };

  it("shares one request for the same session generation", async () => {
    const pending = deferred<SessionFollowUpSuggestionsResponse>();
    const generate = vi.fn(() => pending.promise);
    const coordinator = createFollowUpRequestCoordinator(2);

    const first = coordinator.request(request, generate);
    const second = coordinator.request(request, generate);
    expect(generate).toHaveBeenCalledOnce();
    expect(coordinator.inFlightCount()).toBe(1);

    pending.resolve(response());
    await expect(first).resolves.toEqual(suggestions);
    await expect(second).resolves.toEqual(suggestions);
    expect(coordinator.inFlightCount()).toBe(0);
  });

  it("runs the latest generation after the active pass without overlap", async () => {
    const firstPass = deferred<SessionFollowUpSuggestionsResponse>();
    const secondPass = deferred<SessionFollowUpSuggestionsResponse>();
    const generate = vi.fn((nextRequest: { generation: number }) =>
      nextRequest.generation === request.generation
        ? firstPass.promise
        : secondPass.promise
    );
    const coordinator = createFollowUpRequestCoordinator(2);

    const first = coordinator.request(request, generate);
    const second = coordinator.request({ ...request, generation: 5 }, generate);
    expect(generate).toHaveBeenCalledOnce();
    expect(coordinator.inFlightCount()).toBe(1);

    firstPass.resolve(response());
    await expect(first).resolves.toEqual(suggestions);
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(generate.mock.calls[1]?.[0].generation).toBe(5);

    secondPass.resolve(response());
    await expect(second).resolves.toEqual(suggestions);
    expect(coordinator.inFlightCount()).toBe(0);
  });

  it("coalesces multiple waiting turns to the latest generation", async () => {
    const firstPass = deferred<SessionFollowUpSuggestionsResponse>();
    const latestPass = deferred<SessionFollowUpSuggestionsResponse>();
    const generate = vi.fn((nextRequest: { generation: number }) =>
      nextRequest.generation === request.generation
        ? firstPass.promise
        : latestPass.promise
    );
    const coordinator = createFollowUpRequestCoordinator(2);

    const first = coordinator.request(request, generate);
    const superseded = coordinator.request(
      { ...request, generation: 5 },
      generate
    );
    const latest = coordinator.request({ ...request, generation: 6 }, generate);
    await expect(superseded).resolves.toBeNull();
    expect(generate).toHaveBeenCalledOnce();

    firstPass.resolve(response());
    await first;
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(generate.mock.calls[1]?.[0].generation).toBe(6);
    latestPass.resolve(response());
    await expect(latest).resolves.toEqual(suggestions);
  });

  it("sheds work instead of queueing past the process bound", async () => {
    const pending = deferred<SessionFollowUpSuggestionsResponse>();
    const generate = vi.fn(() => pending.promise);
    const coordinator = createFollowUpRequestCoordinator(1);

    const first = coordinator.request(request, generate);
    await expect(
      coordinator.request({ ...request, sessionId: "session-2" }, generate)
    ).resolves.toBeNull();
    expect(generate).toHaveBeenCalledOnce();
    pending.resolve(response());
    await first;
  });

  it("silently degrades generator failures and releases admission", async () => {
    const coordinator = createFollowUpRequestCoordinator(1);

    await expect(
      coordinator.request(request, () => {
        throw new Error("selection failed");
      })
    ).resolves.toBeNull();
    await expect(
      coordinator.request(request, () => Promise.reject(new Error("no model")))
    ).resolves.toBeNull();
    expect(coordinator.inFlightCount()).toBe(0);
  });
});

describe("follow-up stale result guard", () => {
  const current = {
    requestEpoch: 4,
    currentRequestEpoch: 4,
    expectedContextKey: "session-1\0org-1\0WI-1",
    currentContextKey: "session-1\0org-1\0WI-1",
    phase: "idle" as const,
    expectedGeneration: 9,
    terminal: { generation: 9, status: "completed" as const, at: 1 },
  };

  it("accepts only the same session context and completed generation", () => {
    expect(isFollowUpResultCurrent(current)).toBe(true);
    expect(
      isFollowUpResultCurrent({ ...current, currentRequestEpoch: 5 })
    ).toBe(false);
    expect(
      isFollowUpResultCurrent({ ...current, currentContextKey: "session-2" })
    ).toBe(false);
    expect(
      isFollowUpResultCurrent({
        ...current,
        terminal: { generation: 10, status: "completed", at: 2 },
      })
    ).toBe(false);
    expect(isFollowUpResultCurrent({ ...current, phase: "working" })).toBe(
      false
    );
  });
});
