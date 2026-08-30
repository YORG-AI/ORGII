/**
 * ListPanelSearch — Standardized search bar for left list panels.
 *
 * Renders a compact Input with Search icon prefix inside a `px-3 pb-2` wrapper.
 * Supports an optional `rightContent` slot (e.g. refresh button).
 *
 * Used by: ExtensionsListPanel.
 */
import React from "react";

import Input from "@src/components/Input";
import { HugeiconsIcon, Search01Icon } from "@src/icons";

export interface ListPanelSearchProps {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  /** Optional element rendered to the right of the search input (e.g. refresh button) */
  rightContent?: React.ReactNode;
  /** Optional filter pills rendered below the search bar (e.g. TabPill with wrap) */
  filterPills?: React.ReactNode;
}

const ListPanelSearch: React.FC<ListPanelSearchProps> = ({
  value,
  placeholder,
  onChange,
  rightContent,
  filterPills,
}) => {
  return (
    <div className="flex-shrink-0">
      <div className="flex items-center gap-1.5 px-3 pb-2">
        <div className="min-w-0 flex-1">
          <Input
            prefix={
              <HugeiconsIcon
                icon={Search01Icon}
                data-icon="search"
                size={14}
                strokeWidth={1.75}
              />
            }
            placeholder={placeholder}
            value={value}
            onChange={onChange}
            size="default"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        {rightContent}
      </div>
      {filterPills && <div className="px-3 pb-2">{filterPills}</div>}
    </div>
  );
};

export default ListPanelSearch;
