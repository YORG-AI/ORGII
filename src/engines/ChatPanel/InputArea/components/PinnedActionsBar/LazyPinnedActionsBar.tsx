import React, { Suspense, lazy } from "react";

import type { PinnedActionsBarProps } from ".";

const PinnedActionsBar = lazy(() => import("."));

type InactivePinnedActionsRowProps = Pick<
  PinnedActionsBarProps,
  "leadingContent" | "manageButtonPlacement" | "trailingContent"
>;

/** Keep non-skill composer controls stable without loading the skills surface. */
function InactivePinnedActionsRow({
  leadingContent,
  manageButtonPlacement = "after-actions",
  trailingContent,
}: InactivePinnedActionsRowProps): React.ReactNode {
  const hasTrailingContent = Boolean(trailingContent);

  return (
    <div className="relative flex min-w-0 flex-1 items-center gap-1">
      {manageButtonPlacement === "before-actions" ? (
        <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-0.5">
          <div className="flex shrink-0 items-center gap-1">
            {leadingContent}
            {trailingContent}
          </div>
        </div>
      ) : manageButtonPlacement === "after-leading" ? (
        <>
          <div className="flex shrink-0 items-center gap-1">
            {leadingContent}
          </div>
          {hasTrailingContent && (
            <div aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border-2" />
          )}
          <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-0.5">
            {trailingContent}
          </div>
        </>
      ) : (
        <>
          <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-0.5">
            {leadingContent}
          </div>
          {hasTrailingContent && (
            <div aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border-2" />
          )}
          {trailingContent}
        </>
      )}
    </div>
  );
}

/**
 * Defers the pinned skills/actions chunk until the shared visibility preference
 * is enabled. The inactive row preserves non-skill composer controls.
 */
export default function LazyPinnedActionsBar(
  props: PinnedActionsBarProps
): React.ReactNode {
  if (props.showPinnedActions === false) {
    return <InactivePinnedActionsRow {...props} />;
  }

  return (
    <Suspense fallback={<InactivePinnedActionsRow {...props} />}>
      <PinnedActionsBar {...props} />
    </Suspense>
  );
}
