import { useAtom } from "jotai";
import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { HugeiconsIcon, Search01Icon } from "@src/icons";
import { WorkManagementSearchInput } from "@src/modules/shared/components/WorkManagementSearchInput";
import { kanbanSearchQueryAtom } from "@src/store/ui/kanbanViewStateAtom";

const KanbanSearchInput: React.FC = memo(() => {
  const { t } = useTranslation("common");
  const [query, setQuery] = useAtom(kanbanSearchQueryAtom);
  const [expanded, setExpanded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchVisible = expanded || query.trim().length > 0;
  const searchLabel = t("common.searchPlaceholder");
  const expandSearch = useCallback(() => setExpanded(true), []);
  const closeSearch = useCallback(() => {
    setQuery("");
    setExpanded(false);
  }, [setQuery]);

  useEffect(() => {
    if (searchVisible) inputRef.current?.focus();
  }, [searchVisible]);

  if (!searchVisible) {
    return (
      <Button
        htmlType="button"
        variant="tertiary"
        size="small"
        iconOnly
        onClick={expandSearch}
        aria-label={searchLabel}
        data-testid="kanban-search-trigger"
        icon={
          <HugeiconsIcon
            icon={Search01Icon}
            data-icon="search"
            size={HEADER_ICON_SIZE.sm}
            strokeWidth={2}
          />
        }
      />
    );
  }

  return (
    <WorkManagementSearchInput
      value={query}
      onChange={setQuery}
      onClose={closeSearch}
      placeholder={searchLabel}
      dataTestId="kanban-search-input"
      inputRef={inputRef}
    />
  );
});

KanbanSearchInput.displayName = "KanbanSearchInput";

export default KanbanSearchInput;
