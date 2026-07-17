/**
 * SectionHeading Component
 *
 * Top-level heading for a page section — title + gap + optional scroll target.
 * Replaces the manual pattern of SECTION_GAP_CLASSES + SECTION_HEADING_CLASSES + <h2>.
 *
 * Usage:
 *   <SectionHeading title="General" id="general">
 *     <SectionContainer>
 *       <SectionRow label="Language" />
 *     </SectionContainer>
 *   </SectionHeading>
 */
import React, { memo } from "react";

import { SECTION_GAP_CLASSES, SECTION_HEADING_CLASSES } from "./tokens";

export interface SectionHeadingProps {
  /** Heading text */
  title: string;
  /** Section content (containers, rows, etc.) */
  children: React.ReactNode;
  /** Optional id for scroll-to-section navigation */
  id?: string;
  /** Keep the heading visible while its scroll container moves. */
  sticky?: boolean;
}

const SectionHeading: React.FC<SectionHeadingProps> = memo(
  ({ title, children, id, sticky = true }) => {
    return (
      <div id={id} className={id ? "scroll-mt-4" : undefined}>
        <div className={SECTION_GAP_CLASSES}>
          <h2
            className={`${sticky ? "sticky top-0 z-30 bg-bg-2" : ""} pb-1 pt-4 ${SECTION_HEADING_CLASSES}`}
          >
            {title}
          </h2>
          <div className="flex flex-col gap-3">{children}</div>
        </div>
      </div>
    );
  }
);

SectionHeading.displayName = "SectionHeading";

export default SectionHeading;
