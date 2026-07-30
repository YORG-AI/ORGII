/**
 * How long a session-reference refusal stays on screen.
 *
 * The global toast default is 1s, which is fine for "Copied" but not for
 * the only thing that happens when a reference is refused. At 1s the
 * message is gone before it can be read, and a working refusal becomes
 * indistinguishable from a chip that does nothing — which is exactly how
 * it was first reported.
 */
export const REFUSAL_MESSAGE_DURATION_MS = 6000;
