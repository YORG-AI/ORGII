import { describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { ChatProjectionClient } from "../client";
import { projectChatHistory } from "../core";
import {
  CHAT_PROJECTION_PROTOCOL_VERSION,
  type ChatProjectionRequest,
  type ChatProjectionResponse,
} from "../protocol";

function event(id: string): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: "s",
    createdAt: `2026-01-01T00:00:0${id}.000Z`,
    functionName: id === "1" ? "user_message" : "agent_message",
    actionType: id === "1" ? "user" : "assistant",
    source: id === "1" ? "user" : "assistant",
    displayText: id,
    displayStatus: "completed",
    displayVariant: "message",
    args: {},
    result: {},
  } as SessionEvent;
}

class FakeWorker {
  onmessage: ((event: MessageEvent<ChatProjectionResponse>) => void) | null =
    null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: ChatProjectionRequest[] = [];
  terminated = false;

  postMessage(request: ChatProjectionRequest): void {
    this.posted.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(response: ChatProjectionResponse): void {
    this.onmessage?.({
      data: response,
    } as MessageEvent<ChatProjectionResponse>);
  }
}

function projectionResponse(
  request: ChatProjectionRequest,
  events: SessionEvent[]
): ChatProjectionResponse {
  return {
    type: "projection",
    protocolVersion: CHAT_PROJECTION_PROTOCOL_VERSION,
    sessionId: request.sessionId,
    generation: request.generation,
    sourceVersion: request.sourceVersion,
    requestId: request.requestId,
    projectionRevision: 1,
    result: projectChatHistory(events),
    metrics: { queueWaitMs: 0, computeMs: 1, inputEvents: events.length },
  };
}

describe("ChatProjectionClient", () => {
  it("resolves the original delta request after an internal snapshot resync", async () => {
    const worker = new FakeWorker();
    const client = new ChatProjectionClient(
      () => worker as unknown as Worker,
      1_000,
      () => true
    );
    const initial = [event("1")];
    const initPromise = client.projectSnapshot({
      sessionId: "consumer:s",
      sourceVersion: 1,
      events: initial,
      options: {},
    });
    const initRequest = worker.posted.at(-1)!;
    worker.respond(projectionResponse(initRequest, initial));
    await initPromise;

    const next = [...initial, event("2")];
    const deltaPromise = client.projectDelta({
      sessionId: "consumer:s",
      delta: {
        kind: "append",
        baseVersion: 1,
        sourceVersion: 2,
        appendedEvents: [next[1]],
      },
      events: next,
      options: {},
    });
    const deltaRequest = worker.posted.at(-1)!;
    worker.respond({
      type: "resyncRequired",
      protocolVersion: CHAT_PROJECTION_PROTOCOL_VERSION,
      sessionId: deltaRequest.sessionId,
      generation: deltaRequest.generation,
      sourceVersion: deltaRequest.sourceVersion,
      requestId: deltaRequest.requestId,
      expectedBaseVersion: 0,
      reason: "missing-session",
    });

    const retryRequest = worker.posted.at(-1)!;
    expect(retryRequest.type).toBe("initSnapshot");
    expect(retryRequest.generation).toBe(deltaRequest.generation + 1);
    worker.respond(projectionResponse(retryRequest, next));

    await expect(deltaPromise).resolves.toMatchObject({
      sourceVersion: 2,
      result: { optimizedChatHistory: expect.any(Array) },
    });
  });

  it("restarts after a timeout and disables the Worker after repeated failures", async () => {
    vi.useFakeTimers();
    try {
      const workers: FakeWorker[] = [];
      const client = new ChatProjectionClient(
        () => {
          const worker = new FakeWorker();
          workers.push(worker);
          return worker as unknown as Worker;
        },
        10,
        () => true
      );
      const snapshot = {
        sessionId: "consumer:s",
        sourceVersion: 1,
        events: [event("1")],
        options: {},
      };

      const first = client.projectSnapshot(snapshot);
      const firstExpectation = expect(first).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(10);
      await firstExpectation;
      expect(workers[0].terminated).toBe(true);
      expect(client.isSupported()).toBe(true);

      const second = client.projectSnapshot(snapshot);
      const secondExpectation = expect(second).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(10);
      await secondExpectation;
      expect(workers[1].terminated).toBe(true);
      expect(client.isSupported()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps different consumer keys from superseding each other", async () => {
    const worker = new FakeWorker();
    const client = new ChatProjectionClient(
      () => worker as unknown as Worker,
      1_000,
      () => true
    );
    const events = [event("1")];
    const first = client.projectSnapshot({
      sessionId: "consumer-a:s",
      sourceVersion: 1,
      events,
      options: {},
    });
    const firstRequest = worker.posted.at(-1)!;
    const second = client.projectSnapshot({
      sessionId: "consumer-b:s",
      sourceVersion: 1,
      events,
      options: {},
    });
    const secondRequest = worker.posted.at(-1)!;

    worker.respond(projectionResponse(secondRequest, events));
    worker.respond(projectionResponse(firstRequest, events));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("keeps at most one request in flight and replaces queued intermediate versions", async () => {
    const worker = new FakeWorker();
    const client = new ChatProjectionClient(
      () => worker as unknown as Worker,
      1_000,
      () => true
    );
    const initial = [event("1")];
    const first = client.projectSnapshot({
      sessionId: "consumer:s",
      sourceVersion: 1,
      events: initial,
      options: {},
    });

    const version2 = [...initial, event("2")];
    const second = client.projectDelta({
      sessionId: "consumer:s",
      delta: {
        kind: "append",
        baseVersion: 1,
        sourceVersion: 2,
        appendedEvents: [version2[1]],
      },
      events: version2,
      options: {},
    });
    const version3 = [...version2, event("3")];
    const third = client.projectDelta({
      sessionId: "consumer:s",
      delta: {
        kind: "append",
        baseVersion: 2,
        sourceVersion: 3,
        appendedEvents: [version3[2]],
      },
      events: version3,
      options: {},
    });

    expect(worker.posted).toHaveLength(1);
    await expect(second).rejects.toThrow("Superseded");

    const firstRequest = worker.posted[0];
    worker.respond(projectionResponse(firstRequest, initial));
    await expect(first).resolves.toMatchObject({ sourceVersion: 1 });

    expect(worker.posted).toHaveLength(2);
    const latestRequest = worker.posted[1];
    expect(latestRequest).toMatchObject({
      type: "initSnapshot",
      sourceVersion: 3,
    });
    worker.respond(projectionResponse(latestRequest, version3));
    await expect(third).resolves.toMatchObject({ sourceVersion: 3 });
  });
});
