export const SESSION_STATUS_DOT_COLOR = {
  default: "var(--color-fill-4)",
  working: "var(--color-primary-6)",
  unread: "var(--color-success-6)",
  asking: "var(--color-warning-6)",
  failed: "var(--color-danger-6)",
  archived: "var(--color-text-3)",
} as const;

export type SessionStatusDotTone = keyof typeof SESSION_STATUS_DOT_COLOR;

export function resolveSessionStatusDotColor(
  tone: SessionStatusDotTone
): string {
  return SESSION_STATUS_DOT_COLOR[tone];
}
