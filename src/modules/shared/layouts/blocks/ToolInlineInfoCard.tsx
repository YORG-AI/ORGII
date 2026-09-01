import React, { useState } from "react";

import TabPill from "@src/components/TabPill";

import CollapsibleSection from "./CollapsibleSection";
import InlineInfoCard from "./InlineInfoCard";

export interface ToolInlineActionRow {
  name: string;
  summary: string;
}

export interface ToolInlineSectionConfig {
  title: string;
  content: React.ReactNode;
  defaultOpen?: boolean;
}

export interface ToolInlineCompactRow {
  key: string;
  label: React.ReactNode;
  value?: React.ReactNode;
  /** Extra flex weight for the label column (default 1). */
  labelFlex?: number;
}

type ToolInlineSectionLayout = "collapsible" | "tabs";

interface ToolInlineInfoCardProps {
  title: string;
  actionCountLabel: string;
  description: string;
  actions: ToolInlineActionRow[];
  agentSection?: ToolInlineSectionConfig;
  commandsTitle: string;
  commandsContent?: React.ReactNode;
  sectionLayout?: ToolInlineSectionLayout;
}

const SECTION_HEADER_CLASS = "min-h-7 py-0";
const SECTION_TITLE_BUTTON_CLASS = "text-xs font-medium text-primary-6";
const SECTION_TITLE_CLASS = "text-xs font-medium text-primary-6";

const ToolInlineInfoCard: React.FC<ToolInlineInfoCardProps> = ({
  title,
  actionCountLabel,
  description,
  actions,
  agentSection,
  commandsTitle,
  commandsContent,
  sectionLayout = "collapsible",
}) => {
  const hasDescription = description.trim() !== "";
  const hasCommands = actions.length > 0 || commandsContent != null;
  const sections = [
    ...(agentSection
      ? [
          {
            key: "agent",
            title: agentSection.title,
            content: agentSection.content,
            defaultOpen: agentSection.defaultOpen,
          },
        ]
      : []),
    ...(hasCommands
      ? [
          {
            key: "commands",
            title: commandsTitle,
            content: commandsContent ?? (
              <ToolInlineActionList actions={actions} />
            ),
            defaultOpen: false,
          },
        ]
      : []),
  ];
  const [activeSectionKey, setActiveSectionKey] = useState<string>(
    sections[0]?.key ?? ""
  );
  const effectiveActiveSectionKey = sections.some(
    (section) => section.key === activeSectionKey
  )
    ? activeSectionKey
    : (sections[0]?.key ?? "");
  const activeSection = sections.find(
    (section) => section.key === effectiveActiveSectionKey
  );

  return (
    <InlineInfoCard>
      <div className="flex flex-col gap-3">
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="truncate font-medium text-text-1">{title}</span>
          <span className="shrink-0 text-text-4">·</span>
          <span className="shrink-0 text-text-2">{actionCountLabel}</span>
        </div>

        {hasDescription && (
          <p className="text-xs leading-5 whitespace-pre-line text-text-2">
            {description}
          </p>
        )}

        {sections.length > 0 &&
          (sectionLayout === "tabs" ? (
            <div className="flex min-w-0 flex-col gap-2 border-t border-border-2 pt-2">
              <TabPill
                tabs={sections.map((section) => ({
                  key: section.key,
                  label: section.title,
                }))}
                activeTab={effectiveActiveSectionKey}
                onChange={setActiveSectionKey}
                variant="simple"
                fillWidth={false}
              />
              {activeSection && (
                <div className="min-w-0">{activeSection.content}</div>
              )}
            </div>
          ) : (
            sections.map((section) => (
              <div key={section.key} className="border-t border-border-2 pt-2">
                <CollapsibleSection
                  title={section.title}
                  defaultOpen={section.defaultOpen ?? true}
                  compact
                  headerRowClassName={SECTION_HEADER_CLASS}
                  titleButtonClassName={SECTION_TITLE_BUTTON_CLASS}
                  titleClassName={SECTION_TITLE_CLASS}
                  chevronSize={14}
                  chevronClassName="text-primary-6"
                >
                  <div className="ml-[14px] pl-1">{section.content}</div>
                </CollapsibleSection>
              </div>
            ))
          ))}
      </div>
    </InlineInfoCard>
  );
};

interface ToolInlineCompactRowsProps {
  rows: ToolInlineCompactRow[];
}

export const ToolInlineCompactRows: React.FC<ToolInlineCompactRowsProps> = ({
  rows,
}) => {
  if (rows.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      {rows.map((row) => {
        const labelFlex = row.labelFlex ?? 1;
        return (
          <div
            key={row.key}
            className="flex min-h-8 items-center justify-between gap-4 py-1 text-xs"
          >
            <div className="min-w-0" style={{ flex: `${labelFlex} 1 0%` }}>
              {row.label}
            </div>
            {row.value != null && (
              <div className="min-w-0 shrink-0">{row.value}</div>
            )}
          </div>
        );
      })}
    </div>
  );
};

interface ToolInlineActionListProps {
  actions: ToolInlineActionRow[];
}

export const ToolInlineActionList: React.FC<ToolInlineActionListProps> = ({
  actions,
}) => {
  const rows = actions.map((action) => ({
    key: action.name,
    label: <span className="font-medium text-text-1">{action.name}</span>,
    value: (
      <span className="block max-w-[520px] text-right leading-5 whitespace-normal text-text-2">
        {action.summary}
      </span>
    ),
  }));

  return <ToolInlineCompactRows rows={rows} />;
};

export default ToolInlineInfoCard;
