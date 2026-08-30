import React, { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

import { Placeholder } from "@src/components/Placeholder";
import type { DiffViewMode } from "@src/types/git/types";

import DiffFileSection from "../DiffFileSection";
import type { DiffFileSectionData } from "../DiffFileSection";
import { getDefaultDiffSectionExpanded } from "./expansion";

export interface DiffSectionListItem<TFile extends DiffFileSectionData> {
  key: string;
  file: TFile;
}

export interface DiffSectionListProps<TFile extends DiffFileSectionData> {
  sections: Array<DiffSectionListItem<TFile>>;
  viewMode: DiffViewMode;
  loading?: boolean;
  emptyTitle: string;
  emptySubtitle?: string;
  repoPath?: string;
  collapseThreshold?: number;
  /** Start collapsible sections closed regardless of list size. */
  defaultCollapsed?: boolean;
  collapseSignal?: number;
  getSectionRef?: (path: string) => React.RefObject<HTMLDivElement | null>;
  focusedPath?: string | null;
  focusedNonce?: number;
  onFileSelect?: (path: string) => void;
  onRequestContent?: (file: TFile) => void;
  onExpansionChange?: (file: TFile, expanded: boolean) => void;
  sectionKeySuffix?: (section: DiffSectionListItem<TFile>) => string | number;
  showBottomBorder?: boolean;
  /** Show the original path after renamed files in each section header. */
  showRenamePath?: boolean;
  /** When true, each section renders a flat FileHeader instead of the collapsible chevron button. */
  flat?: boolean;
  /** Use the compact header gutter for panes with their own left divider/chrome. */
  compactHeaderGutter?: boolean;
  /** When true, removes the bottom scroll padding (for contexts that have no bottom panel). */
  hideBottomPadding?: boolean;
}

const DEFAULT_COLLAPSE_THRESHOLD = 10;

interface RememberedExpansion {
  signal: number;
  expanded: boolean;
}

function DiffListFooter() {
  return <div className="h-[100px]" aria-hidden />;
}

const DIFF_LIST_COMPONENTS = { Footer: DiffListFooter };

function DiffSectionListInner<TFile extends DiffFileSectionData>({
  sections,
  viewMode,
  loading = false,
  emptyTitle,
  emptySubtitle,
  repoPath,
  collapseThreshold = DEFAULT_COLLAPSE_THRESHOLD,
  defaultCollapsed = false,
  collapseSignal = 0,
  getSectionRef,
  focusedPath,
  focusedNonce = 0,
  onFileSelect,
  onRequestContent,
  onExpansionChange,
  sectionKeySuffix,
  showBottomBorder,
  showRenamePath = false,
  flat = false,
  compactHeaderGutter = false,
  hideBottomPadding = false,
}: DiffSectionListProps<TFile>) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const rememberedExpansionsRef = useRef(
    new Map<string, RememberedExpansion>()
  );

  const keyedSections = useMemo(
    () =>
      sections.map((section) => {
        const suffix = sectionKeySuffix?.(section) ?? "";
        return {
          section,
          renderKey: `${section.key}-${suffix}`,
        };
      }),
    [sectionKeySuffix, sections]
  );

  const keyedSectionsSignature = keyedSections
    .map(({ renderKey }) => renderKey)
    .join("\0");

  // Expansion state belongs to this mounted list, not to recycled rows. Prune
  // removed files and discard all remembered overrides on a collapse signal so
  // virtual row unmount/remount does not either lose or leak state.
  useEffect(() => {
    const validKeys = new Set(keyedSections.map(({ renderKey }) => renderKey));
    const rememberedExpansions = rememberedExpansionsRef.current;
    for (const key of rememberedExpansions.keys()) {
      if (!validKeys.has(key)) rememberedExpansions.delete(key);
    }
  }, [keyedSections, keyedSectionsSignature]);

  useEffect(() => {
    rememberedExpansionsRef.current.clear();
  }, [collapseSignal]);

  const handleExpansionChange = useCallback(
    (
      renderKey: string,
      file: TFile,
      expansionSignal: number,
      expanded: boolean
    ) => {
      rememberedExpansionsRef.current.set(renderKey, {
        signal: expansionSignal,
        expanded,
      });
      onExpansionChange?.(file, expanded);
    },
    [onExpansionChange]
  );

  useEffect(() => {
    if (!focusedPath) return;
    const focusedIndex = keyedSections.findIndex(
      ({ section }) => section.file.path === focusedPath
    );
    if (focusedIndex < 0) return;

    virtuosoRef.current?.scrollToIndex({
      index: focusedIndex,
      align: "start",
      behavior: "auto",
    });

    const frame = window.requestAnimationFrame(() => {
      const externalRef = getSectionRef?.(focusedPath);
      if (externalRef?.current) {
        externalRef.current.scrollIntoView({
          block: "start",
          behavior: "auto",
        });
        return;
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [focusedPath, focusedNonce, getSectionRef, keyedSections]);

  if (loading && sections.length === 0) {
    return (
      <Placeholder
        variant="loading"
        placement="detail-panel"
        fillParentHeight
      />
    );
  }

  if (sections.length === 0) {
    return (
      <Placeholder
        variant="empty"
        placement="detail-panel"
        title={emptyTitle}
        subtitle={emptySubtitle}
        fillParentHeight
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-hidden">
        <Virtuoso
          ref={virtuosoRef}
          className="h-full scrollbar-hide"
          data={keyedSections}
          computeItemKey={(_index, item) => item.renderKey}
          overscan={600}
          {...(hideBottomPadding ? {} : { components: DIFF_LIST_COMPONENTS })}
          itemContent={(_index, { section, renderKey }) => {
            const isFocused = focusedPath === section.file.path;
            const expansionSignal =
              collapseSignal + (isFocused ? focusedNonce : 0);
            const rememberedExpansion =
              rememberedExpansionsRef.current.get(renderKey);
            const expandedOverride =
              rememberedExpansion?.signal === expansionSignal
                ? rememberedExpansion.expanded
                : undefined;

            return (
              <DiffFileSection
                file={section.file}
                viewMode={viewMode}
                defaultExpanded={
                  expandedOverride ??
                  getDefaultDiffSectionExpanded({
                    flat,
                    isFocused,
                    collapseSignal,
                    defaultCollapsed,
                    sectionCount: sections.length,
                    collapseThreshold,
                  })
                }
                expansionSignal={expansionSignal}
                repoPath={repoPath}
                sectionRef={getSectionRef?.(section.file.path)}
                dataPath={section.file.path}
                onFileSelect={onFileSelect}
                onRequestContent={
                  onRequestContent
                    ? () => onRequestContent(section.file)
                    : undefined
                }
                onExpansionChange={(expanded) =>
                  handleExpansionChange(
                    renderKey,
                    section.file,
                    expansionSignal,
                    expanded
                  )
                }
                showBottomBorder={showBottomBorder}
                showRenamePath={showRenamePath}
                flat={flat}
                compactHeaderGutter={compactHeaderGutter}
                noBottomPadding={hideBottomPadding}
              />
            );
          }}
        />
      </div>
    </div>
  );
}

const DiffSectionList = memo(
  DiffSectionListInner
) as typeof DiffSectionListInner;

export default DiffSectionList;
