/**
 * Renderer wrapper for `search` tabs.
 *
 * Renders `SearchEditorContent` through the unified dispatcher, pulling
 * repoPath + the result-click / title-change callbacks from the hoisted Code
 * Editor host context and the query/options from tab data — a 1:1 mirror of
 * `TabContentRenderer`'s `case "search"` (including its `handleSearchResultClick`
 * line-aware navigation).
 */
import React, { Suspense, memo, useCallback } from "react";

import { Placeholder } from "@src/components/Placeholder";
import { useEditorHostContext } from "@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/context/editorHostContext";
import type { SearchOptions as StoreSearchOptions } from "@src/store/workstation/codeEditor/search";

import type { UnifiedTabContentProps } from "../types";

const SearchEditorContent = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/SearchEditorContent")
);

const LazyFallback = () => (
  <Placeholder variant="loading" placement="detail-panel" fillParentHeight />
);

const SearchTabRenderer: React.FC<UnifiedTabContentProps> = memo(({ tab }) => {
  const {
    repoPath,
    onFileSelect,
    onFileSelectWithLine,
    onSearchTabTitleChange,
  } = useEditorHostContext();

  const handleSearchResultClick = useCallback(
    (filePath: string, line: number, _column?: number) => {
      if (line > 0 && onFileSelectWithLine) {
        onFileSelectWithLine(filePath, line);
      } else {
        onFileSelect(filePath);
      }
    },
    [onFileSelect, onFileSelectWithLine]
  );

  return (
    <Suspense fallback={<LazyFallback />}>
      <SearchEditorContent
        key={tab.id}
        sessionScopeId={tab.id}
        repoPath={repoPath}
        initialQuery={String(tab.data.initialQuery || "")}
        initialOptions={tab.data.initialOptions as StoreSearchOptions}
        onQueryChangeForTitle={onSearchTabTitleChange}
        onResultClick={handleSearchResultClick}
      />
    </Suspense>
  );
});

SearchTabRenderer.displayName = "SearchTabRenderer";

export default SearchTabRenderer;
