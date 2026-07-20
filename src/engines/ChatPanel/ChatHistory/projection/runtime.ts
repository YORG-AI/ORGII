import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { configureToolClassifierRegistry } from "@src/engines/SessionCore/rendering/registry/toolClassifierRegistry";

import { projectChatHistory } from "./core";
import {
  CHAT_PROJECTION_PROTOCOL_VERSION,
  type ChatProjectionRequest,
  type ChatProjectionResponse,
  type ProjectionEnvelope,
} from "./protocol";

interface SessionProjectionState {
  generation: number;
  sourceVersion: number;
  projectionRevision: number;
  eventsById: Map<string, SessionEvent>;
  eventIds: string[];
  options: Parameters<typeof projectChatHistory>[1];
  lastAccess: number;
}

export class ChatProjectionRuntime {
  private sessions = new Map<string, SessionProjectionState>();

  constructor(private readonly maxCachedSessions = 4) {}

  handle(
    request: ChatProjectionRequest,
    queuedAt = performance.now()
  ): ChatProjectionResponse {
    if (request.protocolVersion !== CHAT_PROJECTION_PROTOCOL_VERSION) {
      return {
        ...this.envelope(request),
        type: "workerError",
        code: "PROTOCOL_MISMATCH",
        message: "Unsupported chat projection protocol version",
      };
    }
    if (request.type === "resetWorker") {
      this.sessions.clear();
      return { ...this.envelope(request), type: "ready" };
    }
    if (request.type === "disposeSession") {
      this.sessions.delete(request.sessionId);
      return { ...this.envelope(request), type: "ready" };
    }
    if (request.type === "initSnapshot") {
      configureToolClassifierRegistry(request.toolRegistry);
      const state: SessionProjectionState = {
        generation: request.generation,
        sourceVersion: request.sourceVersion,
        projectionRevision: 0,
        eventsById: new Map(request.events.map((event) => [event.id, event])),
        eventIds: request.events.map((event) => event.id),
        options: request.options,
        lastAccess: Date.now(),
      };
      this.sessions.set(request.sessionId, state);
      return this.project(request, state, queuedAt);
    }

    const state = this.sessions.get(request.sessionId);
    if (!state) return this.resync(request, 0, "missing-session");
    if (state.generation !== request.generation) {
      return this.resync(request, state.sourceVersion, "generation-mismatch");
    }
    if (request.type === "setProjectionOptions") {
      if (request.sourceVersion < state.sourceVersion) {
        return this.resync(request, state.sourceVersion, "version-gap");
      }
      state.options = request.options;
      return this.project(request, state, queuedAt);
    }
    if (request.baseVersion !== state.sourceVersion) {
      return this.resync(request, state.sourceVersion, "version-gap");
    }
    if (request.type === "appendEvents") {
      for (const event of request.events) {
        state.eventsById.set(event.id, event);
        state.eventIds.push(event.id);
      }
      state.sourceVersion = request.sourceVersion;
      state.options = request.options;
      return this.project(request, state, queuedAt);
    }
    for (const removedId of request.removedIds)
      state.eventsById.delete(removedId);
    for (const event of request.upserts) state.eventsById.set(event.id, event);
    state.eventIds = request.eventIds;
    state.sourceVersion = request.sourceVersion;
    state.options = request.options;
    return this.project(request, state, queuedAt);
  }

  private project(
    request: ChatProjectionRequest,
    state: SessionProjectionState,
    queuedAt: number
  ): ChatProjectionResponse {
    const startedAt = performance.now();
    const events = state.eventIds
      .map((id) => state.eventsById.get(id))
      .filter((event): event is SessionEvent => Boolean(event));
    const result = projectChatHistory(events, state.options);
    state.projectionRevision += 1;
    this.touchAndEvict(request.sessionId);
    return {
      ...this.envelope(request),
      type: "projection",
      projectionRevision: state.projectionRevision,
      result: { ...result, projectionRevision: state.projectionRevision },
      metrics: {
        queueWaitMs: Math.max(0, startedAt - queuedAt),
        computeMs: performance.now() - startedAt,
        inputEvents: events.length,
      },
    };
  }

  private envelope(request: ProjectionEnvelope): ProjectionEnvelope {
    return {
      protocolVersion: CHAT_PROJECTION_PROTOCOL_VERSION,
      sessionId: request.sessionId,
      generation: request.generation,
      sourceVersion: request.sourceVersion,
      requestId: request.requestId,
    };
  }

  private resync(
    request: ChatProjectionRequest,
    expectedBaseVersion: number,
    reason: "missing-session" | "generation-mismatch" | "version-gap"
  ): ChatProjectionResponse {
    return {
      ...this.envelope(request),
      type: "resyncRequired",
      expectedBaseVersion,
      reason,
    };
  }

  private touchAndEvict(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) state.lastAccess = Date.now();
    if (this.sessions.size <= this.maxCachedSessions) return;
    let oldest: { id: string; at: number } | null = null;
    for (const [id, candidate] of this.sessions) {
      if (id === sessionId) continue;
      if (!oldest || candidate.lastAccess < oldest.at) {
        oldest = { id, at: candidate.lastAccess };
      }
    }
    if (oldest) this.sessions.delete(oldest.id);
  }
}
