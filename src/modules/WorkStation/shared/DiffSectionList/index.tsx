import React, { memo, useEffect, useRef } from "react";

import { Placeholder } from "@src/modules/shared/layouts/blocks";

import DiffFileSection from "../DiffFileSection";
import type { DiffFileSectionData } from "../DiffFileSection";

export interface DiffSectionListItem<TFile extends DiffFileSectionData> {
  key: string;
  file: TFile;
}

export interface DiffSectionListProps<TFile extends DiffFileSectionData> {
  sections: Array<DiffSectionListItem<TFile>>;
  loading?: boolean;
  emptyTitle: string;
  emptySubtitle?: string;
  repoPath?: string;
  collapseThreshold?: number;
  collapseSignal?: number;
  getSectionRef?: (path: string) => React.RefObject<HTMLDivElement | null>;
  focusedPath?: string | null;
  focusedNonce?: number;
  onFileSelect?: (path: string) => void;
  onRequestContent?: (file: TFile) => void;
  sectionKeySuffix?: (section: DiffSectionListItem<TFile>) => string | number;
  showBottomBorder?: boolean;
  /** Show the original path after renamed files in each section header. */
  showRenamePath?: boolean;
  /** When true, each section renders a flat FileHeader instead of the collapsible chevron button. */
  flat?: boolean;
  /** When true, removes the bottom scroll padding (for contexts that have no bottom panel). */
  hideBottomPadding?: boolean;
}

const DEFAULT_COLLAPSE_THRESHOLD = 10;

function DiffSectionListInner<TFile extends DiffFileSectionData>({
  sections,
  loading = false,
  emptyTitle,
  emptySubtitle,
  repoPath,
  collapseThreshold = DEFAULT_COLLAPSE_THRESHOLD,
  collapseSignal = 0,
  getSectionRef,
  focusedPath,
  focusedNonce = 0,
  onFileSelect,
  onRequestContent,
  sectionKeySuffix,
  showBottomBorder,
  showRenamePath = false,
  flat = false,
  hideBottomPadding = false,
}: DiffSectionListProps<TFile>) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusedPath) return;
    if (!sections.some((section) => section.file.path === focusedPath)) return;

    window.requestAnimationFrame(() => {
      const externalRef = getSectionRef?.(focusedPath);
      if (externalRef?.current) {
        externalRef.current.scrollIntoView({
          block: "start",
          behavior: "auto",
        });
        return;
      }

      const target = scrollContainerRef.current?.querySelector<HTMLElement>(
        `[data-diff-section-path="${CSS.escape(focusedPath)}"]`
      );
      target?.scrollIntoView({ block: "start", behavior: "auto" });
    });
  }, [focusedPath, focusedNonce, getSectionRef, sections]);

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

  const shouldAutoCollapse = sections.length > collapseThreshold;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div
        ref={scrollContainerRef}
        className={`min-h-0 flex-1 overflow-auto${hideBottomPadding ? "" : "pb-[100px]"}`}
      >
        {sections.map((section) => {
          const isFocused = focusedPath === section.file.path;
          const suffix = sectionKeySuffix?.(section) ?? "";
          return (
            <DiffFileSection
              key={`${section.key}-${suffix}`}
              file={section.file}
              defaultExpanded={
                flat ||
                isFocused ||
                (collapseSignal > 0 ? false : !shouldAutoCollapse)
              }
              expansionSignal={collapseSignal + (isFocused ? focusedNonce : 0)}
              repoPath={repoPath}
              sectionRef={getSectionRef?.(section.file.path)}
              dataPath={section.file.path}
              onFileSelect={onFileSelect}
              onRequestContent={
                onRequestContent
                  ? () => onRequestContent(section.file)
                  : undefined
              }
              showBottomBorder={showBottomBorder}
              showRenamePath={showRenamePath}
              flat={flat}
              noBottomPadding={hideBottomPadding}
            />
          );
        })}
      </div>
    </div>
  );
}

const DiffSectionList = memo(
  DiffSectionListInner
) as typeof DiffSectionListInner;

export default DiffSectionList;
