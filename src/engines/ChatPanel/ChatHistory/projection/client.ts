import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { getToolClassifierRegistrySnapshot } from "@src/engines/SessionCore/rendering/registry/toolClassifierRegistry";
import { createLogger } from "@src/hooks/logger";

import type {
  ChatHistoryProjectionOptions,
  ChatHistoryProjectionResult,
} from "./core";
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

interface PendingRequest {
  sessionId: string;
  generation: number;
  sourceVersion: number;
  requestId: number;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (response: ProjectionResponse) => void;
  reject: (error: Error) => void;
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
  private latestPendingBySession = new Map<string, number>();
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
    baseVersion: number;
    sourceVersion: number;
    upserts: SessionEvent[];
    removedIds: string[];
    eventIds: string[];
    options: ChatHistoryProjectionOptions;
  }): Promise<ProjectionClientResult> {
    const state = this.sessions.get(input.sessionId);
    if (!state) {
      return Promise.reject(new Error("Projection session is not initialized"));
    }
    state.sourceVersion = input.sourceVersion;
    const upsertsById = new Map(
      input.upserts.map((event) => [event.id, event])
    );
    const previousById = new Map(
      state.latestSnapshot.events.map((event) => [event.id, event])
    );
    state.latestSnapshot = {
      ...state.latestSnapshot,
      sourceVersion: input.sourceVersion,
      options: input.options,
      events: input.eventIds
        .map((id) => upsertsById.get(id) ?? previousById.get(id))
        .filter((event): event is SessionEvent => Boolean(event)),
    };
    return this.sendProjection({
      type: "applyDelta",
      protocolVersion: CHAT_PROJECTION_PROTOCOL_VERSION,
      sessionId: input.sessionId,
      generation: state.generation,
      sourceVersion: input.sourceVersion,
      requestId: ++this.nextRequestId,
      baseVersion: input.baseVersion,
      upserts: input.upserts,
      removedIds: input.removedIds,
      eventIds: input.eventIds,
      options: input.options,
    });
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
    // Always free local session state, even when the worker is gone
    // (crashed/disabled) — otherwise the session's retained snapshot leaks for
    // the app lifetime. Only notify the worker when one still exists.
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
    const pendingRequestId = this.latestPendingBySession.get(sessionId);
    if (pendingRequestId !== undefined) {
      const pending = this.pending.get(pendingRequestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(pendingRequestId);
        pending.reject(new Error("Projection session was disposed"));
      }
      this.latestPendingBySession.delete(sessionId);
    }
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
    const worker = this.ensureWorker();
    const previousRequestId = this.latestPendingBySession.get(
      request.sessionId
    );
    if (previousRequestId !== undefined) {
      const previous = this.pending.get(previousRequestId);
      if (previous) {
        clearTimeout(previous.timeout);
        this.pending.delete(previousRequestId);
        previous.reject(new Error("Superseded chat projection request"));
      }
    }
    this.latestPendingBySession.set(request.sessionId, request.requestId);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(request.requestId)) return;
        const timeoutError = new Error("Chat projection Worker timed out");
        this.handleWorkerFailure(timeoutError);
      }, this.requestTimeoutMs);
      this.pending.set(request.requestId, {
        sessionId: request.sessionId,
        generation: request.generation,
        sourceVersion: request.sourceVersion,
        requestId: request.requestId,
        timeout,
        resolve: (response) =>
          resolve({
            result: response.result,
            sourceVersion: response.sourceVersion,
            generation: response.generation,
            projectionRevision: response.projectionRevision,
            metrics: response.metrics,
          }),
        reject,
      });
      worker.postMessage(request);
    });
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
        state.generation !== response.generation ||
        state.sourceVersion !== response.sourceVersion
      ) {
        this.rejectPending(
          response.requestId,
          new Error("Discarded stale chat projection resync")
        );
        return;
      }
      this.clearPending(response.requestId);
      state.generation += 1;
      const snapshotPromise = this.projectSnapshot(state.latestSnapshot);
      snapshotPromise.then(
        (result) =>
          pending.resolve({
            type: "projection",
            protocolVersion: CHAT_PROJECTION_PROTOCOL_VERSION,
            sessionId: response.sessionId,
            generation: result.generation,
            sourceVersion: result.sourceVersion,
            requestId: response.requestId,
            projectionRevision: result.projectionRevision,
            result: result.result,
            metrics: result.metrics,
          }),
        pending.reject
      );
      return;
    }
    if (response.type === "workerError") {
      this.rejectPending(
        response.requestId,
        new Error(`${response.code}: ${response.message}`)
      );
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
      state.generation !== response.generation ||
      state.sourceVersion !== response.sourceVersion
    ) {
      this.rejectPending(
        response.requestId,
        new Error("Discarded stale chat projection response")
      );
      return;
    }
    this.clearPending(response.requestId);
    this.failureCount = 0;
    pending.resolve(response);
  }

  private clearPending(requestId: number): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    if (
      this.latestPendingBySession.get(pending.sessionId) === pending.requestId
    ) {
      this.latestPendingBySession.delete(pending.sessionId);
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
    this.latestPendingBySession.clear();
    for (const state of this.sessions.values()) state.generation += 1;
    if (this.failureCount >= MAX_FAILURES_BEFORE_DISABLE) {
      this.disabled = true;
      // The worker path is permanently off now; its retained per-session
      // snapshots are dead weight (the main-thread fallback never reads them).
      this.sessions.clear();
    }
  }
}

export const chatProjectionClient = new ChatProjectionClient();
