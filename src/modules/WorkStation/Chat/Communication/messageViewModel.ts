import { isPlanDisplayEvent } from "@src/engines/SessionCore/derived/planDisplayEvents";

import type { MessageEntry, MessageViewMode } from "./types";

interface CommunicationMessageBuckets {
  chatMessages: MessageEntry[];
  thinkMessages: MessageEntry[];
  todoMessages: MessageEntry[];
  interactionMessages: MessageEntry[];
}

interface CommunicationMessageViewModel {
  previewMessages: MessageEntry[];
  transcriptMessages: MessageEntry[];
}

export function buildCommunicationMessageViewModel({
  chatMessages,
  thinkMessages,
  todoMessages,
  interactionMessages,
}: CommunicationMessageBuckets): CommunicationMessageViewModel {
  const previewMessages = interactionMessages.filter((message) =>
    isPlanDisplayEvent(message.event)
  );
  const transcriptMessages = [
    ...chatMessages,
    ...thinkMessages,
    ...todoMessages,
    ...interactionMessages,
  ].sort((messageA, messageB) => {
    const timestampDelta =
      new Date(messageA.timestamp).getTime() -
      new Date(messageB.timestamp).getTime();
    return timestampDelta || messageA.order - messageB.order;
  });

  return { previewMessages, transcriptMessages };
}

interface SelectCommunicationMessagesOptions {
  viewMode: MessageViewMode;
  viewModel: CommunicationMessageViewModel;
  thinkMessages: MessageEntry[];
  todoMessages: MessageEntry[];
  interactionMessages: MessageEntry[];
}

export function selectCommunicationMessages({
  viewMode,
  viewModel,
  thinkMessages,
  todoMessages,
  interactionMessages,
}: SelectCommunicationMessagesOptions): MessageEntry[] {
  switch (viewMode) {
    case "chat":
      return viewModel.transcriptMessages;
    case "think":
      return thinkMessages;
    case "todo":
      return todoMessages;
    case "preview":
      return viewModel.previewMessages;
    case "interaction":
      return interactionMessages;
  }
}
