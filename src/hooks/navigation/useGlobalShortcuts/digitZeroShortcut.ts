export type DigitZeroShortcutTarget =
  | "open_global_preferences"
  | "route_debug_modal"
  | "zoom_reset"
  | null;

export function resolveDigitZeroShortcut({
  altKey,
  shiftKey,
}: {
  altKey: boolean;
  shiftKey: boolean;
}): DigitZeroShortcutTarget {
  if (shiftKey && !altKey) return "route_debug_modal";
  if (altKey && !shiftKey) return "zoom_reset";
  if (!altKey && !shiftKey) return "open_global_preferences";
  return null;
}
