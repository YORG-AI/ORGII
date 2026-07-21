import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useGlobalTokens } from "@src/modules/WorkStation/Browser/hooks/useGlobalTokens";

import { ConsolidatedTokenView } from "./ConsolidatedTokenView";
import { SingleTokenCategoryView } from "./SingleTokenCategoryView";
import {
  areAllTokenSectionsCollapsed,
  countCategoryTokens,
  filterTokenCategories,
  findTokenCategory,
} from "./model";
import { useTokenSectionNavigation } from "./useTokenSectionNavigation";

interface TokenManagerPanelProps {
  category: string;
  repoPath?: string;
}

export const TokenManagerPanel = memo(function TokenManagerPanel({
  category,
  repoPath,
}: TokenManagerPanelProps) {
  const { t } = useTranslation();
  const { categories, loading, error, scan } = useGlobalTokens({
    repoPath,
    autoScan: true,
  });
  const [searchQuery, setSearchQuery] = useState("");
  const consolidated = category === "color-tokens";
  const categoryData = useMemo(
    () => (consolidated ? undefined : findTokenCategory(categories, category)),
    [categories, category, consolidated]
  );
  const filteredCategories = useMemo(
    () => filterTokenCategories(categories, searchQuery),
    [categories, searchQuery]
  );
  const navigation = useTokenSectionNavigation(categories, consolidated);
  const allCollapsed = areAllTokenSectionsCollapsed(
    categories,
    navigation.collapsedSections
  );

  if (!consolidated) {
    return (
      <SingleTokenCategoryView
        category={category}
        categoryData={categoryData}
        loading={loading}
        error={error}
        onRetry={scan}
        t={t}
      />
    );
  }

  return (
    <ConsolidatedTokenView
      categories={filteredCategories}
      tokenCount={countCategoryTokens(filteredCategories)}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      activeCategory={navigation.activeCategory}
      collapsedSections={navigation.collapsedSections}
      allCollapsed={allCollapsed}
      contentRef={navigation.contentRef}
      loading={loading}
      error={error}
      onRetry={scan}
      onAnchorSelect={navigation.handleAnchorSelect}
      onToggleSection={navigation.toggleSection}
      onCollapseAll={navigation.collapseAll}
      onExpandAll={navigation.expandAll}
      setSectionRef={navigation.setSectionRef}
      t={t}
    />
  );
});

export default TokenManagerPanel;
