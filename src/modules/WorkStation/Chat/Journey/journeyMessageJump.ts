const JOURNEY_MESSAGE_JUMP_EVENT = "orgii:journey-message-jump";

export function requestJourneyMessageJump(messageId: string): void {
  if (messageId)
    window.dispatchEvent(
      new window.CustomEvent(JOURNEY_MESSAGE_JUMP_EVENT, { detail: messageId })
    );
}

export function listenForJourneyMessageJump(
  onJump: (messageId: string) => void
): () => void {
  const listener = (event: Event) => {
    const messageId = (event as CustomEvent<string>).detail;
    if (typeof messageId === "string" && messageId) onJump(messageId);
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
