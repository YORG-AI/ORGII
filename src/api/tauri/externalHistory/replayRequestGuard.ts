/**
 * Monotonic guard for replay payload requests whose underlying
 * session/generation/event identity can change while an async IPC call is in
 * flight. Only the newest request in the current component episode may
 * publish state.
 */
export class ReplayRequestGuard {
  private epoch = 0;

  begin(): number {
    this.epoch += 1;
    return this.epoch;
  }

  invalidate(): void {
    this.epoch += 1;
  }

  isCurrent(requestEpoch: number): boolean {
    return this.epoch === requestEpoch;
  }
}
