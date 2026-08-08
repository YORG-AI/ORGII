export const APPLICATION_PREVIEW_STYLE = {
  COMPACT: "compact",
  MASCOT: "mascot",
} as const;

export type ApplicationPreviewStyle =
  (typeof APPLICATION_PREVIEW_STYLE)[keyof typeof APPLICATION_PREVIEW_STYLE];

export function normalizeApplicationPreviewStyle(
  value: unknown
): ApplicationPreviewStyle {
  return value === APPLICATION_PREVIEW_STYLE.MASCOT
    ? APPLICATION_PREVIEW_STYLE.MASCOT
    : APPLICATION_PREVIEW_STYLE.COMPACT;
}
