import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { ToolClassifierRegistrySnapshot } from "@src/engines/SessionCore/rendering/registry/toolClassifierRegistry";

import type {
  ChatHistoryProjectionOptions,
  ChatHistoryProjectionResult,
} from "./core";

export const CHAT_PROJECTION_PROTOCOL_VERSION = 4 as const;

export interface ProjectionEnvelope {
  protocolVersion: typeof CHAT_PROJECTION_PROTOCOL_VERSION;
  sessionId: string;
  generation: number;
  sourceVersion: number;
  requestId: number;
}

export interface InitSnapshotMessage extends ProjectionEnvelope {
  type: "initSnapshot";
  events: SessionEvent[];
  options: ChatHistoryProjectionOptions;
  toolRegistry: ToolClassifierRegistrySnapshot;
}

export interface ApplyDeltaMessage extends ProjectionEnvelope {
  type: "applyDelta";
  baseVersion: number;
  upserts: SessionEvent[];
  removedIds: string[];
  eventIds: string[];
  options: ChatHistoryProjectionOptions;
}

export interface SetProjectionOptionsMessage extends ProjectionEnvelope {
  type: "setProjectionOptions";
  options: ChatHistoryProjectionOptions;
}

export interface DisposeSessionMessage extends ProjectionEnvelope {
  type: "disposeSession";
}

export interface ResetWorkerMessage extends ProjectionEnvelope {
  type: "resetWorker";
}

export type ChatProjectionRequest =
  | InitSnapshotMessage
  | ApplyDeltaMessage
  | SetProjectionOptionsMessage
  | DisposeSessionMessage
  | ResetWorkerMessage;

export interface ProjectionResponse extends ProjectionEnvelope {
  type: "projection";
  projectionRevision: number;
  result: ChatHistoryProjectionResult;
  metrics: {
    queueWaitMs: number;
    computeMs: number;
    inputEvents: number;
  };
}

export interface ReadyResponse extends ProjectionEnvelope {
  type: "ready";
}

export interface ResyncRequiredResponse extends ProjectionEnvelope {
  type: "resyncRequired";
  expectedBaseVersion: number;
  reason: "missing-session" | "generation-mismatch" | "version-gap";
}

export interface WorkerErrorResponse extends ProjectionEnvelope {
  type: "workerError";
  code: "PROTOCOL_MISMATCH" | "PROJECTION_FAILED";
  message: string;
}

export type ChatProjectionResponse =
  | ProjectionResponse
  | ReadyResponse
  | ResyncRequiredResponse
  | WorkerErrorResponse;

export function createEnvelope(
  values: Omit<ProjectionEnvelope, "protocolVersion">
): ProjectionEnvelope {
  return {
    protocolVersion: CHAT_PROJECTION_PROTOCOL_VERSION,
    ...values,
  };
}
