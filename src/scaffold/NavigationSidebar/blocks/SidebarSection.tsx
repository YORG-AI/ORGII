/**
 * SidebarSection
 *
 * Container for sidebar content with consistent padding.
 * Supports optional headers (text-only or icon + text).
 *
 * @example
 * // Text header (like "Buy" / "Sell")
 * <SidebarSection title="Buy">
 *   <NavigationMenu ... />
 * </SidebarSection>
 *
 * // Icon + text header (for tool pages)
 * <SidebarSection title="Terminal" icon={Terminal}>
 *   <SidebarGroup ... />
 * </SidebarSection>
 *
 * // Back navigation header
 * <SidebarSection title="Market" variant="back" onBack={handleBack}>
 *   <NavigationMenu ... />
 * </SidebarSection>
 *
 * // No header
 * <SidebarSection>
 *   <SidebarGroup ... />
 * </SidebarSection>
 */
import React from "react";

import { ArrowLeft01Icon, HugeiconsIcon } from "@src/icons";

import type { SidebarSectionProps } from "../types";
import { renderSidebarIcon } from "../utils/renderIcon";

// ============================================
// Component
// ============================================

const SidebarSection: React.FC<SidebarSectionProps> = ({
  title,
  variant = "text",
  icon,
  onBack,
  children,
  className = "",
}) => {
  // Render header based on variant
  const renderHeader = () => {
    if (!title) return null;

    // Inner content class - h-7 (28px) for the actual content
    const contentClass =
      "flex h-7 items-center gap-3 text-[13px] font-bold text-text-1";

    const renderContent = () => {
      if (variant === "back") {
        return (
          <div className={contentClass}>
            <button
              onClick={onBack}
              className="flex items-center justify-center text-text-1"
              aria-label="Go back"
            >
              <HugeiconsIcon
                icon={ArrowLeft01Icon}
                data-icon="chevron-left"
                className="h-[14px] w-[14px]"
                strokeWidth={2}
              />
            </button>
            <span>{title}</span>
          </div>
        );
      }

      if (variant === "icon" && icon) {
        return (
          <div className={contentClass}>
            {renderSidebarIcon(icon, { className: "text-text-1" })}
            <span>{title}</span>
          </div>
        );
      }

      // Default text variant
      return (
        <div className={contentClass}>
          <span>{title}</span>
        </div>
      );
    };

    // Outer container - h-9 with bottom alignment, like other sidebar headers
    return <div className="flex h-9 items-end px-5">{renderContent()}</div>;
  };

  return (
    <div className={`sidebar-section ${className}`}>
      {renderHeader()}
      <div className="sidebar-section-content">{children}</div>
    </div>
  );
};

export default SidebarSection;
