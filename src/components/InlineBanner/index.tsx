/**
 * InlineBanner — full-width status strip pinned inside a panel.
 *
 * For messages that belong to a whole surface rather than one control: a failed
 * detail fetch, a degraded connection, a blocked operation. Distinct from
 * `InlineAlert`, which is a padded card that sits in content flow.
 *
 * A banner reporting a failure must outlive the state that produced it —
 * background refreshes routinely clear the error the moment they succeed, which
 * pulls the message off screen before it can be read. Pair this with
 * {@link useDismissibleMessage} so the strip stays until the reader closes it.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import { Cancel01Icon, HugeiconsIcon } from "@src/icons";

export type InlineBannerTone = "danger" | "warning" | "info";

// The semantic scales stop at 6 (see tailwind.config.js COLOR_STEPS_6); a `-7`
// step silently produces no class and leaves the text inheriting its parent.
const TONE_CLASSES: Record<InlineBannerTone, string> = {
  danger: "bg-danger-1 text-danger-6",
  warning: "bg-warning-1 text-warning-6",
  info: "bg-fill-1 text-text-2",
};

export interface InlineBannerProps {
  children?: React.ReactNode;
  tone?: InlineBannerTone;
  /** Renders the dismiss control. Omit for a banner the surface owns. */
  onDismiss?: () => void;
  className?: string;
  dataTestId?: string;
}

export const InlineBanner: React.FC<InlineBannerProps> = ({
  children,
  tone = "danger",
  onDismiss,
  className = "",
  dataTestId,
}) => {
  const { t } = useTranslation("common");

  return (
    <div
      role="status"
      data-testid={dataTestId}
      className={`flex shrink-0 items-start gap-2 border-b border-border-1 px-4 py-1.5 text-[11px] ${TONE_CLASSES[tone]} ${className}`.trim()}
    >
      {/* Failure text is content worth copying — often a URL or an id. */}
      <span className="allow-select-deep min-w-0 flex-1 select-text break-words">
        {children}
      </span>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("actions.close", "Close")}
          title={t("actions.close", "Close")}
          data-testid={dataTestId ? `${dataTestId}-dismiss` : undefined}
          className="-mr-1 mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors hover:bg-fill-2"
        >
          <HugeiconsIcon
            icon={Cancel01Icon}
            data-icon="x"
            size={12}
            strokeWidth={2}
            aria-hidden
          />
        </button>
      ) : null}
    </div>
  );
};

InlineBanner.displayName = "InlineBanner";

/**
 * Holds the latest non-empty `message` until the reader dismisses it.
 *
 * Surfaces derive their error from state that a later success resets, so
 * reading `message` directly makes the banner vanish on its own. This keeps the
 * last message on screen, swaps in a newer one, and clears only on dismiss.
 */
export function useDismissibleMessage(message: string | null): {
  visibleMessage: string | null;
  dismiss: () => void;
} {
  // Tracks the source alongside what is shown, so a re-render can tell a fresh
  // message from the source resetting itself without reading a ref mid-render.
  const [state, setState] = React.useState<{
    source: string | null;
    visible: string | null;
  }>({ source: message, visible: message });

  if (state.source !== message) {
    // A new message replaces whatever is showing; the source going empty
    // leaves the current message in place for the reader to dismiss.
    setState({ source: message, visible: message ?? state.visible });
  }

  const dismiss = React.useCallback(
    () => setState((current) => ({ ...current, visible: null })),
    []
  );

  return { visibleMessage: state.visible, dismiss };
}

export default InlineBanner;
