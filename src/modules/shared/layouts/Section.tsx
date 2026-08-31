/**
 * Section Component
 *
 * Generic section with title header and content container.
 * Used across Settings, Profile, and other pages.
 *
 * Variants:
 * - "settings": Compact title (14px, semibold, text-text-1), primary-container card
 * - "profile": Larger title (18px, text-primary-6), fill-2 container
 *
 * Layout patterns:
 * 1. Single container (default):
 *    <Section title="Section">
 *      <Content ... />
 *    </Section>
 *
 * 2. Multiple containers:
 *    <Section title="Section" multiple>
 *      <SectionContainer>...</SectionContainer>
 *      <SectionContainer>...</SectionContainer>
 *    </Section>
 */
import React, { memo, useState } from "react";

import { ArrowDown01Icon, ArrowRight01Icon, HugeiconsIcon } from "@src/icons";

import {
  SECTION_CONTAINER_CLASSES,
  SECTION_PADDING,
} from "./SectionLayout/tokens";

export interface SectionProps {
  /** Section title (optional - omit for no header) */
  title?: string;
  /** Section content */
  children: React.ReactNode;
  /** Visual variant (default: "settings") */
  variant?: "settings" | "profile";
  /** Optional action button in header (e.g., Add button) */
  headerAction?: React.ReactNode;
  /** Initially collapsed state (default: false) */
  defaultCollapsed?: boolean;
  /** Enable collapsible behavior (default: false) */
  collapsible?: boolean;
  /** Optional className for the section container */
  className?: string;
  /** Title size override in px (default depends on variant: 16 for settings, 18 for profile) */
  titleSize?: 14 | 16 | 18;
  /** When true, expects multiple container children (default: false, auto-wraps in single container) */
  multiple?: boolean;
}

const VARIANT_STYLES = {
  settings: {
    titleSize: 14,
    titleColor: "text-text-1",
    gap: "gap-2",
  },
  profile: {
    titleSize: 16,
    titleColor: "text-primary-6",
    gap: "gap-2",
  },
} as const;

const Section: React.FC<SectionProps> = memo(
  ({
    title,
    children,
    variant = "settings",
    headerAction,
    defaultCollapsed = false,
    collapsible = false,
    className = "",
    titleSize,
    multiple = false,
  }) => {
    const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

    const styles = VARIANT_STYLES[variant];
    const resolvedTitleSize = titleSize ?? styles.titleSize;
    const titleClassName = `text-[${resolvedTitleSize}px] font-semibold leading-[22px] ${styles.titleColor}`;
    const hasHeader = title || headerAction;

    // Add margin-top for sections after the first one (sibling spacing)
    const spacingClass = "[&:not(:first-child)]:mt-3";

    return (
      <div
        className={`flex flex-col ${styles.gap} ${spacingClass} ${className}`}
      >
        {/* Section Header (optional) */}
        {hasHeader && (
          <div className="flex items-center justify-between pl-1">
            {collapsible && title ? (
              <button
                onClick={() => setIsCollapsed(!isCollapsed)}
                className={`flex flex-1 items-center gap-2 text-left ${titleClassName} transition-colors hover:text-text-2`}
              >
                {isCollapsed ? (
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    data-icon="chevron-right"
                    size={16}
                    strokeWidth={2}
                  />
                ) : (
                  <HugeiconsIcon
                    icon={ArrowDown01Icon}
                    data-icon="chevron-down"
                    size={16}
                    strokeWidth={2}
                  />
                )}
                <span>{title}</span>
              </button>
            ) : title ? (
              <div className={titleClassName}>{title}</div>
            ) : null}
            {headerAction && <div className="ml-2">{headerAction}</div>}
          </div>
        )}

        {/* Content */}
        {(!collapsible || !isCollapsed) &&
          (multiple ? (
            <div className="flex flex-col gap-3">{children}</div>
          ) : (
            <div
              className={`${SECTION_CONTAINER_CLASSES} ${SECTION_PADDING.none}`}
            >
              {children}
            </div>
          ))}
      </div>
    );
  }
);

Section.displayName = "Section";

export default Section;
