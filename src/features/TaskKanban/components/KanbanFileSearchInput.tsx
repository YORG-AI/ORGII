import { useAtom } from "jotai";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { SearchInput } from "@src/components/SearchInput";
import { kanbanFileSearchQueryAtom } from "@src/store/ui/kanbanViewStateAtom";

const KanbanFileSearchInput: React.FC = memo(() => {
  const { t } = useTranslation("sessions");
  const [query, setQuery] = useAtom(kanbanFileSearchQueryAtom);
  const clear = useCallback(() => setQuery(""), [setQuery]);

  return (
    <div data-testid="kanban-file-search-input">
      <SearchInput
        value={query}
        onChange={setQuery}
        onClear={clear}
        showClearButton
        hideChevron
        variant="panel"
        surface="pane"
        className="w-64 max-w-[28vw]"
        placeholder={t("kanban.fileSearch.placeholder")}
        ariaLabel={t("kanban.fileSearch.placeholder")}
      />
    </div>
  );
});

KanbanFileSearchInput.displayName = "KanbanFileSearchInput";

export default KanbanFileSearchInput;
