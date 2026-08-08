import {
  ArrowUp,
  CheckCircle2,
  Circle,
  Inbox,
  LayoutGrid,
  ListTodo,
  PanelRight,
  Plus,
} from "lucide-react";
import React, { memo, useState } from "react";
import { useTranslation } from "react-i18next";

import AppLogo from "@src/components/AppLogo";
import Avatar from "@src/components/Avatar";
import Button from "@src/components/Button";
import ComposerShell from "@src/components/ComposerShell";
import IconButton from "@src/components/IconButton";
import Tooltip from "@src/components/Tooltip";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";

import { SETUP_APPLICATION_PREVIEW_TOKENS } from "../layoutTokens";

const PREVIEW_SECTION = {
  SDE: "sde",
  TEAM_INBOX: "team-inbox",
  WORK_ITEMS: "work-items",
} as const;

type PreviewSection = (typeof PREVIEW_SECTION)[keyof typeof PREVIEW_SECTION];

interface PreviewNavigationButtonProps {
  icon: React.ReactNode;
  label: string;
  section: PreviewSection;
  selected: boolean;
  onSelect: (section: PreviewSection) => void;
}

const PreviewNavigationButton: React.FC<PreviewNavigationButtonProps> = ({
  icon,
  label,
  section,
  selected,
  onSelect,
}) => (
  <Tooltip
    content={label}
    position="right"
    mouseEnterDelay={120}
    framedPanel
    showArrow={false}
  >
    <Button
      id={`setup-preview-tab-${section}`}
      variant="tertiary"
      appearance="ghost"
      size="mini"
      shape="circle"
      iconOnly
      icon={icon}
      role="tab"
      aria-label={label}
      aria-selected={selected}
      aria-controls={`setup-preview-panel-${section}`}
      data-testid={`setup-preview-tab-${section}`}
      className={
        selected
          ? SETUP_APPLICATION_PREVIEW_TOKENS.navigationButtonSelected
          : SETUP_APPLICATION_PREVIEW_TOKENS.navigationButton
      }
      onClick={() => onSelect(section)}
    />
  </Tooltip>
);

interface PreviewSummaryRowProps {
  icon: React.ReactNode;
  label: string;
  meta: string;
}

const PreviewSummaryRow: React.FC<PreviewSummaryRowProps> = ({
  icon,
  label,
  meta,
}) => (
  <div className={SETUP_APPLICATION_PREVIEW_TOKENS.summaryRow}>
    {icon}
    <span className={SETUP_APPLICATION_PREVIEW_TOKENS.summaryRowText}>
      <strong>{label}</strong>
      <span>{meta}</span>
    </span>
  </div>
);

interface PreviewPanelProps {
  section: PreviewSection;
  children: React.ReactNode;
  testId: string;
}

const PreviewPanel: React.FC<PreviewPanelProps> = ({
  section,
  children,
  testId,
}) => (
  <div
    id={`setup-preview-panel-${section}`}
    role="tabpanel"
    aria-labelledby={`setup-preview-tab-${section}`}
    className={SETUP_APPLICATION_PREVIEW_TOKENS.workspacePanel}
    data-testid={testId}
  >
    {children}
  </div>
);

/**
 * Small interactive product preview composed from shared application
 * primitives. Its selected section is component-local preview intent: it
 * never navigates, persists settings, or mutates product data.
 */
const SetupApplicationPreview: React.FC = memo(() => {
  const { t } = useTranslation(["navigation", "common"]);
  const [activeSection, setActiveSection] = useState<PreviewSection>(
    PREVIEW_SECTION.SDE
  );
  const [fileContentOpen, setFileContentOpen] = useState(false);

  const sdeLabel = t("navigation:workstation.agentComputer.agents.sde", {
    defaultValue: "SDE Agent",
  });
  const teamInboxLabel = t("navigation:labels.teamInbox", {
    defaultValue: "Team Inbox",
  });
  const workItemsLabel = t("navigation:labels.workItems", {
    defaultValue: "Work Items",
  });
  const filesToggleLabel = fileContentOpen
    ? t("common:actions.hide", { defaultValue: "Hide file content" })
    : t("common:actions.show", { defaultValue: "Show file content" });

  return (
    <div
      className={SETUP_APPLICATION_PREVIEW_TOKENS.root}
      data-testid="setup-application-preview"
    >
      <header className={SETUP_APPLICATION_PREVIEW_TOKENS.windowBar}>
        <span
          className={SETUP_APPLICATION_PREVIEW_TOKENS.windowDot}
          aria-hidden
        />
        <span
          className={SETUP_APPLICATION_PREVIEW_TOKENS.windowDot}
          aria-hidden
        />
        <span
          className={SETUP_APPLICATION_PREVIEW_TOKENS.windowDot}
          aria-hidden
        />
        <span className={SETUP_APPLICATION_PREVIEW_TOKENS.windowTitle}>
          ORGII
        </span>
        <Tooltip
          content={filesToggleLabel}
          position="left"
          mouseEnterDelay={120}
          framedPanel
          showArrow={false}
        >
          <IconButton
            size="sm"
            aria-label={filesToggleLabel}
            aria-expanded={fileContentOpen}
            aria-controls="setup-preview-code-panel"
            className={SETUP_APPLICATION_PREVIEW_TOKENS.filesToggle}
            data-testid="setup-preview-files-toggle"
            onClick={() => setFileContentOpen((current) => !current)}
          >
            <PanelRight size={HEADER_ICON_SIZE.sm} strokeWidth={2} />
          </IconButton>
        </Tooltip>
      </header>

      <div className={SETUP_APPLICATION_PREVIEW_TOKENS.body}>
        <aside className={SETUP_APPLICATION_PREVIEW_TOKENS.navigation}>
          <div className={SETUP_APPLICATION_PREVIEW_TOKENS.navigationBrand}>
            <AppLogo size={HEADER_ICON_SIZE.md} className="rounded-md" alt="" />
          </div>

          <nav
            className={SETUP_APPLICATION_PREVIEW_TOKENS.navigationList}
            role="tablist"
            aria-label={t("navigation:routes.launchpad", {
              defaultValue: "Product preview",
            })}
          >
            <PreviewNavigationButton
              icon={<LayoutGrid size={HEADER_ICON_SIZE.sm} />}
              label={sdeLabel}
              section={PREVIEW_SECTION.SDE}
              selected={activeSection === PREVIEW_SECTION.SDE}
              onSelect={setActiveSection}
            />
            <PreviewNavigationButton
              icon={<Inbox size={HEADER_ICON_SIZE.sm} />}
              label={teamInboxLabel}
              section={PREVIEW_SECTION.TEAM_INBOX}
              selected={activeSection === PREVIEW_SECTION.TEAM_INBOX}
              onSelect={setActiveSection}
            />
            <PreviewNavigationButton
              icon={<ListTodo size={HEADER_ICON_SIZE.sm} />}
              label={workItemsLabel}
              section={PREVIEW_SECTION.WORK_ITEMS}
              selected={activeSection === PREVIEW_SECTION.WORK_ITEMS}
              onSelect={setActiveSection}
            />
          </nav>
        </aside>

        <div
          className={
            fileContentOpen
              ? SETUP_APPLICATION_PREVIEW_TOKENS.contentAreaSplit
              : SETUP_APPLICATION_PREVIEW_TOKENS.contentArea
          }
          data-testid="setup-preview-content-area"
        >
          <main
            className={SETUP_APPLICATION_PREVIEW_TOKENS.workspace}
            data-testid="setup-preview-workspace"
          >
            {activeSection === PREVIEW_SECTION.SDE && (
              <PreviewPanel
                section={PREVIEW_SECTION.SDE}
                testId="setup-preview-panel-sde"
              >
                <strong
                  className={SETUP_APPLICATION_PREVIEW_TOKENS.agentHeading}
                >
                  {sdeLabel}
                </strong>

                <ComposerShell
                  variant="embedded"
                  className={SETUP_APPLICATION_PREVIEW_TOKENS.composer}
                  data-testid="setup-preview-composer"
                >
                  <span
                    className={SETUP_APPLICATION_PREVIEW_TOKENS.composerPrompt}
                  >
                    {t("navigation:labels.startSession", {
                      defaultValue: "Start a session",
                    })}
                  </span>
                  <div className={SETUP_APPLICATION_PREVIEW_TOKENS.composerBar}>
                    <IconButton
                      size="sm"
                      tabIndex={-1}
                      aria-label={t("navigation:sidebar.actions.addNew", {
                        defaultValue: "Add",
                      })}
                    >
                      <Plus size={HEADER_ICON_SIZE.sm} />
                    </IconButton>
                    <Button
                      variant="primary"
                      size="mini"
                      shape="circle"
                      iconOnly
                      icon={<ArrowUp size={HEADER_ICON_SIZE.sm} />}
                      tabIndex={-1}
                      aria-label={t("navigation:labels.startSession", {
                        defaultValue: "Start a session",
                      })}
                      data-testid="setup-preview-submit"
                    />
                  </div>
                </ComposerShell>
              </PreviewPanel>
            )}

            {activeSection === PREVIEW_SECTION.TEAM_INBOX && (
              <PreviewPanel
                section={PREVIEW_SECTION.TEAM_INBOX}
                testId="setup-preview-panel-team-inbox"
              >
                <div
                  className={SETUP_APPLICATION_PREVIEW_TOKENS.summaryHeading}
                >
                  <Avatar size={28}>
                    <Inbox size={HEADER_ICON_SIZE.sm} />
                  </Avatar>
                  <strong>{teamInboxLabel}</strong>
                </div>
                <div className={SETUP_APPLICATION_PREVIEW_TOKENS.summaryList}>
                  <PreviewSummaryRow
                    icon={<Avatar size={24}>A</Avatar>}
                    label={t("navigation:sidebar.guide.inviteTeammate", {
                      defaultValue: "Invite a teammate",
                    })}
                    meta={t("common:status.pending", {
                      defaultValue: "Pending",
                    })}
                  />
                  <PreviewSummaryRow
                    icon={<Avatar size={24}>O</Avatar>}
                    label={t("navigation:sidebar.guide.viewTeamActivity", {
                      defaultValue: "View team activity",
                    })}
                    meta={t("common:status.completed", {
                      defaultValue: "Completed",
                    })}
                  />
                </div>
              </PreviewPanel>
            )}

            {activeSection === PREVIEW_SECTION.WORK_ITEMS && (
              <PreviewPanel
                section={PREVIEW_SECTION.WORK_ITEMS}
                testId="setup-preview-panel-work-items"
              >
                <div
                  className={SETUP_APPLICATION_PREVIEW_TOKENS.summaryHeading}
                >
                  <Avatar size={28}>
                    <ListTodo size={HEADER_ICON_SIZE.sm} />
                  </Avatar>
                  <strong>{workItemsLabel}</strong>
                </div>
                <div className={SETUP_APPLICATION_PREVIEW_TOKENS.summaryList}>
                  <PreviewSummaryRow
                    icon={
                      <Circle
                        size={HEADER_ICON_SIZE.md}
                        className="shrink-0 text-primary-6"
                      />
                    }
                    label={t("common:status.inProgress", {
                      defaultValue: "In progress",
                    })}
                    meta={sdeLabel}
                  />
                  <PreviewSummaryRow
                    icon={
                      <CheckCircle2
                        size={HEADER_ICON_SIZE.md}
                        className="shrink-0 text-success-6"
                      />
                    }
                    label={t("common:status.completed", {
                      defaultValue: "Completed",
                    })}
                    meta={workItemsLabel}
                  />
                </div>
              </PreviewPanel>
            )}
          </main>

          {fileContentOpen && (
            <aside
              id="setup-preview-code-panel"
              className={SETUP_APPLICATION_PREVIEW_TOKENS.codePanel}
              aria-label={filesToggleLabel}
              data-testid="setup-preview-code-panel"
            >
              <div
                className={SETUP_APPLICATION_PREVIEW_TOKENS.codeEditor}
                data-testid="setup-preview-code-editor"
              >
                <div className={SETUP_APPLICATION_PREVIEW_TOKENS.codeLine}>
                  <span>1</span>
                  <code className="text-primary-6">from app import Agent</code>
                </div>
                <div className={SETUP_APPLICATION_PREVIEW_TOKENS.codeLine}>
                  <span>2</span>
                  <code />
                </div>
                <div className={SETUP_APPLICATION_PREVIEW_TOKENS.codeLine}>
                  <span>3</span>
                  <code className="text-primary-6">
                    {'agent = Agent("SDE")'}
                  </code>
                </div>
                <div className={SETUP_APPLICATION_PREVIEW_TOKENS.codeLine}>
                  <span>4</span>
                  <code>{'agent.open("Main")'}</code>
                </div>
                <div className={SETUP_APPLICATION_PREVIEW_TOKENS.codeLine}>
                  <span>5</span>
                  <code>agent.start()</code>
                </div>
                <div className={SETUP_APPLICATION_PREVIEW_TOKENS.codeLine}>
                  <span>6</span>
                  <code>{'agent.run("build")'}</code>
                </div>
                <div className={SETUP_APPLICATION_PREVIEW_TOKENS.codeLine}>
                  <span>7</span>
                  <code />
                </div>
                <div className={SETUP_APPLICATION_PREVIEW_TOKENS.codeLine}>
                  <span>8</span>
                  <code className="text-success-6">{'print("Ready")'}</code>
                </div>
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
});

SetupApplicationPreview.displayName = "SetupApplicationPreview";

export default SetupApplicationPreview;
