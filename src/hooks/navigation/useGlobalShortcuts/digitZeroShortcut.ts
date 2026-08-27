export type DigitZeroShortcutTarget = "route_debug_modal" | "zoom_reset" | null;

export function resolveDigitZeroShortcut({
  altKey,
  shiftKey,
}: {
  altKey: boolean;
  shiftKey: boolean;
}): DigitZeroShortcutTarget {
  if (shiftKey) return altKey ? null : "route_debug_modal";
  return "zoom_reset";
}
