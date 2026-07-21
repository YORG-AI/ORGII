/**
 * SectionContainer Component
 *
 * Semantic page container for structured pages.
 * Optional sub-section title above the card.
 *
 * Usage:
 *   <SectionContainer title="Layout">
 *     <SectionRow label="Theme"><Select /></SectionRow>
 *   </SectionContainer>
 */
import React, { memo } from "react";

import {
  SECTION_CONTAINER_CLASSES,
  SECTION_PADDING,
  SECTION_SUBHEADING_CLASSES,
} from "./tokens";

export interface SectionContainerProps {
  /** Container content */
  children: React.ReactNode;
  /** Optional sub-section title above the card */
  title?: string;
  /**
   * Optional fully-custom title row (e.g. a TabPill). When provided, this
   * REPLACES the `title` string rendering — the container draws this node
   * as the title row above the card and ignores `title`.
   */
  titleSlot?: React.ReactNode;
  /** Optional className for additional styling */
  className?: string;
  /** Vertical padding variant (default: "none" — px-4 is always applied) */
  padding?: "none" | "default" | "compact";
}

const SectionContainer: React.FC<SectionContainerProps> = memo(
  ({ children, title, titleSlot, className = "", padding = "none" }) => {
    const card = (
      <div
        className={`${SECTION_CONTAINER_CLASSES} ${SECTION_PADDING[padding]} ${className}`.trim()}
      >
        {children}
      </div>
    );

    if (!title && !titleSlot) return card;

    return (
      <div className="flex flex-col gap-3 [&:not(:first-child)]:mt-3">
        {titleSlot ? (
          // Match the pl-1 baked into SECTION_SUBHEADING_CLASSES so a custom
          // title row (e.g. TabPill) lines up with the static-title path and
          // with rows inside the card below.
          <div className="pl-1">{titleSlot}</div>
        ) : (
          <div className={SECTION_SUBHEADING_CLASSES}>{title}</div>
        )}
        {card}
      </div>
    );
  }
);

SectionContainer.displayName = "SectionContainer";

export default SectionContainer;
