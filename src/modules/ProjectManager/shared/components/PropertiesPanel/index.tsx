/**
 * PropertiesPanel Component
 *
 * Reusable shell for any properties sidebar in Project Manager.
 * Provides: shared title header + scrollable property content.
 *
 * Usage:
 *   <PropertiesPanel title="Properties">
 *     <FieldRow ... />
 *     <FieldRow ... />
 *   </PropertiesPanel>
 *
 * Also exports ProjectPropertyFields for project-specific fields.
 */
import React, { useRef } from "react";
import { useTranslation } from "react-i18next";

import { HEADER_CLASSES } from "@src/config/workstation/tokens";
import {
  WorkstationTrailBody,
  WorkstationTrailHeader,
} from "@src/modules/shared/layouts/blocks";

// Re-export types for consumers
export type {
  Label,
  LinkedRepoOption,
  Person,
  Team,
  ProjectStatus,
  ProjectPriority,
  ProjectHealth,
  ProjectData,
  PropertiesPanelProps,
} from "./types";

// ============================================
// Shell Component
// ============================================

export interface PropertiesPanelShellProps {
  /** Header title. Pass empty string to hide the header. */
  title?: string;
  /** Extra class on the outer section */
  className?: string;
  /**
   * Ref attached to the outer <section>.
   * Used for click-outside detection by property field hooks.
   * If not provided, an internal ref is created.
   */
  containerRef?: React.RefObject<HTMLElement | null>;
  /** Hug the rendered property rows instead of stretching to the host height. */
  fitContent?: boolean;
  /** Controls aligned to the right side of the title row. */
  headerActions?: React.ReactNode;
  /** Match either the standard properties title or the Workstation trail. */
  headerVariant?: "section" | "workstation-trail";
  children?: React.ReactNode;
}

const PropertiesPanel: React.FC<PropertiesPanelShellProps> = ({
  title,
  className = "",
  containerRef: externalRef,
  fitContent = false,
  headerActions,
  headerVariant = "section",
  children,
}) => {
  const { t } = useTranslation("projects");
  const internalRef = useRef<HTMLElement | null>(null);
  const containerRef = externalRef ?? internalRef;
  const resolvedTitle = title ?? t("common:common.properties");
  const showHeader = resolvedTitle !== "";

  return (
    <section
      ref={containerRef}
      className={`flex flex-col ${fitContent ? "max-h-full" : "h-full"} ${className}`}
    >
      {showHeader && headerVariant === "workstation-trail" ? (
        <WorkstationTrailHeader title={resolvedTitle} actions={headerActions} />
      ) : showHeader ? (
        <div className={`${HEADER_CLASSES.sectionTitle} justify-between`}>
          <span className="text-[13px] font-medium text-text-1">
            {resolvedTitle}
          </span>
          {headerActions ? (
            <div className="flex shrink-0 items-center gap-px">
              {headerActions}
            </div>
          ) : null}
        </div>
      ) : null}
      <WorkstationTrailBody className={fitContent ? "" : "flex-1"}>
        <div
          className={`flex flex-col ${headerVariant === "workstation-trail" ? "" : "pb-2"}`}
        >
          {children}
        </div>
      </WorkstationTrailBody>
    </section>
  );
};

export default PropertiesPanel;
