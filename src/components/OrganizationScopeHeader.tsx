import React from "react";

import Select, { type SelectOption } from "@src/components/Select";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";

export interface OrganizationScopeHeaderProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  tabControl: React.ReactNode;
  dataTestId: string;
  selectorDataTestId: string;
}

/**
 * Shared `organization selector | tabs` header used by organization-owned
 * detail surfaces. Scope navigation stays controlled by the owning feature;
 * this component owns only the common layout and selector presentation.
 */
export function OrganizationScopeHeader({
  value,
  options,
  onChange,
  tabControl,
  dataTestId,
  selectorDataTestId,
}: OrganizationScopeHeaderProps) {
  return (
    <div
      className="sticky top-0 z-20 shrink-0 bg-chat-pane"
      data-testid={dataTestId}
    >
      <div
        className={`${DETAIL_PANEL_TOKENS.headerWidth} flex h-14 min-w-0 items-center justify-center gap-3 px-4 pt-1`}
      >
        <div className="flex -translate-y-1 items-center gap-2">
          <Select
            value={value}
            options={options}
            onChange={(nextValue) => {
              if (Array.isArray(nextValue)) return;
              onChange(String(nextValue));
            }}
            showSearch={options.length > 8}
            size="large"
            appearance="bare"
            radius="pill"
            dropdownMinWidth={168}
            dropdownWidthMode="auto"
            className="select-title-row w-auto shrink-0"
            selectorClassName="max-w-[240px] !gap-2 !px-1 !text-[16px] !leading-6 [&_.select-suffix]:!ml-0"
            dataTestId={selectorDataTestId}
          />
          <span
            className="h-5 w-px shrink-0 bg-border-2"
            role="separator"
            aria-hidden
            data-testid={`${selectorDataTestId}-separator`}
          />
        </div>
        <div className="min-w-0 overflow-x-auto scrollbar-hide">
          {tabControl}
        </div>
      </div>
    </div>
  );
}

export default OrganizationScopeHeader;
