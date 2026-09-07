import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  QueuedConversationBlockedError,
  QueuedConversationRecoveryPendingError,
} from "@src/engines/SessionCore/conversations/queuedConversationContract";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { optimisticQueueUserEventId } from "@src/engines/SessionCore/services/userIntentDispatch";

import {
  collapseRetriedPromptCopies,
  loadLocalCanonicalConversationSnapshot,
  loadLocalCanonicalConversationTimeline,
  mergeVerifiedLocalExecutionTimeline,
  projectVerifiedLocalExecutionTail,
  resolveLocalExecutionChildren,
  suppressLandedQueuedUserRows,
  suppressLandedRowsOfFailedQueuedTurns,
  verifiedNativeConversationSuffixEvents,
} from "./localConversationExecutionTail";

const mocks = vi.hoisted(() => ({
  invokeTauri: vi.fn(),
  loadCanonical: vi.fn(),
  loadCliRevision: vi.fn(),
}));

vi.mock("@src/util/platform/tauri/init", () => ({
  invokeTauri: mocks.invokeTauri,
}));

vi.mock("./canonicalConversationEvents", () => ({
  loadCanonicalConversationEvents: mocks.loadCanonical,
}));

vi.mock("@src/engines/SessionCore/sync/adapters/cli/cliHistory", () => ({
  loadCliTranscriptRevision: mocks.loadCliRevision,
}));

function event(
  id: string,
  createdAt: string,
  source: SessionEvent["source"],
  displayText: string
): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: "child-1",
    createdAt,
    functionName: source === "user" ? "user_message" : "assistant_message",
    uiCanonical: source === "user" ? "user" : "assistant_message",
    actionType: source === "user" ? "raw" : "assistant",
    args: {},
    result: {},
    source,
    displayText,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    payloadRefs: [],
  } as SessionEvent;
}

describe("local conversation execution tail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadCliRevision.mockResolvedValue(undefined);
  });

  it("returns the complete native-App delta only after a strict canonical prefix", () => {
    const canonical = [
      event("root-u1", "2026-09-04T05:00:00Z", "user", "round one"),
      event("root-a1", "2026-09-04T05:00:01Z", "assistant", "one"),
    ];
    const nativeAppUser = event(
      "claude-u2",
      "2026-09-04T05:01:00Z",
      "user",
      "native app prompt"
    );
    const nativeAppAnswer = event(
      "claude-a2",
      "2026-09-04T05:01:01Z",
      "assistant",
      "native app answer"
    );

    expect(
      verifiedNativeConversationSuffixEvents(canonical, [
        ...canonical.map((item) => ({
          ...item,
          id: `copy-${item.id}`,
          chunk_id: `copy-${item.id}`,
        })),
        nativeAppUser,
        nativeAppAnswer,
      ])
    ).toEqual([nativeAppUser, nativeAppAnswer]);
    expect(
      verifiedNativeConversationSuffixEvents(canonical, [
        event("different-u", "2026-09-04T05:00:00Z", "user", "branch"),
        event("different-a", "2026-09-04T05:00:01Z", "assistant", "answer"),
      ])
    ).toBeNull();
  });

  it("resolves children with a known creation time in creation order", () => {
    const children = resolveLocalExecutionChildren(
      [
        { sessionId: "later" },
        { sessionId: "unknown-created" },
        { sessionId: "earlier" },
        { sessionId: "earlier" },
      ],
      new Map([
        ["later", "2026-09-04T06:10:00Z"],
        ["unknown-created", undefined],
        ["earlier", "2026-09-04T05:58:37Z"],
      ]),
      new Map([
        ["later", "2026-09-04T06:12:00Z"],
        ["unknown-created", undefined],
        ["earlier", "2026-09-04T06:00:00Z"],
      ])
    );
    expect(children).toEqual([
      {
        session_id: "earlier",
        created_at: "2026-09-04T05:58:37Z",
        updated_at: "2026-09-04T06:00:00Z",
      },
      {
        session_id: "later",
        created_at: "2026-09-04T06:10:00Z",
        updated_at: "2026-09-04T06:12:00Z",
      },
    ]);
  });

  it("returns one stable root-plus-child snapshot for the replay owner", async () => {
    const children = [
      {
        sessionId: "cliagent-claude-child",
        createdAt: "2026-09-04T05:01:00Z",
        updatedAt: "2026-09-04T05:02:00Z",
      },
    ];
    mocks.invokeTauri.mockResolvedValue(children);
    mocks.loadCliRevision.mockResolvedValue("native-v1");
    mocks.loadCanonical.mockImplementation(async (sessionId: string) => ({
      source: "native_store",
      events:
        sessionId === "root-1"
          ? [event("root-a", "2026-09-04T05:00:00Z", "assistant", "root")]
          : [
              event(
                "child-copy-a",
                "2026-09-04T05:00:00Z",
                "assistant",
                "root"
              ),
              event("child-a", "2026-09-04T05:02:00Z", "assistant", "child"),
            ],
    }));

    await expect(
      loadLocalCanonicalConversationSnapshot({
        authority: "local-session",
        authorityScope: [],
        conversationId: "root-1",
      })
    ).resolves.toMatchObject({
      events: [
        expect.objectContaining({ displayText: "root" }),
        expect.objectContaining({ displayText: "child" }),
      ],
      rootEvents: [expect.objectContaining({ displayText: "root" })],
      segments: [
        {
          child: expect.objectContaining({
            session_id: "cliagent-claude-child",
          }),
          events: expect.arrayContaining([
            expect.objectContaining({ displayText: "child" }),
          ]),
        },
      ],
      childRevision: JSON.stringify([
        [
          "cliagent-claude-child",
          "2026-09-04T05:01:00Z",
          "2026-09-04T05:02:00Z",
          "native-v1",
        ],
      ]),
    });
    expect(mocks.invokeTauri).toHaveBeenCalledTimes(2);
    expect(mocks.loadCliRevision).toHaveBeenCalledTimes(3);
  });

  it("rejects a snapshot when the native App appends during a child read", async () => {
    mocks.invokeTauri.mockResolvedValue([
      {
        sessionId: "cliagent-codex-child",
        createdAt: "2026-09-04T05:01:00Z",
        updatedAt: "2026-09-04T05:02:00Z",
        status: "completed",
        isTerminal: true,
      },
    ]);
    mocks.loadCliRevision
      .mockResolvedValueOnce("native-before")
      .mockResolvedValue("native-after");
    mocks.loadCanonical.mockResolvedValue({
      source: "native_store",
      events: [event("event", "2026-09-04T05:02:00Z", "assistant", "body")],
    });

    await expect(
      loadLocalCanonicalConversationSnapshot({
        authority: "local-session",
        authorityScope: [],
        conversationId: "root-1",
      })
    ).resolves.toMatchObject({ childRevision: null });
  });

  it("rejects a snapshot when the native App appends before the final frontier check", async () => {
    mocks.invokeTauri.mockResolvedValue([
      {
        sessionId: "cliagent-claude-child",
        createdAt: "2026-09-04T05:01:00Z",
        updatedAt: "2026-09-04T05:02:00Z",
      },
    ]);
    mocks.loadCliRevision
      .mockResolvedValueOnce("native-before")
      .mockResolvedValueOnce("native-before")
      .mockResolvedValueOnce("native-after");
    mocks.loadCanonical.mockResolvedValue({
      source: "native_store",
      events: [event("event", "2026-09-04T05:02:00Z", "assistant", "body")],
    });

    await expect(
      loadLocalCanonicalConversationSnapshot({
        authority: "local-session",
        authorityScope: [],
        conversationId: "root-1",
      })
    ).resolves.toMatchObject({ childRevision: null });
  });

  it("keeps a running child with an unavailable native transcript pending", async () => {
    mocks.invokeTauri.mockResolvedValue([
      {
        sessionId: "cliagent-legacy-cursor-child",
        createdAt: "2026-09-04T05:01:00Z",
        updatedAt: "2026-09-04T05:02:00Z",
        status: "running",
        isTerminal: false,
      },
    ]);
    mocks.loadCliRevision.mockResolvedValue(null);
    mocks.loadCanonical.mockResolvedValue({
      source: "native_store",
      events: [event("event", "2026-09-04T05:02:00Z", "assistant", "body")],
    });

    await expect(
      loadLocalCanonicalConversationSnapshot({
        authority: "local-session",
        authorityScope: [],
        conversationId: "root-1",
      })
    ).resolves.toMatchObject({ childRevision: null });
    await expect(
      loadLocalCanonicalConversationTimeline({
        authority: "local-session",
        authorityScope: [],
        conversationId: "root-1",
      })
    ).rejects.toBeInstanceOf(QueuedConversationRecoveryPendingError);
  });

  it("blocks a settled child whose native transcript is unavailable until manual retry", async () => {
    mocks.invokeTauri.mockResolvedValue([
      {
        sessionId: "cliagent-codex-settled-child",
        createdAt: "2026-09-04T05:01:00Z",
        updatedAt: "2026-09-04T05:02:00Z",
        status: "completed",
        isTerminal: true,
      },
    ]);
    mocks.loadCliRevision
      .mockResolvedValueOnce(null)
      .mockResolvedValue("native-restored");
    mocks.loadCanonical.mockResolvedValue({
      source: "native_store",
      events: [event("event", "2026-09-04T05:02:00Z", "assistant", "body")],
    });

    await expect(
      loadLocalCanonicalConversationTimeline({
        authority: "local-session",
        authorityScope: [],
        conversationId: "root-1",
      })
    ).rejects.toBeInstanceOf(QueuedConversationBlockedError);
    await expect(
      loadLocalCanonicalConversationTimeline({
        authority: "local-session",
        authorityScope: [],
        conversationId: "root-1",
      })
    ).resolves.toEqual([expect.objectContaining({ displayText: "body" })]);
  });

  it("blocks an idle child whose native transcript is unavailable", async () => {
    mocks.invokeTauri.mockResolvedValue([
      {
        sessionId: "cliagent-member-idle-child",
        createdAt: "2026-09-04T05:01:00Z",
        updatedAt: "2026-09-04T05:02:00Z",
        status: "idle",
        isTerminal: false,
      },
    ]);
    mocks.loadCliRevision.mockResolvedValue(null);
    mocks.loadCanonical.mockResolvedValue({
      source: "native_store",
      events: [],
    });

    await expect(
      loadLocalCanonicalConversationTimeline({
        authority: "local-session",
        authorityScope: [],
        conversationId: "root-1",
      })
    ).rejects.toBeInstanceOf(QueuedConversationBlockedError);
  });

  it("immediately rereads an unstable canonical timeline once", async () => {
    mocks.invokeTauri.mockResolvedValue([
      {
        sessionId: "cliagent-codex-child",
        createdAt: "2026-09-04T05:01:00Z",
        updatedAt: "2026-09-04T05:02:00Z",
      },
    ]);
    mocks.loadCliRevision
      .mockResolvedValueOnce("native-v1")
      .mockResolvedValueOnce("native-v2")
      .mockResolvedValue("native-v2");
    mocks.loadCanonical.mockResolvedValue({
      source: "native_store",
      events: [event("event", "2026-09-04T05:02:00Z", "assistant", "body")],
    });

    await expect(
      loadLocalCanonicalConversationTimeline({
        authority: "local-session",
        authorityScope: [],
        conversationId: "root-1",
      })
    ).resolves.toEqual([expect.objectContaining({ displayText: "body" })]);
    expect(mocks.loadCliRevision).toHaveBeenCalledTimes(6);
  });

  it("returns typed recovery pending after two unstable canonical reads", async () => {
    mocks.invokeTauri.mockResolvedValue([
      {
        sessionId: "cliagent-codex-child",
        createdAt: "2026-09-04T05:01:00Z",
        updatedAt: "2026-09-04T05:02:00Z",
      },
    ]);
    mocks.loadCliRevision
      .mockResolvedValueOnce("native-v1")
      .mockResolvedValueOnce("native-v2")
      .mockResolvedValueOnce("native-v2")
      .mockResolvedValueOnce("native-v2")
      .mockResolvedValueOnce("native-v3")
      .mockResolvedValueOnce("native-v3");
    mocks.loadCanonical.mockResolvedValue({
      source: "native_store",
      events: [event("event", "2026-09-04T05:02:00Z", "assistant", "body")],
    });

    await expect(
      loadLocalCanonicalConversationTimeline({
        authority: "local-session",
        authorityScope: [],
        conversationId: "root-1",
      })
    ).rejects.toBeInstanceOf(QueuedConversationRecoveryPendingError);
    expect(mocks.loadCliRevision).toHaveBeenCalledTimes(6);
  });

  it("folds successive provider episodes into one runtime-switch timeline", () => {
    const rootEvents = [
      event("codex-u1", "2026-09-04T05:00:00Z", "user", "round one"),
      event("codex-a1", "2026-09-04T05:00:01Z", "assistant", "one"),
    ];
    // The same Claude UUID was resumed for rounds two and three, so its latest
    // native transcript contains both suffixes after the materialized Codex
    // prefix. Returning to Codex consumes this complete canonical timeline.
    const claudeEvents = [
      event("claude-copy-u1", "2026-09-04T05:01:00Z", "user", "round one"),
      event("claude-copy-a1", "2026-09-04T05:01:01Z", "assistant", "one"),
      event("claude-u2", "2026-09-04T05:02:00Z", "user", "round two"),
      event("claude-a2", "2026-09-04T05:02:01Z", "assistant", "two"),
      event("claude-u3", "2026-09-04T05:03:00Z", "user", "round three"),
      event("claude-a3", "2026-09-04T05:03:01Z", "assistant", "three"),
    ];
    const segments = [
      {
        child: {
          session_id: "claude-child",
          created_at: "2026-09-04T05:01:00Z",
        },
        events: claudeEvents,
      },
    ];
    expect(
      mergeVerifiedLocalExecutionTimeline(rootEvents, segments).map(
        (candidate) => candidate.displayText
      )
    ).toEqual(["round one", "one", "round two", "two", "round three", "three"]);
    expect(
      projectVerifiedLocalExecutionTail(rootEvents, segments, "codex-root").map(
        (candidate) => [candidate.sessionId, candidate.displayText]
      )
    ).toEqual([
      ["codex-root", "round two"],
      ["codex-root", "two"],
      ["codex-root", "round three"],
      ["codex-root", "three"],
    ]);

    // Once Codex is synchronized and resumed, the root itself contains the
    // Claude rounds plus the new Codex suffix. Replaying the older Claude
    // child must not append those rounds a second time.
    const returnedCodexEvents = [
      ...rootEvents,
      ...claudeEvents.slice(rootEvents.length),
      event("codex-u4", "2026-09-04T05:04:00Z", "user", "round four"),
      event("codex-a4", "2026-09-04T05:04:01Z", "assistant", "four"),
    ];
    expect(
      mergeVerifiedLocalExecutionTimeline(returnedCodexEvents, segments).map(
        (candidate) => candidate.displayText
      )
    ).toEqual([
      "round one",
      "one",
      "round two",
      "two",
      "round three",
      "three",
      "round four",
      "four",
    ]);
  });

  it("orders a later child's original turn ahead of a reused child's injected copy", () => {
    const rootEvents = [
      event("root-u1", "2026-09-06T03:00:00Z", "user", "who are you"),
      event("root-a1", "2026-09-06T03:00:01Z", "assistant", "an agent"),
    ];
    // The Codex child ran turns A and C. Turn B ran in the Claude child and
    // was injected back into the Codex thread before C; Codex stamped that
    // copy with the injection time, after B's real timestamps.
    const codexEvents = [
      event("codex-copy-u1", "2026-09-06T03:32:18Z", "user", "who are you"),
      event("codex-copy-a1", "2026-09-06T03:32:18Z", "assistant", "an agent"),
      event("codex-uA", "2026-09-06T03:32:44Z", "user", "prompt A"),
      event("codex-aA", "2026-09-06T03:33:11Z", "assistant", "reply A"),
      event("codex-copy-uB", "2026-09-06T03:50:09Z", "user", "prompt B"),
      event("codex-copy-aB", "2026-09-06T03:50:09Z", "assistant", "reply B"),
      event("codex-uC", "2026-09-06T03:50:30Z", "user", "prompt C"),
      event("codex-aC", "2026-09-06T03:50:36Z", "assistant", "reply C"),
    ];
    const claudeEvents = [
      event("claude-copy-u1", "2026-09-06T03:00:00Z", "user", "who are you"),
      event("claude-copy-a1", "2026-09-06T03:00:01Z", "assistant", "an agent"),
      event("claude-copy-uA", "2026-09-06T03:32:44Z", "user", "prompt A"),
      event("claude-copy-aA", "2026-09-06T03:33:11Z", "assistant", "reply A"),
      event("claude-uB", "2026-09-06T03:48:32Z", "user", "prompt B"),
      event("claude-aB", "2026-09-06T03:48:35Z", "assistant", "reply B"),
      event("claude-copy-uC", "2026-09-06T03:50:30Z", "user", "prompt C"),
      event("claude-copy-aC", "2026-09-06T03:50:36Z", "assistant", "reply C"),
      event("claude-uD", "2026-09-06T03:51:53Z", "user", "prompt D"),
      event("claude-aD", "2026-09-06T03:51:55Z", "assistant", "reply D"),
    ];
    const segments = [
      {
        child: {
          session_id: "codex-child",
          created_at: "2026-09-06T03:32:12Z",
        },
        events: codexEvents,
      },
      {
        child: {
          session_id: "claude-child",
          created_at: "2026-09-06T03:48:30Z",
        },
        events: claudeEvents,
      },
    ];

    expect(
      mergeVerifiedLocalExecutionTimeline(rootEvents, segments).map(
        (candidate) => candidate.id
      )
    ).toEqual([
      "root-u1",
      "root-a1",
      "codex-uA",
      "codex-aA",
      "claude-uB",
      "claude-aB",
      "codex-uC",
      "codex-aC",
      "claude-uD",
      "claude-aD",
    ]);
  });

  it("folds a provider child when native tool call ids were rewritten", () => {
    const rootTool = {
      ...event(
        "codex-tool",
        "2026-09-04T20:15:15.000Z",
        "assistant",
        "file contents"
      ),
      functionName: "read_file",
      actionType: "tool_call",
      callId: "call_codex:part-0",
      args: { path: "CLAUDE.md" },
      result: { status: "completed", output: "file contents" },
    } as SessionEvent;
    const rootEvents = [
      event("codex-u1", "2026-09-04T20:15:14.000Z", "user", "inspect"),
      rootTool,
      event("codex-a1", "2026-09-04T20:15:16.000Z", "assistant", "done"),
    ];
    const childEvents = [
      event("claude-u1", "2026-09-04T20:15:14.000Z", "user", "inspect"),
      {
        ...rootTool,
        id: "claude-tool",
        chunk_id: "claude-tool",
        callId: "call_claude_rewritten",
      },
      event("claude-a1", "2026-09-04T20:15:16.000Z", "assistant", "done"),
      event(
        "claude-u2",
        "2026-09-04T22:06:46.000Z",
        "user",
        "native app prompt"
      ),
      event(
        "claude-a2",
        "2026-09-04T22:06:52.000Z",
        "assistant",
        "native app answer"
      ),
    ];

    expect(
      projectVerifiedLocalExecutionTail(
        rootEvents,
        [
          {
            child: {
              session_id: "claude-child",
              created_at: "2026-09-04T21:15:47.329Z",
            },
            events: childEvents,
          },
        ],
        "codex-root"
      ).map((candidate) => candidate.displayText)
    ).toEqual(["native app prompt", "native app answer"]);
  });

  it("projects a reused child when the root already shows its newest optimistic user row", () => {
    const rootNative = [
      event(
        "codex-u1",
        "2026-09-04T20:15:14.324Z",
        "user",
        "Reply exactly CU_PR939_PRIMARY_CODEX_NATIVE_FIXED_20260905_OK"
      ),
      event(
        "codex-a1",
        "2026-09-04T20:15:16.936Z",
        "assistant",
        "CU_PR939_PRIMARY_CODEX_NATIVE_FIXED_20260905_OK"
      ),
    ];
    const newestOptimistic = event(
      optimisticQueueUserEventId("hydration-retest"),
      "2026-09-04T22:06:46.141Z",
      "user",
      "Reply exactly CU_CHILD_HYDRATION_RETEST_20260905_OK"
    );
    newestOptimistic.result = { turnIntentId: "hydration-retest" };
    const newestLanded = event(
      "claude-u3",
      "2026-09-04T22:06:46.246Z",
      "user",
      "Reply exactly CU_CHILD_HYDRATION_RETEST_20260905_OK"
    );
    newestLanded.result = { turnIntentId: "hydration-retest" };
    const childEvents = [
      ...rootNative.map((item) => ({
        ...item,
        id: `claude-copy-${item.id}`,
        chunk_id: `claude-copy-${item.id}`,
      })),
      event(
        "claude-u2",
        "2026-09-04T21:46:48.894Z",
        "user",
        "Reply exactly CU_UI_CHILD_REFRESH_FIXED_20260905_OK"
      ),
      event(
        "claude-a2",
        "2026-09-04T21:46:54.459Z",
        "assistant",
        "CU_UI_CHILD_REFRESH_FIXED_20260905_OK"
      ),
      newestLanded,
      event(
        "claude-a3",
        "2026-09-04T22:06:52.068Z",
        "assistant",
        "CU_CHILD_HYDRATION_RETEST_20260905_OK"
      ),
    ];

    // The optimistic root row is chronologically newest but appears before
    // every projected child suffix in the input array. It must not participate
    // in native-prefix verification or it hides both completed Claude turns.
    const tail = projectVerifiedLocalExecutionTail(
      [...rootNative, newestOptimistic],
      [
        {
          child: {
            session_id: "claude-child",
            created_at: "2026-09-04T21:15:47.329Z",
          },
          events: childEvents,
        },
      ],
      "codex-root"
    );
    expect(tail.map((candidate) => candidate.displayText)).toEqual([
      "Reply exactly CU_UI_CHILD_REFRESH_FIXED_20260905_OK",
      "CU_UI_CHILD_REFRESH_FIXED_20260905_OK",
      "Reply exactly CU_CHILD_HYDRATION_RETEST_20260905_OK",
      "CU_CHILD_HYDRATION_RETEST_20260905_OK",
    ]);
    expect(
      suppressLandedQueuedUserRows([...rootNative, newestOptimistic], tail).map(
        (candidate) => candidate.id
      )
    ).toEqual(rootNative.map((candidate) => candidate.id));
  });

  it("folds a provider-native compact marker after its verified history", () => {
    const rootEvents = [
      event("root-u1", "2026-09-04T05:00:00Z", "user", "old question"),
      event("root-a1", "2026-09-04T05:00:01Z", "assistant", "old answer"),
    ];
    const compact = {
      ...event(
        "compact-1",
        "2026-09-04T05:01:00Z",
        "assistant",
        "summary of the old exchange"
      ),
      functionName: "context_compacted",
      actionType: "context_compacted",
    } as SessionEvent;
    const childEvents = [
      event("copy-u1", "2026-09-04T05:00:00Z", "user", "old question"),
      event("copy-a1", "2026-09-04T05:00:01Z", "assistant", "old answer"),
      compact,
      event("child-u2", "2026-09-04T05:02:00Z", "user", "new question"),
      event("child-a2", "2026-09-04T05:02:01Z", "assistant", "new answer"),
    ];
    const merged = mergeVerifiedLocalExecutionTimeline(rootEvents, [
      {
        child: {
          session_id: "compacted-child",
          created_at: "2026-09-04T05:01:00Z",
        },
        events: childEvents,
      },
    ]);
    expect(merged.map((candidate) => candidate.id)).toEqual([
      "root-u1",
      "root-a1",
      "compact-1",
      "child-u2",
      "child-a2",
    ]);
  });

  it("folds a second native compact from the prior effective message list", () => {
    const firstCompact = {
      ...event(
        "compact-1",
        "2026-09-04T05:01:00Z",
        "assistant",
        "first summary"
      ),
      functionName: "context_compacted",
      actionType: "context_compacted",
    } as SessionEvent;
    const canonical = [
      event("old-u", "2026-09-04T05:00:00Z", "user", "old question"),
      event("old-a", "2026-09-04T05:00:01Z", "assistant", "old answer"),
      firstCompact,
      event("u2", "2026-09-04T05:02:00Z", "user", "after first"),
      event("a2", "2026-09-04T05:02:01Z", "assistant", "answer two"),
    ];
    const secondCompact = {
      ...event(
        "compact-2",
        "2026-09-04T05:03:01Z",
        "assistant",
        "second summary"
      ),
      functionName: "context_compacted",
      actionType: "context_compacted",
    } as SessionEvent;
    const childEvents = [
      { ...firstCompact, id: "copy-compact-1", chunk_id: "copy-compact-1" },
      event("copy-u2", "2026-09-04T05:02:00Z", "user", "after first"),
      event("copy-a2", "2026-09-04T05:02:01Z", "assistant", "answer two"),
      event("u3", "2026-09-04T05:03:00Z", "user", "trigger compact"),
      secondCompact,
      event("a3", "2026-09-04T05:03:02Z", "assistant", "answer three"),
    ];
    expect(
      mergeVerifiedLocalExecutionTimeline(canonical, [
        {
          child: {
            session_id: "second-compact-child",
            created_at: "2026-09-04T05:03:00Z",
          },
          events: childEvents,
        },
      ]).map((candidate) => candidate.id)
    ).toEqual([
      "old-u",
      "old-a",
      "compact-1",
      "u2",
      "a2",
      "u3",
      "compact-2",
      "a3",
    ]);
  });

  it("keeps an interrupted portable suffix but drops its unresolved tool call", () => {
    const rootEvents = [
      event("root-u1", "2026-09-04T05:00:00Z", "user", "inspect"),
      event("root-a1", "2026-09-04T05:00:01Z", "assistant", "starting"),
    ];
    const completedTool = {
      ...event(
        "tool-complete",
        "2026-09-04T05:01:01Z",
        "assistant",
        "file contents"
      ),
      functionName: "read_file",
      actionType: "tool_call",
      callId: "call_complete",
      args: { path: "README.md" },
      result: { status: "completed", output: "file contents" },
    } as SessionEvent;
    const unresolvedTool = {
      ...completedTool,
      id: "tool-open",
      chunk_id: "tool-open",
      callId: "call_open",
      displayStatus: "running",
      result: { status: "running" },
    } as SessionEvent;
    const childEvents = [
      event("copy-u1", "2026-09-04T05:00:00Z", "user", "inspect"),
      event("copy-a1", "2026-09-04T05:00:01Z", "assistant", "starting"),
      event("child-u2", "2026-09-04T05:01:00Z", "user", "continue"),
      completedTool,
      event(
        "child-partial",
        "2026-09-04T05:01:02Z",
        "assistant",
        "partial result"
      ),
      unresolvedTool,
    ];
    const merged = mergeVerifiedLocalExecutionTimeline(rootEvents, [
      {
        child: {
          session_id: "interrupted-child",
          created_at: "2026-09-04T05:01:00Z",
        },
        events: childEvents,
      },
    ]);
    expect(merged.map((candidate) => candidate.id)).toEqual([
      "root-u1",
      "root-a1",
      "child-u2",
      "tool-complete",
      "child-partial",
    ]);
  });

  it("drops the queue-synthesized pending row once the same user turn landed", () => {
    const pending = event(
      optimisticQueueUserEventId("intent-1"),
      "2026-09-04T05:58:37Z",
      "user",
      "Reply with exactly MARKER"
    );
    pending.result = { turnIntentId: "intent-1" };
    const otherPending = event(
      optimisticQueueUserEventId("intent-2"),
      "2026-09-04T05:59:00Z",
      "user",
      "another queued message"
    );
    otherPending.result = { turnIntentId: "intent-2" };
    const history = event("hist-1", "2026-08-31T10:34:04Z", "user", "old");
    const landedUser = event(
      "runlanded-user-1",
      "2026-09-04T05:58:44Z",
      "user",
      "Reply with exactly MARKER "
    );
    landedUser.result = { turnIntentId: "intent-1" };
    expect(pending.id).toBe("queued-user:intent-1:");
    expect(
      suppressLandedQueuedUserRows(
        [history, pending, otherPending],
        [landedUser]
      ).map((candidate) => candidate.id)
    ).toEqual(["hist-1", optimisticQueueUserEventId("intent-2")]);
    expect(suppressLandedQueuedUserRows([history, pending], [])).toHaveLength(
      2
    );
  });

  it("collapses repeated projections of the same identified retry only", () => {
    const first = event("u-try-1", "2026-09-06T04:39:28Z", "user", "Reply now");
    const second = event(
      "u-try-2",
      "2026-09-06T04:53:27Z",
      "user",
      "Reply now"
    );
    const third = event("u-try-3", "2026-09-06T05:39:00Z", "user", "Reply now");
    const reply = event("a-final", "2026-09-06T05:39:15Z", "assistant", "done");
    const later = event("u-again", "2026-09-06T05:40:00Z", "user", "Reply now");
    for (const retry of [first, second, third]) {
      retry.result = { turnIntentId: "retry-intent" };
    }
    later.result = { turnIntentId: "later-intent" };
    expect(
      collapseRetriedPromptCopies([first, second, third, reply, later]).map(
        (candidate) => candidate.id
      )
    ).toEqual(["u-try-3", "a-final", "u-again"]);
  });

  it("keeps equal text from distinct intents and attachments", () => {
    const first = event("u-first", "2026-09-06T05:39:00Z", "user", "same");
    first.result = {
      turnIntentId: "intent-first",
      images: ["data:image/png;base64,first"],
    };
    const second = event("u-second", "2026-09-06T05:39:01Z", "user", "same");
    second.result = {
      turnIntentId: "intent-second",
      images: ["data:image/png;base64,second"],
    };
    const legacy = event("u-legacy", "2026-09-06T05:39:02Z", "user", "same");

    expect(
      collapseRetriedPromptCopies([first, second, legacy]).map(
        (candidate) => candidate.id
      )
    ).toEqual(["u-first", "u-second", "u-legacy"]);
  });

  it("keeps a failed optimistic row and drops the child's landed copy of it", () => {
    const failed = {
      ...event(
        optimisticQueueUserEventId("intent-failed"),
        "2026-09-06T04:39:19Z",
        "user",
        "Reply with exactly REJECTED"
      ),
      displayStatus: "failed" as const,
      result: {
        deliveryStatus: "failed",
        deliveryError: "model not supported",
        turnIntentId: "turn-failed",
      },
    };
    const landedUser = event(
      "runlanded-user-rejected",
      "2026-09-06T04:39:20Z",
      "user",
      "Reply with exactly REJECTED"
    );
    landedUser.result = { turnIntentId: "turn-failed" };
    const landedOther = event(
      "runlanded-assistant-1",
      "2026-09-06T04:39:21Z",
      "assistant",
      "unrelated reply"
    );
    const landedRetryCopy = event(
      "runlanded-user-rejected-retry",
      "2026-09-06T04:53:27Z",
      "user",
      "Reply with exactly REJECTED"
    );
    landedRetryCopy.result = { turnIntentId: "turn-failed" };
    const landedEarlierSamePrompt = event(
      "runlanded-user-earlier",
      "2026-09-06T04:10:00Z",
      "user",
      "Reply with exactly REJECTED"
    );
    landedEarlierSamePrompt.result = { turnIntentId: "turn-earlier" };
    expect(
      suppressLandedQueuedUserRows([failed], [landedUser]).map(
        (candidate) => candidate.id
      )
    ).toEqual([failed.id]);
    expect(
      suppressLandedRowsOfFailedQueuedTurns(
        [failed],
        [landedEarlierSamePrompt, landedUser, landedOther, landedRetryCopy]
      ).map((candidate) => candidate.id)
    ).toEqual(["runlanded-user-earlier", "runlanded-assistant-1"]);
    expect(
      suppressLandedRowsOfFailedQueuedTurns([], [landedUser]).map(
        (candidate) => candidate.id
      )
    ).toEqual(["runlanded-user-rejected"]);
  });

  it("does not hide a later answered turn that repeats failed text", () => {
    const failed = {
      ...event(
        optimisticQueueUserEventId("failed-row"),
        "2026-09-06T04:39:19Z",
        "user",
        "same prompt"
      ),
      displayStatus: "failed" as const,
      result: { deliveryStatus: "failed", turnIntentId: "failed-intent" },
    };
    const failedEcho = event(
      "failed-echo",
      "2026-09-06T04:39:20Z",
      "user",
      "same prompt"
    );
    failedEcho.result = { turnIntentId: "failed-intent" };
    const later = event(
      "later-user",
      "2026-09-06T04:40:00Z",
      "user",
      "same prompt"
    );
    later.result = {
      turnIntentId: "answered-intent",
      images: ["data:image/png;base64,later"],
    };
    const answer = event(
      "later-answer",
      "2026-09-06T04:40:01Z",
      "assistant",
      "answered"
    );
    const legacyWithoutIdentity = event(
      "legacy-user",
      "2026-09-06T04:40:02Z",
      "user",
      "same prompt"
    );

    expect(
      suppressLandedRowsOfFailedQueuedTurns(
        [failed],
        [failedEcho, later, answer, legacyWithoutIdentity]
      ).map((candidate) => candidate.id)
    ).toEqual(["later-user", "later-answer", "legacy-user"]);
  });

  it("suppresses only one matching optimistic row for repeated prompt text", () => {
    const first = event(
      optimisticQueueUserEventId("repeat-1"),
      "2026-09-04T05:58:37Z",
      "user",
      "same prompt"
    );
    first.result = { turnIntentId: "repeat-1" };
    const second = event(
      optimisticQueueUserEventId("repeat-2"),
      "2026-09-04T05:59:00Z",
      "user",
      "same prompt"
    );
    second.result = { turnIntentId: "repeat-2" };
    const landed = event(
      "runlanded-repeat-2",
      "2026-09-04T05:59:01Z",
      "user",
      "same prompt"
    );
    landed.result = { turnIntentId: "repeat-2" };
    expect(
      suppressLandedQueuedUserRows([first, second], [landed]).map(
        (candidate) => candidate.id
      )
    ).toEqual([first.id]);
  });

  it("keeps optimistic rows when equal landed text has no matching identity", () => {
    const pending = event(
      optimisticQueueUserEventId("pending-intent"),
      "2026-09-04T05:58:37Z",
      "user",
      "same prompt"
    );
    pending.result = { turnIntentId: "pending-intent" };
    const differentTurn = event(
      "runlanded-different-turn",
      "2026-09-04T05:58:38Z",
      "user",
      "same prompt"
    );
    differentTurn.result = { turnIntentId: "different-intent" };
    const legacyWithoutIdentity = event(
      "runlanded-legacy",
      "2026-09-04T05:58:39Z",
      "user",
      "same prompt"
    );

    expect(
      suppressLandedQueuedUserRows(
        [pending],
        [differentTurn, legacyWithoutIdentity]
      ).map((candidate) => candidate.id)
    ).toEqual([pending.id]);
  });
});
