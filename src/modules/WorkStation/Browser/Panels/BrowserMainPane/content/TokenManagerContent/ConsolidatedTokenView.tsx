import type { TFunction } from "i18next";
import {
  ChevronDown,
  ChevronRight,
  CopyPlus,
  ListChevronsDownUp,
  Palette,
} from "lucide-react";
import type { RefObject } from "react";

import Anchor from "@src/components/Anchor";
import Button from "@src/components/Button";
import type { TokenCategory } from "@src/modules/WorkStation/Browser/hooks/useGlobalTokens";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import DesignFileBar from "../../components/DesignFileBar";
import { TokenCard } from "./TokenCard";

interface ConsolidatedTokenViewProps {
  categories: TokenCategory[];
  tokenCount: number;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  activeCategory: string | null;
  collapsedSections: ReadonlySet<string>;
  allCollapsed: boolean;
  contentRef: RefObject<HTMLDivElement | null>;
  loading: boolean;
  error: string | null;
  onRetry: () => Promise<void>;
  onAnchorSelect: (key: string) => void;
  onToggleSection: (key: string) => void;
  onCollapseAll: () => void;
  onExpandAll: () => void;
  setSectionRef: (key: string) => (element: HTMLDivElement | null) => void;
  t: TFunction;
}

export function ConsolidatedTokenView({
  categories,
  tokenCount,
  searchQuery,
  onSearchQueryChange,
  activeCategory,
  collapsedSections,
  allCollapsed,
  contentRef,
  loading,
  error,
  onRetry,
  onAnchorSelect,
  onToggleSection,
  onCollapseAll,
  onExpandAll,
  setSectionRef,
  t,
}: ConsolidatedTokenViewProps) {
  const anchorItems = categories.map((category) => ({
    key: category.name,
    label: category.name,
    count: category.tokens.length,
  }));
  return (
    <div className="flex h-full flex-col">
      <DesignFileBar
        icon={Palette}
        segments={[
          {
            text: "Color Tokens",
            primary: true,
            secondary: String(tokenCount),
          },
        ]}
        actions={
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            onClick={allCollapsed ? onExpandAll : onCollapseAll}
            title={allCollapsed ? "Expand all" : "Collapse all"}
            icon={
              allCollapsed ? (
                <CopyPlus size={16} />
              ) : (
                <ListChevronsDownUp size={16} />
              )
            }
          />
        }
        searchValue={searchQuery}
        onSearchChange={onSearchQueryChange}
        searchPlaceholder="Search tokens..."
      />
      <div className="flex flex-1 overflow-hidden">
        <div
          className="flex w-[140px] shrink-0 flex-col overflow-y-auto p-2"
          style={{ scrollbarWidth: "none" }}
        >
          <Anchor
            items={anchorItems}
            activeKey={activeCategory}
            onSelect={onAnchorSelect}
          />
        </div>
        <div ref={contentRef} className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <Placeholder
              variant="loading"
              placement="detail-panel"
              fillParentHeight
            />
          ) : error ? (
            <Placeholder
              variant="error"
              placement="detail-panel"
              title={error}
              onRetry={onRetry}
              fillParentHeight
            />
          ) : categories.length === 0 ? (
            <Placeholder
              variant={searchQuery ? "no-results" : "empty"}
              placement="detail-panel"
              title={
                searchQuery
                  ? t("placeholders.noMatchingTokens")
                  : t("placeholders.noTokensAvailable")
              }
              fillParentHeight
            />
          ) : (
            <div className="space-y-4">
              {categories.map((category) => {
                const collapsed = collapsedSections.has(category.name);
                return (
                  <div
                    key={category.name}
                    ref={setSectionRef(category.name)}
                    id={`section-${category.name}`}
                  >
                    <button
                      type="button"
                      onClick={() => onToggleSection(category.name)}
                      aria-expanded={!collapsed}
                      aria-controls={`token-grid-${category.name}`}
                      className="mb-2 flex w-full items-center gap-1.5 text-left"
                    >
                      {collapsed ? (
                        <ChevronRight
                          size={14}
                          className="shrink-0 text-text-4"
                        />
                      ) : (
                        <ChevronDown
                          size={14}
                          className="shrink-0 text-text-4"
                        />
                      )}
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-text-3">
                        {category.name}
                      </h3>
                      <span className="text-[10px] text-text-4">
                        ({category.tokens.length})
                      </span>
                    </button>
                    {!collapsed && (
                      <div
                        id={`token-grid-${category.name}`}
                        className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4"
                      >
                        {category.tokens.map((token) => (
                          <TokenCard key={token.name} token={token} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
