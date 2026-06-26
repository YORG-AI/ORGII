/**
 * Event Handler Context Factory
 *
 * Creates the unified context for all event handlers.
 */
import type { MutableRefObject } from "react";

import {
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";

import type { StreamRefs } from "../../shared/types";
import type {
  EventHandlerCallbacksInternal,
  EventHandlerContext,
  RustAgentFeatures,
} from "./types";

function ref<T>(value: T): MutableRefObject<T> {
  return { current: value };
}

function createStreamRefs(): StreamRefs {
  return {
    idRef: ref(""),
    contentRef: ref(""),
  };
}

export function createEventHandlerContext(
  sessionId: string,
  features: RustAgentFeatures,
  callbacks: EventHandlerCallbacksInternal
): EventHandlerContext {
  const ctx: EventHandlerContext = {
    filterSessionIdRef: ref(sessionId),
    execOutputBufferRef: ref(""),
    onAgentCompleteRef: ref(callbacks.onAgentComplete),
    onContextUsageRef: ref(callbacks.onContextUsage),
    onTokenUpdateRef: ref(callbacks.onTokenUpdate),
    onStatusChangeRef: ref(callbacks.onStatusChange),
    onQuestionRequestRef: ref(callbacks.onQuestionRequest),
    setStreaming: callbacks.setStreaming,
    features,
    getDefaultStore: () =>
      isStoreInitialized() ? getInstrumentedStore() : null,
  };

  ctx.assistantStreamRef = ref(createStreamRefs());
  ctx.thinkingStreamRef = ref(createStreamRefs());
  ctx.toolCallDeltaBuffersRef = ref(new Map());
  ctx.streamingInfoRef = ref({
    isStreaming: false,
    isThinking: false,
    content: "",
  });
  ctx.onStreamingDeltaRef = ref(callbacks.onStreamingDelta);
  ctx.streamingCompleteHandledRef = ref(false);

  if (features.hasPermissionRequest) {
    ctx.onPermissionRequestRef = ref(callbacks.onPermissionRequest);
  }

  if (features.hasCodingSessionBridge) {
    ctx.trackedCodingSessionsRef = ref(new Map());
  }

  return ctx;
}
