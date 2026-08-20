import React, { memo } from "react";

import Select from "@src/components/Select";
import { SESSION_VIEW_SELECTOR_CLASS } from "@src/engines/ChatPanel/components/SessionViewSwitcher";
import type { UseSessionViewModeResult } from "@src/engines/ChatPanel/hooks/useSessionViewMode";

import WebSessionHeaderBreadcrumb from "./WebSessionHeaderBreadcrumb";
import type { WebSessionListItem } from "./useWebSessionRoster";

export interface WebSessionHeaderViewControlsProps {
  session: WebSessionListItem;
  fallbackName: string;
  rosterSessions: readonly WebSessionListItem[];
  view: UseSessionViewModeResult;
  testIdPrefix: string;
}

export const WebSessionHeaderViewControls: React.FC<WebSessionHeaderViewControlsProps> =
  memo(({ session, fallbackName, rosterSessions, view, testIdPrefix }) => {
    const selectedOption = view.options.find(
      (option) => "value" in option && option.value === view.mode
    );
    const selectedLabel =
      selectedOption && "label" in selectedOption
        ? (selectedOption.triggerLabel ?? selectedOption.label)
        : undefined;
    const ariaLabel =
      typeof selectedLabel === "string" ? selectedLabel : undefined;

    return (
      <div className="flex min-w-0 flex-1 items-center gap-1.5 @container/sessionview">
        <WebSessionHeaderBreadcrumb
          session={session}
          fallbackName={fallbackName}
          rosterSessions={rosterSessions}
        />
        {view.switchable && (
          <>
            <Select
              value={view.mode}
              options={view.options}
              onChange={view.onChange}
              size="small"
              appearance="ghost"
              radius="lg"
              dropdownAlign="right"
              dropdownMinWidth={160}
              dropdownWidthMode="auto"
              className="w-auto shrink-0"
              selectorClassName={SESSION_VIEW_SELECTOR_CLASS}
              dataTestId={`${testIdPrefix}-view-select`}
              ariaLabel={ariaLabel}
            />
            <span
              className="pointer-events-none mx-1.5 h-4 w-px shrink-0 bg-border-2"
              aria-hidden
            />
          </>
        )}
      </div>
    );
  });

WebSessionHeaderViewControls.displayName = "WebSessionHeaderViewControls";
