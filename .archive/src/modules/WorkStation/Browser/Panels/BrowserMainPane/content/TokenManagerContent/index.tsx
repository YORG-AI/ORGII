/**
 * TokenManagerPanel - Main tab content for managing design tokens
 *
 * Shows all color tokens consolidated in one view with:
 * - Anchor navigation on the left for category filtering
 * - Search functionality
 * - Section subtitles for each category
 */
import {
  ChevronDown,
  ChevronRight,
  CopyPlus,
  ListChevronsDownUp,
  Palette,
} from "lucide-react";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Anchor from "@src/components/Anchor";
import Button from "@src/components/Button";
import {
  type TokenCategory,
  type TokenDefinition,
  useGlobalTokens,
} from "@src/modules/WorkStation/Browser/hooks/useGlobalTokens";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import DesignFileBar from "../../components/DesignFileBar";

// ============================================
// Types
// ============================================

interface TokenManagerPanelProps {
  /** Category name to display (use "color-tokens" for consolidated view) */
  category: string;
  /** Repository path for token scanning */
  repoPath?: string;
  /** Called when tokens are imported/updated */
  onTokensChange?: (tokens: TokenDefinition[]) => void;
}

// ============================================
// Component
// ============================================

export const TokenManagerPanel: React.FC<TokenManagerPanelProps> = memo(
  ({ category, repoPath, onTokensChange: _onTokensChange }) => {
    const { t } = useTranslation();
    const {
      tokens: _tokens,
      categories,
      loading,
      error,
      scan,
    } = useGlobalTokens({
      repoPath,
      autoScan: true,
    });

    const [activeCategory, setActiveCategory] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
      new Set()
    );
    const contentRef = useRef<HTMLDivElement>(null);
    const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());

    // Check if this is the consolidated color tokens view
    const isConsolidatedView = category === "color-tokens";

    // Get tokens for a specific category
    const singleCategoryData = useMemo(() => {
      if (isConsolidatedView) return null;
      return categories.find(
        (catItem) => catItem.name.toLowerCase() === category.toLowerCase()
      );
    }, [categories, category, isConsolidatedView]);

    // Build anchor items for the category filter
    const anchorItems = useMemo(() => {
      return categories.map((cat) => ({
        key: cat.name,
        label: cat.name,
        count: cat.tokens.length,
      }));
    }, [categories]);

    // Filter categories by search only (anchor scrolls, doesn't filter)
    const filteredCategories = useMemo(() => {
      const query = searchQuery.toLowerCase().trim();

      // Always show all categories (anchor scrolls to them)
      const categoriesToShow: TokenCategory[] = categories;

      // Apply search filter
      if (!query) return categoriesToShow;

      return categoriesToShow
        .map((catItem) => ({
          ...catItem,
          tokens: catItem.tokens.filter(
            (tokenItem) =>
              tokenItem.name.toLowerCase().includes(query) ||
              tokenItem.value.toLowerCase().includes(query)
          ),
        }))
        .filter((catItem) => catItem.tokens.length > 0);
    }, [categories, searchQuery]);

    // Total filtered token count
    const filteredTokenCount = useMemo(() => {
      return filteredCategories.reduce(
        (sum, catItem) => sum + catItem.tokens.length,
        0
      );
    }, [filteredCategories]);

    // Handle anchor selection - scroll to section
    const handleAnchorSelect = useCallback((key: string) => {
      setActiveCategory(key);

      const sectionEl = sectionRefs.current.get(key);
      if (sectionEl) {
        sectionEl.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, []);

    // Register section ref
    const setSectionRef = useCallback(
      (key: string) => (el: HTMLDivElement | null) => {
        if (el) {
          sectionRefs.current.set(key, el);
        } else {
          sectionRefs.current.delete(key);
        }
      },
      []
    );

    // Track scroll position and update active anchor
    useEffect(() => {
      const container = contentRef.current;
      if (!container || !isConsolidatedView) return;

      const handleScroll = () => {
        const containerTop = container.getBoundingClientRect().top;

        // Find the section that's currently in view
        let currentSection: string | null = null;
        let minDistance = Infinity;

        for (const [name, el] of sectionRefs.current.entries()) {
          const rect = el.getBoundingClientRect();
          const distance = Math.abs(rect.top - containerTop);

          // Find the section closest to the top of the container
          if (rect.top <= containerTop + 50 && distance < minDistance) {
            minDistance = distance;
            currentSection = name;
          }
        }

        if (currentSection) {
          setActiveCategory(currentSection);
        }
      };

      // Initial check
      handleScroll();

      container.addEventListener("scroll", handleScroll, { passive: true });
      return () => container.removeEventListener("scroll", handleScroll);
      // sectionRefs is a MutableRefObject — no need for categories in deps.
      // The listener reads sectionRefs.current at call time, so it always
      // sees the latest sections without re-registering on each data update.
    }, [isConsolidatedView]);

    // Toggle section collapse
    const toggleSection = useCallback((sectionName: string) => {
      setCollapsedSections((prev) => {
        const next = new Set(prev);
        if (next.has(sectionName)) {
          next.delete(sectionName);
        } else {
          next.add(sectionName);
        }
        return next;
      });
    }, []);

    // Collapse all sections
    const collapseAll = useCallback(() => {
      setCollapsedSections(new Set(categories.map((cat) => cat.name)));
    }, [categories]);

    // Expand all sections
    const expandAll = useCallback(() => {
      setCollapsedSections(new Set());
    }, []);

    // Check if all sections are collapsed
    const allCollapsed = useMemo(() => {
      return (
        categories.length > 0 &&
        categories.every((cat) => collapsedSections.has(cat.name))
      );
    }, [categories, collapsedSections]);

    // Single category view
    if (!isConsolidatedView) {
      return (
        <div className="flex h-full flex-col">
          <DesignFileBar
            icon={Palette}
            segments={[
              { text: "Design Tokens" },
              {
                text: category,
                primary: true,
                capitalize: true,
                secondary: String(singleCategoryData?.tokens.length ?? 0),
              },
            ]}
          />
          <div className="flex-1 overflow-y-auto p-4">
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
                onRetry={scan}
                fillParentHeight
              />
            ) : !singleCategoryData ? (
              <Placeholder
                variant="error"
                placement="detail-panel"
                title={t("placeholders.categoryNotFound", { category })}
                fillParentHeight
              />
            ) : (
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
                {singleCategoryData.tokens.map((token) => (
                  <TokenCard key={token.name} token={token} />
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }

    // Consolidated Color Tokens view
    return (
      <div className="flex h-full flex-col">
        <DesignFileBar
          icon={Palette}
          segments={[
            {
              text: "Color Tokens",
              primary: true,
              secondary: String(filteredTokenCount),
            },
          ]}
          actions={
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              onClick={allCollapsed ? expandAll : collapseAll}
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
          onSearchChange={setSearchQuery}
          searchPlaceholder="Search tokens..."
        />

        {/* Main content with anchor navigation */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left anchor navigation */}
          <div
            className="flex w-[140px] shrink-0 flex-col overflow-y-auto p-2"
            style={{ scrollbarWidth: "none" }}
          >
            <Anchor
              items={anchorItems}
              activeKey={activeCategory}
              onSelect={handleAnchorSelect}
            />
          </div>

          {/* Token grid with category sections */}
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
                onRetry={scan}
                fillParentHeight
              />
            ) : filteredCategories.length === 0 ? (
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
                {filteredCategories.map((catItem) => {
                  const isCollapsed = collapsedSections.has(catItem.name);

                  return (
                    <div
                      key={catItem.name}
                      ref={setSectionRef(catItem.name)}
                      id={`section-${catItem.name}`}
                    >
                      {/* Section header - clickable */}
                      <button
                        onClick={() => toggleSection(catItem.name)}
                        className="mb-2 flex w-full items-center gap-1.5 text-left"
                      >
                        {isCollapsed ? (
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
                          {catItem.name}
                        </h3>
                        <span className="text-[10px] text-text-4">
                          ({catItem.tokens.length})
                        </span>
                      </button>

                      {/* Token grid - collapsible */}
                      {!isCollapsed && (
                        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
                          {catItem.tokens.map((token) => (
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
);

TokenManagerPanel.displayName = "TokenManagerPanel";

// ============================================
// TokenCard Component
// ============================================

const TokenCard: React.FC<{
  token: TokenDefinition;
}> = memo(({ token }) => {
  // Determine if it's a color value
  const isColorValue =
    /^\d+,\s*\d+,\s*\d+/.test(token.value) ||
    token.value.startsWith("#") ||
    token.value.startsWith("rgb");

  const colorStyle = isColorValue
    ? {
        backgroundColor: token.value.startsWith("#")
          ? token.value
          : token.value.match(/^\d+,\s*\d+,\s*\d+/)
            ? `rgb(${token.value})`
            : token.value,
      }
    : undefined;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border-2 p-2.5">
      {/* Left: Color preview or icon */}
      {colorStyle ? (
        <div
          className="h-9 w-9 shrink-0 rounded border border-border-2"
          style={colorStyle}
        />
      ) : (
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-fill-2 text-xs text-text-3">
          Aa
        </div>
      )}

      {/* Right: Variable name and value */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-text-1">
          --{token.name}
        </div>
        <div className="truncate text-xs text-text-3" title={token.value}>
          {token.value}
        </div>
      </div>
    </div>
  );
});

TokenCard.displayName = "TokenCard";

export default TokenManagerPanel;
