import { useAtom } from "jotai";
import React, { memo } from "react";

import { WorkManagementSearchInput } from "@src/modules/shared/components/WorkManagementSearchInput";
import { kanbanSearchQueryAtom } from "@src/store/ui/kanbanViewStateAtom";

const KanbanSearchInput: React.FC = memo(() => {
  const [query, setQuery] = useAtom(kanbanSearchQueryAtom);

  return (
    <WorkManagementSearchInput
      value={query}
      onChange={setQuery}
      dataTestId="kanban-search-input"
    />
  );
});

KanbanSearchInput.displayName = "KanbanSearchInput";

export default KanbanSearchInput;
