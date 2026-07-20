import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { getToolClassifierRegistrySnapshot } from "@src/engines/SessionCore/rendering/registry/toolClassifierRegistry";
import { createLogger } from "@src/hooks/logger";

import type {
  ChatHistoryProjectionOptions,
  ChatHistoryProjectionResult,
} from "./core";
import type { ChatProjectionDelta } from "./delta";
import {
  CHAT_PROJECTION_PROTOCOL_VERSION,
  type ChatProjectionRequest,
  type ChatProjectionResponse,
  type ProjectionResponse,
} from "./protocol";

const log = createLogger("ChatProjectionClient");
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_FAILURES_BEFORE_DISABLE = 2;

type WorkerFactory = () => Worker;

export interface ProjectionSnapshotRequest {
  sessionId: string;
  sourceVersion: number;
  events: SessionEvent[];
  options: ChatHistoryProjectionOptions;
}

interface SessionClientState {
  generation: number;
  sourceVersion: number;
  latestSnapshot: ProjectionSnapshotRequest;
}

interface DeferredRequest {
  request: ChatProjectionRequest;
  resolve: (response: ProjectionResponse) => void;
  reject: (error: Error) => void;
}

interface PendingRequest extends DeferredRequest {
  sessionId: string;
  generation: number;
  sourceVersion: number;
  requestId: number;
  timeout: ReturnType<typeof setTimeout>;
}

export interface ProjectionClientResult {
  result: ChatHistoryProjectionResult;
  sourceVersion: number;
  generation: number;
  projectionRevision: number;
  metrics: ProjectionResponse["metrics"];
}

export class ChatProjectionClient {
  private worker: Worker | null = null;
  private sessions = new Map<string, SessionClientState>();
  private pending = new Map<number, PendingRequest>();
  private activeRequestBySession = new Map<string, number>();
  private queuedRequestBySession = new Map<string, DeferredRequest>();
  private nextRequestId = 0;
  private failureCount = 0;
  private disabled = false;

  constructor(
    private readonly createWorker: WorkerFactory = () =>
      new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
        name: "orgii-chat-projection",
      }),
    private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS,
    private readonly hasWorkerSupport: () => boolean = () =>
      typeof Worker !== "undefined"
  ) {}

  isSupported(): boolean {
    return !this.disabled && this.hasWorkerSupport();
  }

  projectSnapshot(
    snapshot: ProjectionSnapshotRequest
  ): Promise<ProjectionClientResult> {
    if (!this.isSupported()) {
      return Promise.reject(new Error("Chat projection Worker is unavailable"));
    }
    let state = this.sessions.get(snapshot.sessionId);
    if (!state) {
      state = {
        generation: 1,
        sourceVersion: snapshot.sourceVersion,
        latestSnapshot: snapshot,
      };
      this.sessions.set(snapshot.sessionId, state);
    } else {
      state.sourceVersion = snapshot.sourceVersion;
      state.latestSnapshot = snapshot;
    }
    return this.sendProjection({
      type: "initSnapshot",
      protocolVersion: CHAT_PROJECTION_PROTOCOL_VERSION,
      sessionId: snapshot.sessionId,
      generation: state.generation,
      sourceVersion: snapshot.sourceVersion,
      requestId: ++this.nextRequestId,
      events: snapshot.events,
      options: snapshot.options,
      toolRegistry: getToolClassifierRegistrySnapshot(),
    });
  }

  projectDelta(input: {
    sessionId: string;
    delta: ChatProjectionDelta;
    events: SessionEvent[];
    options: ChatHistoryProjectionOptions;
  }): Promise<ProjectionClientResult> {
    const state = this.sessions.get(input.sessionId);
    if (!state) {
      return Promise.reject(new Error("Projection session is not initialized"));
    }
    state.sourceVersion = input.delta.sourceVersion;
    state.latestSnapshot = {
      ...state.latestSnapshot,
      sourceVersion: input.delta.sourceVersion,
      options: input.options,
      events: input.events,
    };
    const envelope = {
      protocolVersion: CHAT_PROJECTION_PROTOCOL_VERSION,
      sessionId: input.sessionId,
      generation: state.generation,
      sourceVersion: input.delta.sourceVersion,
      requestId: ++this.nextRequestId,
      baseVersion: input.delta.baseVersion,
      options: input.options,
    } as const;
    return this.sendProjection(
      input.delta.kind === "append"
        ? {
            ...envelope,
            type: "appendEvents",
            events: input.delta.appendedEvents,
          }
        : {
            ...envelope,
            type: "applyDelta",
            upserts: input.delta.upserts,
            removedIds: input.delta.removedIds,
            eventIds: input.delta.eventIds,
          }
    );
  }

  updateOptions(
    sessionId: string,
    sourceVersion: number,
    options: ChatHistoryProjectionOptions
  ): Promise<ProjectionClientResult> {
    const state = this.sessions.get(sessionId);
    if (!state)
      return Promise.reject(new Error("Projection session is not initialized"));
    state.sourceVersion = sourceVersion;
    state.latestSnapshot = {
      ...state.latestSnapshot,
      sourceVersion,
      options,
    };
    return this.sendProjection({
      type: "setProjectionOptions",
      protocolVersion: CHAT_PROJECTION_PROTOCOL_VERSION,
      sessionId,
      generation: state.generation,
      sourceVersion,
      requestId: ++this.nextRequestId,
      options,
    });
  }

  disposeSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (this.worker) {
      const request: ChatProjectionRequest = {
        type: "disposeSession",
        protocolVersion: CHAT_PROJECTION_PROTOCOL_VERSION,
        sessionId,
        generation: state.generation,
        sourceVersion: state.sourceVersion,
        requestId: ++this.nextRequestId,
      };
      this.worker.postMessage(request);
    }
    const activeRequestId = this.activeRequestBySession.get(sessionId);
    if (activeRequestId !== undefined) {
      this.rejectPending(
        activeRequestId,
        new Error("Projection session was disposed")
      );
    }
    const queued = this.queuedRequestBySession.get(sessionId);
    queued?.reject(new Error("Projection session was disposed"));
    this.queuedRequestBySession.delete(sessionId);
    this.sessions.delete(sessionId);
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = this.createWorker();
    this.worker.onmessage = (event: MessageEvent<ChatProjectionResponse>) => {
      this.handleResponse(event.data);
    };
    this.worker.onerror = (event) => {
      this.handleWorkerFailure(
        new Error(event.message || "Chat projection Worker crashed")
      );
    };
    return this.worker;
  }

  private sendProjection(
    request: ChatProjectionRequest
  ): Promise<ProjectionClientResult> {
    return new Promise((resolve, reject) => {
      const deferred: DeferredRequest = {
        request,
        resolve: (response) =>
          resolve({
            result: response.result,
            sourceVersion: response.sourceVersion,
            generation: response.generation,
            projectionRevision: response.projectionRevision,
            metrics: response.metrics,
          }),
        reject,
      };
      if (this.activeRequestBySession.has(request.sessionId)) {
        const previousQueued = this.queuedRequestBySession.get(
          request.sessionId
        );
        previousQueued?.reject(new Error("Superseded chat projection request"));
        this.queuedRequestBySession.set(request.sessionId, deferred);
        return;
      }
      this.dispatchProjection(deferred);
    });
  }

  private dispatchProjection(deferred: DeferredRequest): void {
    const { request } = deferred;
    const worker = this.ensureWorker();
    const timeout = setTimeout(() => {
      if (!this.pending.has(request.requestId)) return;
      this.handleWorkerFailure(new Error("Chat projection Worker timed out"));
    }, this.requestTimeoutMs);
    this.pending.set(request.requestId, {
      ...deferred,
      sessionId: request.sessionId,
      generation: request.generation,
      sourceVersion: request.sourceVersion,
      requestId: request.requestId,
      timeout,
    });
    this.activeRequestBySession.set(request.sessionId, request.requestId);
    worker.postMessage(request);
  }

  private snapshotDeferred(
    deferred: DeferredRequest,
    state: SessionClientState
  ): DeferredRequest {
    const snapshot = state.latestSnapshot;
    return {
      ...deferred,
      request: {
        type: "initSnapshot",
        protocolVersion: CHAT_PROJECTION_PROTOCOL_VERSION,
        sessionId: snapshot.sessionId,
        generation: state.generation,
        sourceVersion: snapshot.sourceVersion,
        requestId: ++this.nextRequestId,
        events: snapshot.events,
        options: snapshot.options,
        toolRegistry: getToolClassifierRegistrySnapshot(),
      },
    };
  }

  private dispatchQueued(
    sessionId: string,
    acknowledgedSourceVersion?: number
  ): void {
    const queued = this.queuedRequestBySession.get(sessionId);
    if (!queued) return;
    this.queuedRequestBySession.delete(sessionId);
    const state = this.sessions.get(sessionId);
    if (!state) {
      queued.reject(new Error("Projection session was disposed"));
      return;
    }
    const request = queued.request;
    const needsSnapshot =
      request.generation !== state.generation ||
      acknowledgedSourceVersion === undefined ||
      ((request.type === "appendEvents" || request.type === "applyDelta") &&
        request.baseVersion !== acknowledgedSourceVersion) ||
      (request.type === "setProjectionOptions" &&
        request.sourceVersion !== acknowledgedSourceVersion);
    this.dispatchProjection(
      needsSnapshot ? this.snapshotDeferred(queued, state) : queued
    );
  }

  private handleResponse(response: ChatProjectionResponse): void {
    if (response.type === "resyncRequired") {
      const pending = this.pending.get(response.requestId);
      const state = this.sessions.get(response.sessionId);
      if (!pending || !state) return;
      if (
        pending.sessionId !== response.sessionId ||
        pending.generation !== response.generation ||
        pending.sourceVersion !== response.sourceVersion ||
        state.generation !== response.generation
      ) {
        this.rejectPending(
          response.requestId,
          new Error("Discarded stale chat projection resync")
        );
        this.dispatchQueued(response.sessionId);
        return;
      }
      this.clearPending(response.requestId);
      state.generation += 1;
      const queued = this.queuedRequestBySession.get(response.sessionId);
      if (queued) {
        this.queuedRequestBySession.delete(response.sessionId);
        pending.reject(new Error("Superseded chat projection request"));
        this.dispatchProjection(this.snapshotDeferred(queued, state));
      } else {
        this.dispatchProjection(this.snapshotDeferred(pending, state));
      }
      return;
    }
    if (response.type === "workerError") {
      this.rejectPending(
        response.requestId,
        new Error(`${response.code}: ${response.message}`)
      );
      this.dispatchQueued(response.sessionId);
      return;
    }
    if (response.type !== "projection") return;
    const pending = this.pending.get(response.requestId);
    const state = this.sessions.get(response.sessionId);
    if (!pending || !state) return;
    if (
      pending.sessionId !== response.sessionId ||
      pending.generation !== response.generation ||
      pending.sourceVersion !== response.sourceVersion ||
      state.generation !== response.generation
    ) {
      this.rejectPending(
        response.requestId,
        new Error("Discarded stale chat projection response")
      );
      this.dispatchQueued(response.sessionId);
      return;
    }
    this.clearPending(response.requestId);
    this.failureCount = 0;
    pending.resolve(response);
    this.dispatchQueued(response.sessionId, response.sourceVersion);
  }

  private clearPending(requestId: number): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    if (
      this.activeRequestBySession.get(pending.sessionId) === pending.requestId
    ) {
      this.activeRequestBySession.delete(pending.sessionId);
    }
    return pending;
  }

  private rejectPending(requestId: number, error: Error): void {
    const pending = this.clearPending(requestId);
    pending?.reject(error);
  }

  private handleWorkerFailure(error: Error): void {
    this.failureCount += 1;
    log.warn(
      "Worker failure; falling back to the shared projection core",
      error
    );
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.activeRequestBySession.clear();
    for (const queued of this.queuedRequestBySession.values()) {
      queued.reject(error);
    }
    this.queuedRequestBySession.clear();
    for (const state of this.sessions.values()) state.generation += 1;
    if (this.failureCount >= MAX_FAILURES_BEFORE_DISABLE) this.disabled = true;
  }
}

export const chatProjectionClient = new ChatProjectionClient();
