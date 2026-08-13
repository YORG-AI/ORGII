/**
 * CompoundPill Config
 *
 * Shared sizing constants for pill components (CompoundPill + SelectorPill sm/md).
 * Single source of truth for the standard small-pill size token.
 */

/** Icon size for standard pill segments (sm / md SelectorPill, CompoundPill) */
export const PILL_SM_ICON_SIZE = 14;

/** Icon container class — 16×16 line box with a 14px SVG for centered pill text. */
export const PILL_SM_ICON_CONTAINER_CLASS =
  "relative inline-flex h-[16px] w-[16px] items-center justify-center";

/** Pill height token used by CompoundPill and SelectorPill sm/md variants */
export const PILL_SM_HEIGHT_CLASS = "h-[28px]";

/** Label line-height that visually centers 12–13px text in 28px pills. */
export const PILL_SM_LABEL_CLASS = "leading-[16px]";

/** Semantic surface states shared by property and composer pill controls. */
export const PILL_CONTROL_HOVER_CLASS = "enabled:hover:!bg-surface-hover";
export const PILL_CONTROL_FILL_HOVER_CLASS = "enabled:hover:!bg-fill-2";
export const PILL_CONTROL_IDLE_SURFACE_CLASS = `!bg-bg-2 !shadow-none ${PILL_CONTROL_HOVER_CLASS}`;
export const PILL_CONTROL_IDLE_FILL_SURFACE_CLASS = `!bg-fill-1 !shadow-none ${PILL_CONTROL_FILL_HOVER_CLASS}`;
export const PILL_CONTROL_ACTIVE_SURFACE_CLASS = "!bg-surface-hover";
export const PILL_CONTROL_ACTIVE_ACCENT_CLASS = `${PILL_CONTROL_ACTIVE_SURFACE_CLASS} !border-primary-6 !text-primary-6`;
export const PILL_CONTROL_ACTIVE_FILL_ACCENT_CLASS =
  "!bg-fill-2 !border-primary-6 !text-primary-6";
export const PILL_CONTROL_FIELD_HOVER_CLASS = "enabled:hover:!border-border-3";
export const PILL_CONTROL_FIELD_FOCUS_CLASS =
  "!border-primary-6 !shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)]";

export type PillControlFocusTreatment = "accent" | "field";

/** Resolve the standard idle/open treatment for outlined pill controls. */
export function pillControlStateClass(
  isActive: boolean,
  idleSurface: "background" | "fill" = "background",
  focusTreatment: PillControlFocusTreatment = "accent"
): string {
  if (focusTreatment === "field") {
    const surfaceClass =
      idleSurface === "fill"
        ? isActive
          ? "!bg-fill-2"
          : PILL_CONTROL_IDLE_FILL_SURFACE_CLASS
        : isActive
          ? PILL_CONTROL_ACTIVE_SURFACE_CLASS
          : PILL_CONTROL_IDLE_SURFACE_CLASS;

    return isActive
      ? `${surfaceClass} ${PILL_CONTROL_FIELD_FOCUS_CLASS}`
      : `${surfaceClass} ${PILL_CONTROL_FIELD_HOVER_CLASS}`;
  }

  return isActive
    ? idleSurface === "fill"
      ? PILL_CONTROL_ACTIVE_FILL_ACCENT_CLASS
      : PILL_CONTROL_ACTIVE_ACCENT_CLASS
    : idleSurface === "fill"
      ? PILL_CONTROL_IDLE_FILL_SURFACE_CLASS
      : PILL_CONTROL_IDLE_SURFACE_CLASS;
}
