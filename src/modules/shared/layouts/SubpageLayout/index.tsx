/**
 * SubpageLayout Component
 *
 * Reusable layout for settings subpages with:
 * - Full-width PanelHeader (40px) with back button + breadcrumb
 * - Optional left sidebar anchor navigation (using ResizableSplitPanel)
 * - Scrollable content area (max-width constrained)
 *
 * When anchors are provided, the left sidebar uses the same ListPanel tokens
 * as the main settings SettingsListPanel and the split is resizable with a
 * native context menu — all via the existing ResizableSplitPanel component.
 *
 * ## Usage
 *
 * Without anchors (simple subpage):
 * ```tsx
 * <SubpageLayout onBack={handleBack} breadcrumb={{ parent: "Settings", current: "Page" }}>
 *   <Section title="Section">...</Section>
 * </SubpageLayout>
 * ```
 *
 * With anchors (resizable left sidebar):
 * ```tsx
 * <SubpageLayout
 *   onBack={handleBack}
 *   breadcrumb={{ parent: "Settings", current: "Page" }}
 *   anchors={[
 *     { id: "config", label: "Configuration", icon: Settings01Icon },
 *     { id: "gateway", label: "Gateway", icon: RadioIcon },
 *   ]}
 * >
 *   <div id="config"><Section>...</Section></div>
 *   <div id="gateway"><Section>...</Section></div>
 * </SubpageLayout>
 * ```
 */
import React, { useCallback, useEffect, useRef, useState } from "react";

import {
  getListIconClasses,
  getListItemClasses,
} from "@src/components/ListPanel";
import { HugeiconsIcon, type IconSvgElement } from "@src/icons";
import { ResponsiveContainer } from "@src/modules/shared/layouts/NarrowPlaceholder";
import { ResizableSplitPanel } from "@src/scaffold/Resize";

import {
  PanelHeader,
  type PanelHeaderBreadcrumb,
  ScrollFadeContainer,
} from "../blocks";
import {
  SUBPAGE_CONTENT_WRAPPER_CLASSES,
  SUBPAGE_SCROLL_CONTAINER_CLASSES,
} from "./tokens";

// ============================================
// Types
// ============================================

interface SubpageAnchor {
  /** ID matching the section element's `id` attribute */
  id: string;
  /** Display label for the anchor link */
  label: string;
  /** Optional icon glyph (static `@src/icons` data) */
  icon?: IconSvgElement;
}

interface SubpageLayoutProps {
  /** Back button handler */
  onBack: () => void;
  /** Breadcrumb for the PanelHeader */
  breadcrumb: PanelHeaderBreadcrumb;
  /** Optional anchor navigation sections (renders resizable left sidebar) */
  anchors?: SubpageAnchor[];
  /** Content sections */
  children: React.ReactNode;
  /** Optional right-side actions for the PanelHeader */
  headerActions?: React.ReactNode;
  /** Max width for content area in px (default: 900) */
  maxWidth?: number;
}

// ============================================
// Sidebar default dimensions
// ============================================

const SIDEBAR_DEFAULT_WIDTH = 180;
const SIDEBAR_MIN_WIDTH = 140;
const SIDEBAR_MAX_WIDTH = 280;

// ============================================
// Component
// ============================================

const SubpageLayout: React.FC<SubpageLayoutProps> = ({
  onBack,
  breadcrumb,
  anchors,
  children,
  headerActions,
  maxWidth = 900,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isScrollingRef = useRef(false);
  const scrollEndTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const [anchorState, setAnchorState] = useState(() => ({
    anchorsRef: anchors,
    activeId: anchors?.[0]?.id ?? "",
  }));

  // During render: if anchors prop changed, use default (no synchronous setState)
  const activeAnchor =
    anchorState.anchorsRef === anchors
      ? anchorState.activeId
      : (anchors?.[0]?.id ?? "");

  // Scroll to section when anchor is clicked
  const scrollToSection = useCallback(
    (sectionId: string) => {
      const element = document.getElementById(sectionId);
      const container = scrollContainerRef.current;
      if (element && container) {
        isScrollingRef.current = true;

        // Immediately update active state on click
        if (anchors) {
          setAnchorState({ anchorsRef: anchors, activeId: sectionId });
        }

        const containerRect = container.getBoundingClientRect();
        const elementRect = element.getBoundingClientRect();
        const scrollOffset =
          elementRect.top - containerRect.top + container.scrollTop;

        container.scrollTo({
          top: scrollOffset,
          behavior: "smooth",
        });

        // Detect smooth-scroll completion via scroll-idle: clear the flag
        // 150ms after the last scroll event fires instead of using a fixed
        // 400ms timeout that breaks on long distances or slow devices.
        const onScrollEnd = () => {
          clearTimeout(scrollEndTimerRef.current);
          scrollEndTimerRef.current = setTimeout(() => {
            isScrollingRef.current = false;
            container.removeEventListener("scroll", onScrollEnd);
          }, 150);
        };
        container.addEventListener("scroll", onScrollEnd, { passive: true });
      }
    },
    [anchors]
  );

  // Track active section based on scroll position
  useEffect(() => {
    if (!anchors || anchors.length === 0) return;

    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;

    const sectionIds = anchors.map((anchor) => anchor.id);

    const handleScroll = () => {
      if (isScrollingRef.current) return;

      const containerRect = scrollContainer.getBoundingClientRect();
      const containerTop = containerRect.top;
      const threshold = containerRect.height * 0.3;

      let currentSection = sectionIds[0];

      for (const sectionId of sectionIds) {
        const element = document.getElementById(sectionId);
        if (!element) continue;

        const rect = element.getBoundingClientRect();
        const relativeTop = rect.top - containerTop;

        if (relativeTop <= threshold) {
          currentSection = sectionId;
        } else {
          break;
        }
      }

      setAnchorState({ anchorsRef: anchors, activeId: currentSection });
    };

    handleScroll();
    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      scrollContainer.removeEventListener("scroll", handleScroll);
      clearTimeout(scrollEndTimerRef.current);
    };
  }, [anchors]);

  const hasAnchors = anchors && anchors.length > 0;

  // Scrollable content (shared between anchored and non-anchored layouts)
  const contentArea = (
    <ScrollFadeContainer
      ref={scrollContainerRef}
      className={SUBPAGE_SCROLL_CONTAINER_CLASSES}
    >
      <div className={SUBPAGE_CONTENT_WRAPPER_CLASSES} style={{ maxWidth }}>
        {children}
      </div>
    </ScrollFadeContainer>
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Full-width header */}
      <PanelHeader
        onBack={onBack}
        breadcrumb={breadcrumb}
        actions={headerActions}
      />

      {/* Body: resizable split (with anchors) or plain content */}
      {hasAnchors ? (
        <ResizableSplitPanel
          defaultLeftWidth={SIDEBAR_DEFAULT_WIDTH}
          minLeftWidth={SIDEBAR_MIN_WIDTH}
          maxLeftWidth={SIDEBAR_MAX_WIDTH}
          leftPanel={
            <div className="flex h-full flex-col pt-3">
              <div className="scrollbar-overlay min-h-0 flex-1 overflow-y-auto px-2">
                <div className="flex flex-col gap-0.5 pb-2">
                  {anchors.map((anchor) => {
                    const isActive = activeAnchor === anchor.id;
                    const Icon = anchor.icon;
                    return (
                      <button
                        key={anchor.id}
                        className={`w-full text-left ${getListItemClasses(isActive, "wideGap")}`}
                        onClick={() => scrollToSection(anchor.id)}
                      >
                        {Icon && (
                          <HugeiconsIcon
                            icon={Icon}
                            size={16}
                            strokeWidth={1.75}
                            className={getListIconClasses(isActive)}
                          />
                        )}
                        <span>{anchor.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          }
          rightPanel={
            <ResponsiveContainer className="h-full min-w-0">
              {contentArea}
            </ResponsiveContainer>
          }
          className="flex-1"
        />
      ) : (
        <ResponsiveContainer className="min-h-0 flex-1">
          {contentArea}
        </ResponsiveContainer>
      )}
    </div>
  );
};

export default SubpageLayout;
