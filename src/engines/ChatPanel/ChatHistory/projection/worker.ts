import type { ChatProjectionRequest, ChatProjectionResponse } from "./protocol";
import { ChatProjectionRuntime } from "./runtime";

const runtime = new ChatProjectionRuntime(4);
const scope = self as unknown as {
  postMessage(message: ChatProjectionResponse): void;
  onmessage: ((event: MessageEvent<ChatProjectionRequest>) => void) | null;
};

scope.onmessage = (event: MessageEvent<ChatProjectionRequest>) => {
  try {
    scope.postMessage(runtime.handle(event.data));
  } catch (error) {
    const request = event.data;
    scope.postMessage({
      protocolVersion: request.protocolVersion,
      sessionId: request.sessionId,
      generation: request.generation,
      sourceVersion: request.sourceVersion,
      requestId: request.requestId,
      type: "workerError",
      code: "PROJECTION_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
