/**
 * NarrowPlaceholder Component
 *
 * Shown when a panel/container is too narrow to display its content.
 * The CALLER controls visibility via static container-query classes.
 *
 * Usage (caller handles show/hide with static Tailwind classes):
 *   <div className="@container">
 *     <NarrowPlaceholder className="@[380px]:hidden" />
 *     <div className="hidden @[380px]:flex">...actual content...</div>
 *   </div>
 *
 * IMPORTANT: Tailwind JIT requires static class strings.
 * Do NOT interpolate breakpoint values dynamically.
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { ArrowExpand01Icon, HugeiconsIcon } from "@src/icons";

export interface NarrowPlaceholderProps {
  /** Override default title */
  title?: string;
  /** Override default subtitle */
  subtitle?: string;
  /** Additional class name — use this for visibility, e.g. "@[380px]:hidden" */
  className?: string;
}

const NarrowPlaceholder: React.FC<NarrowPlaceholderProps> = memo(
  ({ title, subtitle, className = "" }) => {
    const { t } = useTranslation();

    const resolvedTitle = title ?? t("status.panelTooNarrow");
    const resolvedSubtitle = subtitle ?? t("status.panelTooNarrowSubtitle");

    return (
      <div
        className={`flex min-h-[120px] w-full flex-col items-center justify-center gap-2 p-4 text-center ${className}`}
      >
        <HugeiconsIcon
          icon={ArrowExpand01Icon}
          data-icon="maximize-2"
          size={20}
          className="text-text-3"
        />
        <div className="text-[13px] font-medium text-text-2">
          {resolvedTitle}
        </div>
        <div className="text-[12px] text-text-3">{resolvedSubtitle}</div>
      </div>
    );
  }
);

NarrowPlaceholder.displayName = "NarrowPlaceholder";

export default NarrowPlaceholder;

// ============================================
// ResponsiveContainer — wraps the @container + narrow/wide toggle pattern
// ============================================

export interface ResponsiveContainerProps {
  /** Content to show when wide enough */
  children: React.ReactNode;
  /** Extra classes on the outer @container div */
  className?: string;
}

/**
 * Wraps children with the standard narrow-placeholder pattern:
 * - Below 380px: shows NarrowPlaceholder
 * - At 380px+: shows children
 *
 * @example
 * ```tsx
 * <ResponsiveContainer className="h-full min-w-0 bg-bg-2">
 *   {contentArea}
 * </ResponsiveContainer>
 * ```
 */
export const ResponsiveContainer: React.FC<ResponsiveContainerProps> = memo(
  ({ children, className = "" }) => (
    <div className={`flex flex-col overflow-hidden @container ${className}`}>
      <NarrowPlaceholder className="flex-1 @[380px]:hidden" />
      <div className="hidden h-full flex-col overflow-hidden @[380px]:flex">
        {children}
      </div>
    </div>
  )
);

ResponsiveContainer.displayName = "ResponsiveContainer";
