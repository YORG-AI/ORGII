import type {
  AdapterSendInput,
  EventHandlerCallbacks,
  SessionAdapter,
  SessionEventHandler,
} from "../types";

function createNoopEventHandler(): SessionEventHandler {
  return {
    handleEvent(): void {},
    reset(): void {},
    get isStreaming() {
      return false;
    },
    dispose(): void {},
  };
}

export const externalHistoryAdapter: SessionAdapter = {
  category: "external_history",
  historyMode: "bounded-replay",

  async postLoad() {
    return { runStatus: "completed" };
  },

  createEventHandler(
    _sessionId: string,
    _callbacks: EventHandlerCallbacks
  ): SessionEventHandler {
    return createNoopEventHandler();
  },

  async sendMessage(input: AdapterSendInput): Promise<void> {
    throw new Error(
      `External history sessions are read-only and cannot receive messages (${input.sessionId}).`
    );
  },

  async stopSession(): Promise<void> {},
};
