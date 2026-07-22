import { describe, expect, it } from "vitest";

import {
  ExternalReplayCloudBatchSchema,
  ExternalReplayCloudReadBatchInput,
  ExternalReplayCursorSchema,
  ExternalReplayHandoffInput,
  ExternalReplayHandoffSchema,
  ExternalReplayOpenWindowInput,
  ExternalReplayPrewarmWindowInput,
  ExternalReplayQueryWindowInput,
  ExternalReplayReadPayloadRangeInput,
  ExternalReplayReadWindowInput,
  ExternalReplayStreamExportInput,
  ExternalReplayWindowSchema,
} from "../schemas/externalReplay";

describe("external replay wire schemas", () => {
  it("accepts the bounded managed-CLI not-ready sentinel", () => {
    expect(
      ExternalReplayCursorSchema.parse({
        sourceId: "managed_cli",
        sessionId: "cliagent-1",
        generation: "pending",
        revision: 0,
        throughSequence: -1,
      }).throughSequence
    ).toBe(-1);
  });

  it("accepts the ORGII-owned collaboration snapshot source", () => {
    expect(
      ExternalReplayCursorSchema.parse({
        sourceId: "collaboration_snapshot",
        sessionId: "imported-session-abc",
        generation: "collaboration-v1-0",
        revision: 3,
        throughSequence: 2,
      }).sourceId
    ).toBe("collaboration_snapshot");
  });

  it("enforces window and payload hard limits before IPC", () => {
    expect(() =>
      ExternalReplayOpenWindowInput.parse({
        sourceId: "codex_app",
        sessionId: "codexapp-1",
        episodeId: 1,
        limits: { maxTurns: 11 },
      })
    ).toThrow();
    expect(() =>
      ExternalReplayReadPayloadRangeInput.parse({
        sourceId: "codex_app",
        sessionId: "codexapp-1",
        generation: "g1",
        eventId: "event-1",
        fieldPath: "result.output",
        offset: 0,
        maxBytes: 256 * 1024 + 1,
      })
    ).toThrow();
    expect(() =>
      ExternalReplayReadWindowInput.parse({
        sourceId: "cursor_ide",
        sessionId: "cursoride-1",
        episodeId: 1,
        beforeSequence: 10,
        turnIndex: 2,
      })
    ).toThrow("Choose only one replay window locator");
    expect(
      ExternalReplayQueryWindowInput.parse({
        sourceId: "codex_app",
        sessionId: "codexapp-1",
        limits: { maxEvents: 1 },
      })
    ).not.toHaveProperty("episodeId");
    expect(
      ExternalReplayPrewarmWindowInput.parse({
        sourceId: "codex_app",
        sessionId: "codexapp-1",
        episodeId: 2,
        limits: { maxTurns: 1, maxEvents: 200 },
      }).episodeId
    ).toBe(2);
    expect(() =>
      ExternalReplayPrewarmWindowInput.parse({
        sourceId: "codex_app",
        sessionId: "codexapp-1",
        episodeId: 2,
        limits: { maxIpcBytes: 4 * 1024 * 1024 + 1 },
      })
    ).toThrow();
  });

  it("validates bounded windows containing normalized SessionEvents", () => {
    const parsed = ExternalReplayWindowSchema.parse({
      cursor: {
        sourceId: "codex_app",
        sessionId: "codexapp-1",
        generation: "g1",
        revision: 1,
        throughSequence: 0,
      },
      events: [],
      windowStartSequence: null,
      turnHeaders: [],
      totalEventCount: 0,
      totalTurnCount: 0,
      hasOlder: false,
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
    expect(parsed.cursor.generation).toBe("g1");
  });

  it("keeps Fork handoff prompt-ready and bounded without SessionEvents", () => {
    expect(
      ExternalReplayHandoffInput.parse({
        sourceId: "codex_app",
        sessionId: "codexapp-1",
        sourceName: "Codex App",
      })
    ).not.toHaveProperty("episodeId");
    const handoff = ExternalReplayHandoffSchema.parse({
      items: ["User: continue", "Assistant: done"],
      generation: "g1",
      scannedBytes: 4096,
      scannedEvents: 2,
    });
    expect(handoff.items).toHaveLength(2);
    expect(handoff).not.toHaveProperty("events");
    expect(() =>
      ExternalReplayHandoffSchema.parse({
        items: ["x".repeat(1201)],
        generation: "g1",
        scannedBytes: 0,
        scannedEvents: 1,
      })
    ).toThrow();
  });

  it("caps cloud spool IPC and accepts the small compatible export envelope", () => {
    expect(() =>
      ExternalReplayCloudReadBatchInput.parse({
        token: "spool-1",
        startEventIndex: 0,
        endEventIndex: 10,
        maxBytes: 256 * 1024 + 1,
      })
    ).toThrow();
    expect(
      ExternalReplayCloudBatchSchema.parse({
        segments: [
          {
            payloadGz: "H4sI",
            eventCount: 1,
            segmentHash: "hash",
            wireBytes: 128,
          },
        ],
        startEventIndex: 0,
        nextEventIndex: 1,
        startSegmentIndex: 0,
        nextSegmentIndex: 1,
        eof: true,
        serializedBytes: 128,
      }).segments
    ).toHaveLength(1);
    expect(
      ExternalReplayStreamExportInput.parse({
        sourceId: "codex_app",
        sessionId: "codexapp-1",
        destinationPath: "/tmp/session.orgii-session.json",
        format: "orgii_session_json",
        orgiiEnvelope: {
          exportedAt: "2026-07-22T00:00:00Z",
          session: { session_id: "codexapp-1" },
          originalCategory: "cli_agent",
          specs: [],
        },
      }).format
    ).toBe("orgii_session_json");
  });
});
