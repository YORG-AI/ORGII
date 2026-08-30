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
import React, { memo, useId } from "react";

import { HugeiconsIcon, type IconSvgElement } from "@src/icons";

import {
  SECTION_GAP_CLASSES,
  SECTION_HEADING_CLASSES,
  SECTION_INTRO_TOKENS,
} from "./tokens";

export interface SectionHeadingProps {
  /** Heading text */
  title: string;
  /** Section content (containers, rows, etc.) */
  children?: React.ReactNode;
  /** Optional id for scroll-to-section navigation */
  id?: string;
  /** Keep the heading visible while its scroll container moves. */
  sticky?: boolean;
  /** Visual/semantic treatment. Existing settings sections use `section`. */
  appearance?: "section" | "intro";
  /** Supporting copy for the `intro` appearance. */
  description?: React.ReactNode;
  /** Leading glyph for the `intro` appearance (static `@src/icons` data). */
  icon?: IconSvgElement;
  /** Semantic heading level. Defaults to 2 for section and 1 for intro. */
  headingLevel?: 1 | 2 | 3;
  /** Additional class for the outer content group. */
  className?: string;
}

const SectionHeading: React.FC<SectionHeadingProps> = memo(
  ({
    title,
    children,
    id,
    sticky = true,
    appearance = "section",
    description,
    icon: Icon,
    headingLevel,
    className = "",
  }) => {
    const generatedTitleId = useId();
    const HeadingTag = `h${
      headingLevel ?? (appearance === "intro" ? 1 : 2)
    }` as "h1" | "h2" | "h3";

    if (appearance === "intro") {
      return (
        <section
          id={id}
          className={`${SECTION_INTRO_TOKENS.container} ${className}`.trim()}
          aria-labelledby={generatedTitleId}
        >
          <header className={SECTION_INTRO_TOKENS.header}>
            {Icon && (
              <HugeiconsIcon
                icon={Icon}
                size={SECTION_INTRO_TOKENS.iconSize}
                strokeWidth={1.7}
                className={SECTION_INTRO_TOKENS.icon}
                aria-hidden
              />
            )}
            <div className="min-w-0">
              <HeadingTag
                id={generatedTitleId}
                className={SECTION_INTRO_TOKENS.title}
              >
                {title}
              </HeadingTag>
              {description && (
                <p className={SECTION_INTRO_TOKENS.description}>
                  {description}
                </p>
              )}
            </div>
          </header>
          <div className={SECTION_INTRO_TOKENS.body}>{children}</div>
        </section>
      );
    }

    return (
      <div id={id} className={id ? "scroll-mt-4" : undefined}>
        <div className={SECTION_GAP_CLASSES}>
          <HeadingTag
            className={`${sticky ? "sticky top-0 z-30 bg-bg-2" : ""} pb-1 pt-4 ${SECTION_HEADING_CLASSES}`}
          >
            {title}
          </HeadingTag>
          <div className="flex flex-col gap-3">{children}</div>
        </div>
      </div>
    );
  }
);

SectionHeading.displayName = "SectionHeading";

export default SectionHeading;
