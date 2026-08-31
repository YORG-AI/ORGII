import { describe, expect, it } from "vitest";

import {
  MAX_LOCAL_PENDING_ROUNDS,
  MAX_READY_ROUND_BODIES,
  type TranscriptLoadState,
  appendOptimisticUserMessage,
  applyLiveTranscriptSnapshot,
  applyTranscriptRoundResult,
  applyTranscriptSubscribeResult,
  beginTranscriptLoad,
  beginTranscriptRoundLoad,
  confirmOptimisticUserRound,
  createInitialTranscriptLoadState,
  getSelectedTranscriptView,
  rollbackOptimisticUserMessage,
  selectTranscriptRound,
} from "./transcriptLoadState";

function summary(id: string, turnIntentId?: string) {
  return { id, userPreview: `Question ${id}`, turnIntentId };
}

function snapshot(
  sessionId: string,
  roundId: string,
  id: string,
  text: string,
  source: "user" | "assistant" = "assistant",
  version = 1
) {
  return {
    sessionId,
    roundId,
    version,
    snapshotDelta: false,
    upserts: [
      {
        id,
        source,
        displayVariant: "message",
        displayText: text,
      },
    ],
  };
}

function subscribe(
  state: TranscriptLoadState,
  ids: string[],
  generation = state.generation,
  latestText = `Answer ${ids.at(-1)}`
) {
  const sessionId = state.sessionId ?? "session-a";
  const latestId = ids.at(-1);
  return applyTranscriptSubscribeResult(
    state,
    {
      sessionId,
      rounds: { items: ids.map((id) => summary(id)), complete: true },
      snapshot: latestId
        ? snapshot(sessionId, latestId, `agent-${latestId}`, latestText)
        : undefined,
    },
    sessionId,
    generation
  );
}

function loadSelectedRound(
  state: TranscriptLoadState,
  roundId: string,
  requestGeneration: number,
  text = `Answer ${roundId}`
) {
  const sessionId = state.sessionId ?? "session-a";
  const loading = beginTranscriptRoundLoad(
    selectTranscriptRound(state, roundId),
    sessionId,
    roundId,
    requestGeneration
  );
  return applyTranscriptRoundResult(
    loading,
    {
      sessionId,
      roundId,
      snapshot: snapshot(sessionId, roundId, `agent-${roundId}`, text),
    },
    sessionId,
    roundId,
    state.generation,
    requestGeneration
  );
}

describe("round-aware transcriptLoadState", () => {
  it("defaults a three-round subscription to the latest round", () => {
    const loading = beginTranscriptLoad(
      createInitialTranscriptLoadState(),
      "session-a",
      1
    );
    const loaded = subscribe(loading, ["r1", "r2", "r3"]);

    expect(loaded.rounds.map((round) => round.id)).toEqual(["r1", "r2", "r3"]);
    expect(loaded.selectedRoundId).toBeNull();
    expect(getSelectedTranscriptView(loaded)).toMatchObject({
      roundId: "r3",
      phase: "ready",
      items: [expect.objectContaining({ text: "Answer r3" })],
    });
    expect(loaded.bodies.r1.phase).toBe("unloaded");
  });

  it("keeps an older server snapshot visible as an incomplete legacy round", () => {
    const loading = beginTranscriptLoad(
      createInitialTranscriptLoadState(),
      "session-a",
      1
    );
    const loaded = applyTranscriptSubscribeResult(
      loading,
      {
        snapshot: snapshot(
          "session-a",
          "legacy-from-server",
          "legacy-agent",
          "Legacy history"
        ),
      },
      "session-a",
      1
    );

    expect(loaded.rounds).toEqual([
      { id: "legacy-from-server", userPreview: "" },
    ]);
    expect(loaded.roundsComplete).toBe(false);
    expect(getSelectedTranscriptView(loaded).items[0].text).toBe(
      "Legacy history"
    );
  });

  it("preserves a snapshot truncation signal on the selected round", () => {
    const loading = beginTranscriptLoad(
      createInitialTranscriptLoadState(),
      "session-a",
      1
    );
    const loaded = applyTranscriptSubscribeResult(
      loading,
      {
        sessionId: "session-a",
        rounds: { items: [summary("r1")], complete: true },
        snapshot: {
          ...snapshot("session-a", "r1", "agent-r1", "Partial answer"),
          truncated: true,
        },
      },
      "session-a",
      1
    );

    expect(getSelectedTranscriptView(loaded).truncated).toBe(true);
    expect(loaded.bodies.r1.truncated).toBe(true);
  });

  it("loads an older round on demand", () => {
    const initial = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ["r1", "r2", "r3"]
    );
    const loading = beginTranscriptRoundLoad(
      selectTranscriptRound(initial, "r1"),
      "session-a",
      "r1",
      11
    );
    expect(getSelectedTranscriptView(loading).phase).toBe("loading");

    const loaded = applyTranscriptRoundResult(
      loading,
      {
        sessionId: "session-a",
        roundId: "r1",
        snapshot: snapshot("session-a", "r1", "agent-r1", "Old answer"),
      },
      "session-a",
      "r1",
      1,
      11
    );
    expect(getSelectedTranscriptView(loaded)).toMatchObject({
      roundId: "r1",
      phase: "ready",
      items: [expect.objectContaining({ text: "Old answer" })],
    });
  });

  it("ignores superseded round replies after rapid navigation", () => {
    const initial = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ["r1", "r2", "r3"]
    );
    const loadingR1 = beginTranscriptRoundLoad(
      selectTranscriptRound(initial, "r1"),
      "session-a",
      "r1",
      21
    );
    const loadingR2 = beginTranscriptRoundLoad(
      selectTranscriptRound(loadingR1, "r2"),
      "session-a",
      "r2",
      22
    );
    const stale = applyTranscriptRoundResult(
      loadingR2,
      {
        sessionId: "session-a",
        roundId: "r1",
        snapshot: snapshot("session-a", "r1", "stale", "Stale answer"),
      },
      "session-a",
      "r1",
      1,
      21
    );

    expect(stale).toBe(loadingR2);
    expect(stale.selectedRoundId).toBe("r2");
    expect(stale.bodies.r1.phase).toBe("unloaded");
    expect(stale.bodies.r1.items).toEqual([]);
  });

  it("merges live updates into latest without stealing an older selection", () => {
    const initial = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ["r1", "r2", "r3"]
    );
    const viewingOld = loadSelectedRound(initial, "r1", 31, "Old page");
    const live = applyLiveTranscriptSnapshot(viewingOld, {
      sessionId: "session-a",
      version: 2,
      snapshotDelta: true,
      upserts: [
        {
          id: "latest-live",
          source: "assistant",
          displayVariant: "message",
          displayText: "Latest update",
        },
      ],
    });

    expect(live.selectedRoundId).toBe("r1");
    expect(
      getSelectedTranscriptView(live).items.map((item) => item.text)
    ).toEqual(["Old page"]);
    expect(live.bodies.r3.items.map((item) => item.text)).toEqual([
      "Answer r3",
      "Latest update",
    ]);
  });

  it("preserves loaded old bodies when a full refresh keeps their round ids", () => {
    const initial = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ["r1", "r2", "r3"]
    );
    const viewingOld = loadSelectedRound(initial, "r1", 41, "Cached old");
    const refreshed = subscribe(
      beginTranscriptLoad(viewingOld, "session-a", 2),
      ["r1", "r2", "r3", "r4"],
      2,
      "New latest"
    );

    expect(refreshed.selectedRoundId).toBe("r1");
    expect(refreshed.bodies.r1).toMatchObject({
      phase: "ready",
      items: [expect.objectContaining({ text: "Cached old" })],
    });
    expect(refreshed.bodies.r4.items[0].text).toBe("New latest");
  });

  it("switches to follow-latest and keeps the optimistic send visible", () => {
    const initial = loadSelectedRound(
      subscribe(
        beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
        ["r1", "r2", "r3"]
      ),
      "r1",
      51
    );
    const optimistic = appendOptimisticUserMessage(
      initial,
      "session-a",
      "intent-1",
      "New question",
      "2026-08-30T10:00:00Z"
    );

    expect(optimistic.selectedRoundId).toBeNull();
    expect(optimistic.rounds.map((round) => round.id)).toEqual([
      "r1",
      "r2",
      "r3",
      "local-pending:intent-1",
    ]);
    expect(getSelectedTranscriptView(optimistic).items.at(-1)).toMatchObject({
      text: "New question",
      optimistic: true,
    });
    expect(optimistic.bodies.r3.items.map((item) => item.text)).toEqual([
      "Answer r3",
    ]);

    const rolledBack = rollbackOptimisticUserMessage(
      optimistic,
      "session-a",
      "intent-1"
    );
    expect(rolledBack.rounds.map((round) => round.id)).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
    expect(getSelectedTranscriptView(rolledBack).roundId).toBe("r3");
    expect(rolledBack.bodies["local-pending:intent-1"]).toBeUndefined();
  });

  it("moves an optimistic send into a newly indexed latest round", () => {
    const initial = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ["r1"]
    );
    const optimistic = appendOptimisticUserMessage(
      initial,
      "session-a",
      "intent-new-round",
      "Question before refresh"
    );
    const refreshed = applyTranscriptSubscribeResult(
      beginTranscriptLoad(optimistic, "session-a", 2),
      {
        sessionId: "session-a",
        rounds: {
          items: [summary("r1"), summary("r2")],
          complete: true,
        },
        snapshot: {
          sessionId: "session-a",
          roundId: "r2",
          version: 2,
          snapshotDelta: false,
          upserts: [
            {
              id: "persisted-user",
              turnIntentId: "intent-new-round",
              source: "user",
              displayVariant: "message",
              displayText: "Question before refresh",
            },
            {
              id: "response",
              source: "assistant",
              displayVariant: "message",
              displayText: "Response raced first",
            },
          ],
        },
      },
      "session-a",
      2
    );

    expect(refreshed.bodies.r1.items.some((item) => item.optimistic)).toBe(
      false
    );
    expect(refreshed.bodies.r2.items.map((item) => item.text)).toEqual([
      "Question before refresh",
      "Response raced first",
    ]);
  });

  it("promotes a local round only from an exact authoritative round id", () => {
    const initial = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ["r1"]
    );
    const optimistic = appendOptimisticUserMessage(
      initial,
      "session-a",
      "intent-exact",
      "Question now"
    );
    const confirmed = confirmOptimisticUserRound(
      optimistic,
      "session-a",
      "intent-exact",
      "codex-user-42"
    );

    expect(confirmed.rounds.map((round) => round.id)).toEqual([
      "r1",
      "codex-user-42",
    ]);
    expect(getSelectedTranscriptView(confirmed)).toMatchObject({
      roundId: "codex-user-42",
      items: [expect.objectContaining({ text: "Question now" })],
    });
  });

  it("keeps the pending round after its optimistic row is replaced before indexing", () => {
    const initial = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ["r1"]
    );
    const optimistic = appendOptimisticUserMessage(
      initial,
      "session-a",
      "intent-echo-first",
      "Question now"
    );
    const echoed = applyLiveTranscriptSnapshot(optimistic, {
      sessionId: "session-a",
      version: 2,
      snapshotDelta: true,
      upserts: [
        {
          id: "persisted-user",
          turnIntentId: "intent-echo-first",
          source: "user",
          displayVariant: "message",
          displayText: "Question now",
        },
      ],
    });
    const refreshed = applyTranscriptSubscribeResult(
      beginTranscriptLoad(echoed, "session-a", 2),
      {
        sessionId: "session-a",
        rounds: { items: [summary("r1")], complete: true },
      },
      "session-a",
      2
    );

    expect(refreshed.rounds.map((round) => round.id)).toEqual([
      "r1",
      "local-pending:intent-echo-first",
    ]);
    expect(getSelectedTranscriptView(refreshed).items).toEqual([
      expect.objectContaining({ id: "persisted-user", text: "Question now" }),
    ]);
  });

  it("keeps the provisional round when a new index has no turn identity", () => {
    const initial = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ["r1"]
    );
    const optimistic = appendOptimisticUserMessage(
      initial,
      "session-a",
      "intent-without-snapshot",
      "Question before index"
    );
    const live = applyLiveTranscriptSnapshot(optimistic, {
      sessionId: "session-a",
      version: 2,
      snapshotDelta: true,
      upserts: [
        {
          id: "live-answer",
          source: "assistant",
          displayVariant: "message",
          displayText: "Answer before index",
        },
      ],
    });
    const refreshing = beginTranscriptLoad(live, "session-a", 2);
    const refreshed = applyTranscriptSubscribeResult(
      refreshing,
      {
        sessionId: "session-a",
        rounds: {
          items: [summary("r1"), summary("r2")],
          complete: true,
        },
      },
      "session-a",
      2
    );

    expect(refreshed.rounds.map((round) => round.id)).toEqual([
      "r1",
      "r2",
      "local-pending:intent-without-snapshot",
    ]);
    expect(
      getSelectedTranscriptView(refreshed).items.map((item) => item.text)
    ).toEqual(["Question before index", "Answer before index"]);
  });

  it("does not consume a pending mobile turn when a foreign desktop round appears first", () => {
    const initial = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ["r1"]
    );
    const optimistic = appendOptimisticUserMessage(
      initial,
      "session-a",
      "mobile-intent",
      "Phone question"
    );
    const foreignRefresh = applyTranscriptSubscribeResult(
      beginTranscriptLoad(optimistic, "session-a", 2),
      {
        sessionId: "session-a",
        rounds: {
          items: [summary("r1"), summary("r2")],
          complete: true,
        },
        snapshot: {
          sessionId: "session-a",
          roundId: "r2",
          version: 2,
          snapshotDelta: false,
          upserts: [
            {
              id: "desktop-user",
              turnIntentId: "desktop-intent",
              source: "user",
              displayVariant: "message",
              displayText: "Desktop question",
            },
            {
              id: "desktop-answer",
              source: "assistant",
              displayVariant: "message",
              displayText: "Desktop answer",
            },
          ],
        },
      },
      "session-a",
      2
    );

    expect(foreignRefresh.rounds.map((round) => round.id)).toEqual([
      "r1",
      "r2",
      "local-pending:mobile-intent",
    ]);
    expect(
      getSelectedTranscriptView(foreignRefresh).items.map((item) => item.text)
    ).toEqual(["Phone question"]);

    const mobileRefresh = applyTranscriptSubscribeResult(
      beginTranscriptLoad(foreignRefresh, "session-a", 3),
      {
        sessionId: "session-a",
        rounds: {
          items: [summary("r1"), summary("r2"), summary("r3")],
          complete: true,
        },
        snapshot: {
          sessionId: "session-a",
          roundId: "r3",
          version: 3,
          snapshotDelta: false,
          upserts: [
            {
              id: "phone-user",
              turnIntentId: "mobile-intent",
              source: "user",
              displayVariant: "message",
              displayText: "Phone question",
            },
            {
              id: "phone-answer",
              source: "assistant",
              displayVariant: "message",
              displayText: "Phone answer",
            },
          ],
        },
      },
      "session-a",
      3
    );

    expect(mobileRefresh.rounds.map((round) => round.id)).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
    expect(
      getSelectedTranscriptView(mobileRefresh).items.map((item) => item.text)
    ).toEqual(["Phone question", "Phone answer"]);
  });

  it("confirms a mobile round even when a newer foreign round lands in the same refresh", () => {
    const initial = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ["r1"]
    );
    const optimistic = appendOptimisticUserMessage(
      initial,
      "session-a",
      "mobile-intent",
      "Phone question"
    );
    const refreshed = applyTranscriptSubscribeResult(
      beginTranscriptLoad(optimistic, "session-a", 2),
      {
        sessionId: "session-a",
        rounds: {
          items: [
            summary("r1"),
            summary("r2", "mobile-intent"),
            summary("r3", "desktop-intent"),
          ],
          complete: true,
        },
        snapshot: {
          sessionId: "session-a",
          roundId: "r3",
          version: 3,
          snapshotDelta: false,
          upserts: [
            {
              id: "desktop-user",
              turnIntentId: "desktop-intent",
              source: "user",
              displayVariant: "message",
              displayText: "Desktop question",
            },
          ],
        },
      },
      "session-a",
      2
    );

    expect(refreshed.rounds.map((round) => round.id)).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
    expect(refreshed.bodies.r2.items).toEqual([
      expect.objectContaining({
        text: "Phone question",
        turnIntentId: "mobile-intent",
      }),
    ]);
  });

  it("confirms multiple pending sends from identities in the round directory", () => {
    const initial = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ["r1"]
    );
    const first = appendOptimisticUserMessage(
      initial,
      "session-a",
      "intent-a",
      "Question A"
    );
    const second = appendOptimisticUserMessage(
      first,
      "session-a",
      "intent-b",
      "Question B"
    );
    const refreshed = applyTranscriptSubscribeResult(
      beginTranscriptLoad(second, "session-a", 2),
      {
        sessionId: "session-a",
        rounds: {
          items: [
            summary("r1"),
            summary("r2", "intent-a"),
            summary("r3", "intent-b"),
          ],
          complete: true,
        },
        snapshot: {
          sessionId: "session-a",
          roundId: "r3",
          version: 3,
          snapshotDelta: false,
          upserts: [
            {
              id: "persisted-b",
              turnIntentId: "intent-b",
              source: "user",
              displayVariant: "message",
              displayText: "Question B",
            },
          ],
        },
      },
      "session-a",
      2
    );

    expect(refreshed.rounds.map((round) => round.id)).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
    expect(refreshed.bodies.r2.items[0]).toMatchObject({
      text: "Question A",
      turnIntentId: "intent-a",
    });
    expect(refreshed.bodies.r3.items[0]).toMatchObject({
      id: "persisted-b",
      turnIntentId: "intent-b",
    });
  });

  it("does not identify a foreign round from matching text alone", () => {
    const initial = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ["r1"]
    );
    const optimistic = appendOptimisticUserMessage(
      initial,
      "session-a",
      "mobile-intent",
      "Same question"
    );
    const refreshed = applyTranscriptSubscribeResult(
      beginTranscriptLoad(optimistic, "session-a", 2),
      {
        sessionId: "session-a",
        rounds: {
          items: [summary("r1"), summary("r2")],
          complete: true,
        },
        snapshot: {
          sessionId: "session-a",
          roundId: "r2",
          version: 2,
          snapshotDelta: false,
          upserts: [
            {
              id: "foreign-user",
              source: "user",
              displayVariant: "message",
              displayText: "Same question",
            },
          ],
        },
      },
      "session-a",
      2
    );

    expect(refreshed.rounds.map((round) => round.id)).toEqual([
      "r1",
      "r2",
      "local-pending:mobile-intent",
    ]);
    expect(getSelectedTranscriptView(refreshed).items).toEqual([
      expect.objectContaining({
        id: "mobile-user-mobile-intent",
        optimistic: true,
      }),
    ]);
  });

  it("orders an optimistic question before a response despite five minutes of clock skew", () => {
    const initial = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ["r1"]
    );
    const optimistic = appendOptimisticUserMessage(
      initial,
      "session-a",
      "skewed-intent",
      "Question from fast phone",
      "2026-08-30T12:05:00.000Z"
    );
    const live = applyLiveTranscriptSnapshot(optimistic, {
      sessionId: "session-a",
      version: 2,
      snapshotDelta: true,
      upserts: [
        {
          id: "desktop-answer",
          source: "assistant",
          displayVariant: "message",
          displayText: "Answer from slow desktop",
          createdAt: "2026-08-30T12:00:00.000Z",
        },
      ],
    });

    expect(
      getSelectedTranscriptView(live).items.map((item) => item.text)
    ).toEqual(["Question from fast phone", "Answer from slow desktop"]);
    expect(live.bodies.r1.items.map((item) => item.text)).toEqual([
      "Answer r1",
    ]);
  });

  it("keeps the optimistic anchor across a full refresh without its user echo", () => {
    const initial = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ["r1"]
    );
    const optimistic = appendOptimisticUserMessage(
      initial,
      "session-a",
      "anchor-intent",
      "Anchored question",
      "2026-08-30T12:05:00.000Z"
    );
    const live = applyLiveTranscriptSnapshot(optimistic, {
      sessionId: "session-a",
      version: 2,
      snapshotDelta: true,
      upserts: [
        {
          id: "raced-answer",
          source: "assistant",
          displayVariant: "message",
          displayText: "Raced answer",
          createdAt: "2026-08-30T12:00:00.000Z",
        },
      ],
    });

    const refreshing = beginTranscriptLoad(live, "session-a", 2);
    const refreshed = applyTranscriptSubscribeResult(
      refreshing,
      {
        sessionId: "session-a",
        rounds: { items: [summary("r1")], complete: true },
        snapshot: {
          sessionId: "session-a",
          roundId: "r1",
          version: 3,
          snapshotDelta: false,
          upserts: [
            {
              id: "agent-r1",
              source: "assistant",
              displayVariant: "message",
              displayText: "Answer r1",
              createdAt: "2026-08-30T11:59:00.000Z",
            },
          ],
        },
      },
      "session-a",
      2
    );

    expect(
      getSelectedTranscriptView(refreshed).items.map((item) => item.text)
    ).toEqual(["Anchored question", "Raced answer"]);
    expect(refreshed.rounds.map((round) => round.id)).toEqual([
      "r1",
      "local-pending:anchor-intent",
    ]);
    expect(refreshed.bodies.r1.items.map((item) => item.text)).toEqual([
      "Answer r1",
    ]);
  });

  it("keeps a new turn separate when the first live baseline still contains the previous round", () => {
    const initial = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ["r1", "r2"]
    );
    const optimistic = appendOptimisticUserMessage(
      initial,
      "session-a",
      "mobile-r3",
      "Current question"
    );

    // EventStore emits a session-window baseline on its first notification.
    // The baseline legitimately contains the already-loaded r2 body before
    // the opening user event for r3.
    const live = applyLiveTranscriptSnapshot(optimistic, {
      sessionId: "session-a",
      version: 87,
      snapshotDelta: false,
      upserts: [
        {
          id: "r2-user",
          source: "user",
          displayVariant: "message",
          displayText: "Previous question",
        },
        {
          id: "r2-tool",
          actionType: "tool_call",
          displayVariant: "tool_call",
          functionName: "read_file",
          displayText: "Old tool",
        },
        {
          id: "r3-user",
          turnIntentId: "mobile-r3",
          source: "user",
          displayVariant: "message",
          displayText: "Current question",
        },
        {
          id: "r3-answer",
          source: "assistant",
          displayVariant: "message",
          displayText: "Current answer",
        },
        {
          id: "foreign-user",
          turnIntentId: "desktop-r4",
          source: "user",
          displayVariant: "message",
          displayText: "Concurrent desktop question",
        },
        {
          id: "foreign-answer",
          source: "assistant",
          displayVariant: "message",
          displayText: "Concurrent desktop answer",
        },
      ],
    });

    expect(
      getSelectedTranscriptView(live).items.map((item) => item.text)
    ).toEqual(["Current question", "Current answer"]);
    expect(live.bodies.r2.items.map((item) => item.text)).toEqual([
      "Answer r2",
    ]);

    // The exact persisted round snapshot uses its own version lineage (0).
    // It must still replace the live provisional baseline rather than append.
    const refreshed = applyTranscriptSubscribeResult(
      beginTranscriptLoad(live, "session-a", 2),
      {
        sessionId: "session-a",
        rounds: {
          items: [summary("r1"), summary("r2"), summary("r3", "mobile-r3")],
          complete: true,
        },
        snapshot: {
          sessionId: "session-a",
          roundId: "r3",
          version: 0,
          snapshotDelta: false,
          upserts: [
            {
              id: "r3-user",
              turnIntentId: "mobile-r3",
              source: "user",
              displayVariant: "message",
              displayText: "Current question",
            },
            {
              id: "r3-answer",
              source: "assistant",
              displayVariant: "message",
              displayText: "Current answer",
            },
          ],
        },
      },
      "session-a",
      2
    );

    expect(refreshed.rounds.map((round) => round.id)).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
    expect(refreshed.bodies.r3.items.map((item) => item.text)).toEqual([
      "Current question",
      "Current answer",
    ]);
    expect(refreshed.bodies.r3.version).toBe(0);
  });

  it("does not copy an unidentified full baseline into a provisional round", () => {
    const initial = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ["r1"]
    );
    const optimistic = appendOptimisticUserMessage(
      initial,
      "session-a",
      "pending-intent",
      "Pending question"
    );
    const unchanged = applyLiveTranscriptSnapshot(optimistic, {
      sessionId: "session-a",
      version: 5,
      snapshotDelta: false,
      upserts: [
        {
          id: "old-tool",
          actionType: "tool_call",
          displayVariant: "tool_call",
          functionName: "read_file",
          displayText: "Previous round tool",
        },
      ],
    });

    expect(
      getSelectedTranscriptView(unchanged).items.map((item) => item.text)
    ).toEqual(["Pending question"]);
  });

  it("invalidates an old latest body polluted before a new round is indexed", () => {
    const initial = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ["r1", "r2"]
    );
    const ambiguousLive = applyLiveTranscriptSnapshot(initial, {
      sessionId: "session-a",
      version: 2,
      snapshotDelta: true,
      upserts: [
        {
          id: "new-round-answer",
          source: "assistant",
          displayVariant: "message",
          displayText: "Actually belongs to r3",
        },
      ],
    });
    expect(ambiguousLive.bodies.r2.liveDirty).toBe(true);

    const refreshed = subscribe(
      beginTranscriptLoad(ambiguousLive, "session-a", 2),
      ["r1", "r2", "r3"],
      2,
      "Latest r3"
    );
    expect(refreshed.bodies.r2).toMatchObject({
      phase: "unloaded",
      items: [],
      liveDirty: false,
    });

    const exactOld = loadSelectedRound(refreshed, "r2", 91, "Exact r2");
    expect(
      getSelectedTranscriptView(exactOld).items.map((item) => item.text)
    ).toEqual(["Exact r2"]);
  });

  it("keeps the first optimistic turn visible until an empty session gains a server round", () => {
    const empty = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      []
    );
    const optimistic = appendOptimisticUserMessage(
      empty,
      "session-a",
      "first-intent",
      "First question"
    );

    expect(getSelectedTranscriptView(optimistic)).toMatchObject({
      phase: "ready",
      items: [
        expect.objectContaining({ text: "First question", optimistic: true }),
      ],
    });
    expect(optimistic.rounds[0].id).toBe("local-pending:first-intent");

    const stillEmpty = subscribe(
      beginTranscriptLoad(optimistic, "session-a", 2),
      [],
      2
    );
    expect(getSelectedTranscriptView(stillEmpty).items[0].text).toBe(
      "First question"
    );

    const authoritative = applyTranscriptSubscribeResult(
      beginTranscriptLoad(stillEmpty, "session-a", 3),
      {
        sessionId: "session-a",
        rounds: { items: [summary("r1")], complete: true },
        snapshot: {
          sessionId: "session-a",
          roundId: "r1",
          version: 1,
          snapshotDelta: false,
          upserts: [
            {
              id: "first-user",
              turnIntentId: "first-intent",
              source: "user",
              displayVariant: "message",
              displayText: "First question",
            },
            {
              id: "first-answer",
              source: "assistant",
              displayVariant: "message",
              displayText: "First answer",
            },
          ],
        },
      },
      "session-a",
      3
    );
    expect(authoritative.rounds.map((round) => round.id)).toEqual(["r1"]);
    expect(authoritative.bodies.r1.items.map((item) => item.text)).toEqual([
      "First question",
      "First answer",
    ]);
  });

  it("removes a pending round on failure after its authoritative echo arrives", () => {
    const initial = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ["r1"]
    );
    const optimistic = appendOptimisticUserMessage(
      initial,
      "session-a",
      "failed-after-echo",
      "Question that fails"
    );
    const echoed = applyLiveTranscriptSnapshot(optimistic, {
      sessionId: "session-a",
      version: 2,
      snapshotDelta: true,
      upserts: [
        {
          id: "authoritative-user",
          turnIntentId: "failed-after-echo",
          source: "user",
          displayVariant: "message",
          displayText: "Question that fails",
        },
      ],
    });
    expect(getSelectedTranscriptView(echoed).items).toEqual([
      expect.objectContaining({ id: "authoritative-user" }),
    ]);
    expect(getSelectedTranscriptView(echoed).items[0]).not.toHaveProperty(
      "optimistic"
    );

    const rolledBack = rollbackOptimisticUserMessage(
      echoed,
      "session-a",
      "failed-after-echo"
    );
    expect(rolledBack.rounds.map((round) => round.id)).toEqual(["r1"]);
    expect(
      rolledBack.bodies["local-pending:failed-after-echo"]
    ).toBeUndefined();
    expect(getSelectedTranscriptView(rolledBack).roundId).toBe("r1");
  });

  it("bounds ready round bodies to the latest eight", () => {
    const ids = Array.from({ length: 10 }, (_, index) => `r${index + 1}`);
    let state = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ids
    );
    for (let index = 0; index < ids.length - 1; index += 1) {
      state = loadSelectedRound(state, ids[index], 100 + index);
    }
    state = selectTranscriptRound(state, null);

    expect(
      Object.values(state.bodies).filter((body) => body.phase === "ready")
    ).toHaveLength(MAX_READY_ROUND_BODIES);
    expect(state.bodies.r10.phase).toBe("ready");
  });

  it("bounds unconfirmed local rounds when terminal identity is unavailable", () => {
    let state = subscribe(
      beginTranscriptLoad(createInitialTranscriptLoadState(), "session-a", 1),
      ["r1"]
    );
    for (let index = 0; index <= MAX_LOCAL_PENDING_ROUNDS; index += 1) {
      state = appendOptimisticUserMessage(
        state,
        "session-a",
        `intent-${index}`,
        `Question ${index}`
      );
    }

    const pendingRounds = state.rounds.filter((round) =>
      round.id.startsWith("local-pending:")
    );
    expect(pendingRounds).toHaveLength(MAX_LOCAL_PENDING_ROUNDS);
    expect(pendingRounds[0]?.id).toBe("local-pending:intent-1");
    expect(state.bodies["local-pending:intent-0"]).toBeUndefined();
  });
});
