const JOURNEY_MESSAGE_JUMP_EVENT = "orgii:journey-message-jump";

export interface JourneyMessageJump {
  sessionId: string;
  messageId: string;
}

export function requestJourneyMessageJump(
  sessionId: string,
  messageId: string
): void {
  if (sessionId && messageId)
    window.dispatchEvent(
      new window.CustomEvent<JourneyMessageJump>(JOURNEY_MESSAGE_JUMP_EVENT, {
        detail: { sessionId, messageId },
      })
    );
}

export function listenForJourneyMessageJump(
  onJump: (jump: JourneyMessageJump) => void
): () => void {
  const listener = (event: Event) => {
    const jump = (event as CustomEvent<JourneyMessageJump>).detail;
    if (jump?.sessionId && jump.messageId) onJump(jump);
  };
  window.addEventListener(JOURNEY_MESSAGE_JUMP_EVENT, listener);
  return () => window.removeEventListener(JOURNEY_MESSAGE_JUMP_EVENT, listener);
}

/** Focus the exact rendered transcript row selected by a Journey checkpoint. */
export function focusJourneyMessage(messageId: string): boolean {
  const target = Array.from(
    document.querySelectorAll<HTMLElement>("[data-journey-message-id]")
  ).find((element) => element.dataset.journeyMessageId === messageId);
  if (!target) return false;
  target.dataset.journeyHighlight = "true";
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
}
