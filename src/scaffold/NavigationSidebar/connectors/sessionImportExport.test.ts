import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  externalReplayQueryWindowForTarget,
  resolveExternalReplayTarget,
  resolveSecondaryReplayTarget,
} from "@src/api/tauri/externalHistory/replay";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { loadOwnSessionInitialEvents } from "@src/engines/SessionCore/sync/sessionSyncUtils";
import type { Session } from "@src/store/session";

import { buildSessionExportDraft } from "./sessionImportExport";

vi.mock("@src/api/tauri/externalHistory/replay", () => ({
  externalReplayQueryWindowForTarget: vi.fn(),
  resolveExternalReplayTarget: vi.fn(),
  resolveSecondaryReplayTarget: vi.fn(),
}));

vi.mock("@src/engines/SessionCore/sync/sessionSyncUtils", () => ({
  loadOwnSessionInitialEvents: vi.fn(),
}));

function session(sessionId: string, category: Session["category"]): Session {
  return {
    session_id: sessionId,
    category,
    status: "completed",
    created_at: "2026-07-22T00:00:00Z",
    updated_at: "2026-07-22T00:00:01Z",
    name: "Replay fixture",
  };
}

function nativeEvent(): SessionEvent {
  return {
    chunk_id: "event-1",
    id: "event-1",
    sessionId: "agentsession-native",
    createdAt: "2026-07-22T00:00:00Z",
    functionName: "assistant",
    uiCanonical: "assistant",
    actionType: "assistant_message",
    args: {},
    result: { content: "done" },
    source: "assistant",
    displayText: "done",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
  };
}

describe("session export draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveSecondaryReplayTarget).mockResolvedValue(null);
  });

  it("keeps external preview bounded and leaves full JSON writing to Rust", async () => {
    vi.mocked(resolveExternalReplayTarget).mockReturnValue({
      sourceId: "codex_app",
      sessionId: "codexapp-large",
    });
    vi.mocked(externalReplayQueryWindowForTarget).mockResolvedValue({
      cursor: {
        sourceId: "codex_app",
        sessionId: "codexapp-large",
        generation: "g1",
        revision: 1,
        throughSequence: 999,
      },
      events: [],
      windowStartSequence: 999,
      turnHeaders: [],
      totalEventCount: 12_345,
      totalTurnCount: 321,
      hasOlder: true,
      watcherAvailable: false,
      stats: {
        parsedBytes: 0,
        parsedRows: 0,
        normalizedEvents: 0,
        upsertedEvents: 0,
        removedEvents: 0,
        ipcBytes: 0,
        notReady: false,
      },
    });

    const draft = await buildSessionExportDraft(
      session("codexapp-large", "external_history"),
      "fallback"
    );

    expect(draft.mode).toBe("bounded-replay");
    expect(draft.preview.eventCount).toBe(12_345);
    expect(externalReplayQueryWindowForTarget).toHaveBeenCalledWith({
      target: {
        sourceId: "codex_app",
        sessionId: "codexapp-large",
      },
      limits: {
        maxTurns: 1,
        maxEvents: 1,
        maxIpcBytes: 128 * 1024,
      },
    });
    expect(loadOwnSessionInitialEvents).not.toHaveBeenCalled();
    if (draft.mode === "bounded-replay") {
      expect(draft.orgiiEnvelope.session).toMatchObject({
        session_id: "codexapp-large",
      });
      expect(draft.orgiiEnvelope.originalCategory).toBe("cli_agent");
      expect(draft).not.toHaveProperty("file");
    }
  });

  it("does not route a native SDE session through external replay", async () => {
    vi.mocked(resolveExternalReplayTarget).mockReturnValue(null);
    vi.mocked(loadOwnSessionInitialEvents).mockResolvedValue([nativeEvent()]);

    const draft = await buildSessionExportDraft(
      session("agentsession-native", "rust_agent"),
      "fallback"
    );

    expect(draft.mode).toBe("materialized");
    expect(externalReplayQueryWindowForTarget).not.toHaveBeenCalled();
    expect(resolveSecondaryReplayTarget).toHaveBeenCalledWith(
      "agentsession-native"
    );
    expect(loadOwnSessionInitialEvents).toHaveBeenCalledWith(
      "agentsession-native"
    );
    if (draft.mode === "materialized") {
      expect(draft.file.payload.events).toHaveLength(1);
    }
  });

  it("exports a snapshot-backed native fork through bounded replay", async () => {
    const replayTarget = {
      sourceId: "collaboration_snapshot" as const,
      sessionId: "agentsession-cloud-fork",
    };
    vi.mocked(resolveExternalReplayTarget).mockReturnValue(null);
    vi.mocked(resolveSecondaryReplayTarget).mockResolvedValue(replayTarget);
    vi.mocked(externalReplayQueryWindowForTarget).mockResolvedValue({
      cursor: {
        ...replayTarget,
        generation: "snapshot-g1",
        revision: 7,
        throughSequence: 99,
      },
      events: [],
      windowStartSequence: 99,
      turnHeaders: [],
      totalEventCount: 9_999,
      totalTurnCount: 80,
      hasOlder: true,
      watcherAvailable: false,
      stats: {
        parsedBytes: 0,
        parsedRows: 0,
        normalizedEvents: 0,
        upsertedEvents: 0,
        removedEvents: 0,
        ipcBytes: 0,
        notReady: false,
      },
    });

    const draft = await buildSessionExportDraft(
      session("agentsession-cloud-fork", "rust_agent"),
      "fallback"
    );

    expect(draft.mode).toBe("bounded-replay");
    expect(externalReplayQueryWindowForTarget).toHaveBeenCalledWith({
      target: replayTarget,
      limits: {
        maxTurns: 1,
        maxEvents: 1,
        maxIpcBytes: 128 * 1024,
      },
    });
    expect(loadOwnSessionInitialEvents).not.toHaveBeenCalled();
  });
});
