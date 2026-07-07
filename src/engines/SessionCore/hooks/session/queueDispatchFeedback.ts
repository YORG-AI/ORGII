/**
 * Pure helpers for queue-dispatch user feedback (interrupt bookkeeping).
 */

export function releaseForceSendInterruptSlot(
  messageId: string,
  interruptRequestedByMessageId: Set<string>
): void {
  interruptRequestedByMessageId.delete(messageId);
}
