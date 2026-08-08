import {
  Boxes,
  BriefcaseBusiness,
  Building2,
  Check,
  Clipboard,
  Cloud,
  Eye,
  FolderGit2,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Link2,
  ListChecks,
  MessageSquare,
  MonitorCog,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  User,
  Users,
} from "lucide-react";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import { TYPOGRAPHY } from "@src/config/workstation/tokens";
import { openOrg2CloudSignIn } from "@src/features/Org2Cloud/useOrg2CloudSignIn";
import { useAppearanceState } from "@src/modules/MainApp/Settings/sections/useAppearanceState";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_CONTROL_STYLE,
  SECTION_PATH_TEXT_CLASSES,
  SECTION_VALUE_SMALL_SECONDARY_CLASSES,
  SECTION_VALUE_TEXT_CLASSES,
  SECTION_VALUE_TEXT_SUCCESS_CLASSES,
  SectionContainer,
  SectionDescription,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { DETAIL_PANEL_TOKENS } from "@src/modules/shared/layouts/blocks";
import { openWorkspaceSpotlight } from "@src/scaffold/GlobalSpotlight/openSpotlight";
import { TUTORIALS } from "@src/scaffold/Tutorials/tutorialRegistry";
import {
  SelectionGrid,
  type SelectionGridOption,
  WizardStepContent,
} from "@src/scaffold/WizardSystem/primitives";

import {
  BasicsStepIcon,
  GoalStepIcon,
  OrganizationStepIcon,
  ReadyStepIcon,
  SharingStepIcon,
  ToolsStepIcon,
  TutorialStepIcon,
  WorkModelStepIcon,
} from "../components/SetupStepIcons";
import { SETUP_WALKTHROUGH_LAYOUT_TOKENS } from "../layoutTokens";
import type { SetupWalkthroughController } from "../useSetupWalkthroughController";

type StepProps = { controller: SetupWalkthroughController };

const CONTROL_STYLE = { width: "100%", maxWidth: "100%" } as const;

export const GoalStep: React.FC<StepProps> = ({ controller }) => {
  const { t } = useTranslation("onboarding");
  const options = useMemo<
    SelectionGridOption<NonNullable<typeof controller.progress.goal>>[]
  >(
    () => [
      {
        key: "personal",
        label: t("readiness.goal.personal.title"),
        description: t("readiness.goal.personal.description"),
        icon: User,
        dataTestId: "setup-goal-personal",
      },
      {
        key: "team_activity",
        label: t("readiness.goal.team.title"),
        description: t("readiness.goal.team.description"),
        icon: Users,
        dataTestId: "setup-goal-team",
      },
      {
        key: "work_management",
        label: t("readiness.goal.work.title"),
        description: t("readiness.goal.work.description"),
        icon: BriefcaseBusiness,
        dataTestId: "setup-goal-work",
      },
    ],
    [t]
  );
  return (
    <WizardStepContent
      title={t("readiness.goal.title")}
      description={t("readiness.goal.description")}
      icon={GoalStepIcon}
    >
      <SelectionGrid
        options={options}
        selected={controller.progress.goal}
        onSelect={controller.selectGoal}
        columns={1}
        cardLayout="inline"
        showSelectionCheck={false}
        className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.choiceGrid}
      />
      <InlineAlert type="info">{t("readiness.goal.hint")}</InlineAlert>
    </WizardStepContent>
  );
};

const TOOL_LABELS: Record<string, string> = {
  codex: "Codex",
  claude_code: "Claude Code",
  cursor_cli: "Cursor",
};

export const ToolsStep: React.FC<StepProps> = ({ controller }) => {
  const { t } = useTranslation("onboarding");
  const byType = new Map(
    controller.progress.tools.map((tool) => [tool.agentType, tool])
  );
  const isDetecting = controller.activeOperation === "detect-tools";
  const isImporting = controller.activeOperation === "import-history";
  return (
    <WizardStepContent
      title={t("readiness.tools.title")}
      description={t("readiness.tools.description")}
      icon={ToolsStepIcon}
    >
      <SectionContainer>
        {["codex", "claude_code", "cursor_cli"].map((agentType) => {
          const tool = byType.get(
            agentType as "codex" | "claude_code" | "cursor_cli"
          );
          return (
            <SectionRow
              key={agentType}
              label={TOOL_LABELS[agentType]}
              description={t("readiness.tools.detectedDescription")}
            >
              <span
                className={
                  tool?.found
                    ? `inline-flex items-center gap-1.5 ${SECTION_VALUE_TEXT_SUCCESS_CLASSES}`
                    : SECTION_VALUE_TEXT_CLASSES
                }
              >
                {tool?.found && <Check size={14} />}
                {tool
                  ? tool.found
                    ? t("readiness.tools.found", {
                        count: tool.keyCount,
                        validated: tool.validatedCount,
                      })
                    : t("readiness.tools.notFound")
                  : t("readiness.tools.notScanned")}
              </span>
            </SectionRow>
          );
        })}
      </SectionContainer>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          icon={<KeyRound size={15} />}
          loading={isDetecting}
          disabled={controller.activeOperation !== null && !isDetecting}
          onClick={() => void controller.actions.detectTools()}
          data-testid="setup-detect-tools"
        >
          {t("readiness.tools.detect")}
        </Button>
        <Button
          icon={<RefreshCw size={15} />}
          loading={isImporting}
          disabled={controller.activeOperation !== null && !isImporting}
          onClick={() => void controller.actions.importHistory()}
          data-testid="setup-import-codex-history"
        >
          {t("readiness.tools.importHistory")}
        </Button>
      </div>
      {controller.progress.historySessionCount !== null && (
        <InlineAlert type="success" role="status">
          {t("readiness.tools.historyImported", {
            count: controller.progress.historySessionCount,
          })}
        </InlineAlert>
      )}
      <SectionDescription>{t("readiness.tools.privacy")}</SectionDescription>
    </WizardStepContent>
  );
};

export const OrganizationStep: React.FC<StepProps> = ({ controller }) => {
  const { t } = useTranslation("onboarding");
  const [mode, setMode] = useState<"create" | "join">("create");
  const [orgName, setOrgName] = useState("");
  const [invite, setInvite] = useState("");
  const openSignIn = React.useCallback(() => {
    controller.setOperationError(null);
    void openOrg2CloudSignIn().catch((error: unknown) => {
      controller.setOperationError(
        error instanceof Error ? error.message : String(error)
      );
    });
  }, [controller]);
  const orgOptions = controller.cloudOrgs.map((org) => ({
    key: org.orgId,
    label: org.name,
    description: t("readiness.organization.role", {
      role: t(`readiness.organization.roles.${org.role.toLowerCase()}`, {
        defaultValue: org.role,
      }),
    }),
    icon: Building2,
  }));
  const selected = controller.progress.selectedOrgId;
  return (
    <WizardStepContent
      title={t("readiness.organization.title")}
      description={t("readiness.organization.description")}
      icon={OrganizationStepIcon}
    >
      {!controller.cloudAuth ? (
        <InlineAlert
          type="info"
          action={
            <Button
              variant="primary"
              icon={<Cloud size={15} />}
              onClick={openSignIn}
              data-testid="setup-cloud-sign-in"
            >
              {t("readiness.organization.signIn")}
            </Button>
          }
        >
          {t("readiness.organization.signInHint")}
        </InlineAlert>
      ) : (
        <>
          {orgOptions.length > 0 && (
            <SectionContainer>
              <SectionRow
                label={t("readiness.organization.existing")}
                layout="vertical"
              >
                <SelectionGrid
                  options={orgOptions}
                  selected={selected}
                  onSelect={(orgId) => {
                    const org = controller.cloudOrgs.find(
                      (item) => item.orgId === orgId
                    );
                    if (org) controller.selectOrganization(org);
                  }}
                  columns={2}
                  cardVariant="subtle"
                  compactCards
                  className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.choiceGrid}
                />
              </SectionRow>
            </SectionContainer>
          )}
          <SectionContainer>
            <SectionRow
              label={t("readiness.organization.mode")}
              layout="vertical"
            >
              <SelectionGrid
                options={[
                  {
                    key: "create",
                    label: t("readiness.organization.create"),
                    icon: Plus,
                  },
                  {
                    key: "join",
                    label: t("readiness.organization.join"),
                    icon: Link2,
                  },
                ]}
                selected={mode}
                onSelect={setMode}
                columns={2}
                compactCards
                className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.choiceGrid}
              />
            </SectionRow>
            <SectionRow
              label={
                mode === "create"
                  ? t("readiness.organization.orgName")
                  : t("readiness.organization.invite")
              }
              layout="vertical"
              required
            >
              <div className="flex gap-2">
                <Input
                  value={mode === "create" ? orgName : invite}
                  onChange={mode === "create" ? setOrgName : setInvite}
                  placeholder={
                    mode === "create"
                      ? t("readiness.organization.orgNamePlaceholder")
                      : t("readiness.organization.invitePlaceholder")
                  }
                  style={CONTROL_STYLE}
                  data-testid={
                    mode === "create"
                      ? "setup-cloud-org-name"
                      : "setup-cloud-org-invite"
                  }
                  aria-label={
                    mode === "create"
                      ? t("readiness.organization.orgName")
                      : t("readiness.organization.invite")
                  }
                />
                <Button
                  variant="primary"
                  loading={
                    controller.activeOperation ===
                    (mode === "create" ? "create-org" : "join-org")
                  }
                  disabled={
                    controller.activeOperation !== null ||
                    (mode === "create" ? !orgName.trim() : !invite.trim())
                  }
                  onClick={() =>
                    void (mode === "create"
                      ? controller.actions.createOrganization(orgName)
                      : controller.actions.joinOrganization(invite))
                  }
                  data-testid="setup-cloud-org-submit"
                >
                  {mode === "create"
                    ? t("readiness.organization.create")
                    : t("readiness.organization.join")}
                </Button>
              </div>
            </SectionRow>
          </SectionContainer>
        </>
      )}
      {selected && (
        <InlineAlert type="success" role="status">
          {t("readiness.organization.selected", {
            org: controller.progress.selectedOrgName,
          })}
        </InlineAlert>
      )}
    </WizardStepContent>
  );
};

export const SharingStep: React.FC<StepProps> = ({ controller }) => {
  const { t } = useTranslation("onboarding");
  const isMember = controller.progress.selectedOrgRole === "member";
  const isSaved = controller.progress.verifiedAt !== null;
  return (
    <WizardStepContent
      title={t("readiness.sharing.title")}
      description={t("readiness.sharing.description")}
      icon={SharingStepIcon}
    >
      <SectionContainer>
        <SectionRow
          label={t("readiness.sharing.workspace")}
          description={t("readiness.sharing.workspaceDescription")}
        >
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className={`max-w-64 truncate ${SECTION_VALUE_TEXT_CLASSES}`}>
              {controller.workspaceFolders.length
                ? controller.workspaceFolders
                    .map((folder) => folder.name)
                    .join(", ")
                : t("readiness.sharing.noWorkspace")}
            </span>
            <Button
              size="small"
              icon={<FolderGit2 size={14} />}
              onClick={() => openWorkspaceSpotlight("open")}
            >
              {t("readiness.sharing.openWorkspace")}
            </Button>
          </div>
        </SectionRow>
        {!isMember && (
          <>
            <SectionRow
              label={t("readiness.sharing.repoScope")}
              description={t("readiness.sharing.repoScopeDescription")}
            >
              <Button
                size="small"
                loading={controller.activeOperation === "resolve-scopes"}
                disabled={
                  controller.activeOperation !== null &&
                  controller.activeOperation !== "resolve-scopes"
                }
                onClick={() => void controller.actions.resolveWorkspaceScopes()}
                data-testid="setup-resolve-repo-scope"
              >
                {t("readiness.sharing.detectScope")}
              </Button>
            </SectionRow>
            {controller.progress.repoScopes.map((scope) => (
              <SectionRow key={scope} label={t("readiness.sharing.remote")}>
                <code className={SECTION_PATH_TEXT_CLASSES}>{scope}</code>
              </SectionRow>
            ))}
            <SectionRow
              label={t("readiness.sharing.level")}
              description={t("readiness.sharing.levelDescription")}
            >
              <Select
                value={controller.progress.sharingFloor}
                onChange={(value) =>
                  controller.patchProgress({
                    sharingFloor:
                      value as typeof controller.progress.sharingFloor,
                    verifiedAt: null,
                  })
                }
                options={[
                  {
                    value: "off",
                    label: t("readiness.sharing.off"),
                  },
                  {
                    value: "metadata_only",
                    label: t("readiness.sharing.metadata"),
                  },
                  {
                    value: "full_replay",
                    label: t("readiness.sharing.replay"),
                  },
                ]}
                style={SECTION_CONTROL_STYLE}
              />
            </SectionRow>
          </>
        )}
      </SectionContainer>
      {isMember ? (
        <>
          <InlineAlert type="info">
            {t("readiness.sharing.memberHint", {
              org: controller.progress.selectedOrgName,
            })}
          </InlineAlert>
          <Button
            variant="primary"
            icon={<RefreshCw size={15} />}
            loading={controller.activeOperation === "verify-sync"}
            disabled={controller.activeOperation !== null}
            onClick={() => void controller.actions.verifySync()}
            data-testid="setup-verify-member-sync"
          >
            {t("readiness.sharing.verifyMember")}
          </Button>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            icon={<ShieldCheck size={15} />}
            loading={controller.activeOperation === "save-policy"}
            disabled={
              controller.progress.repoScopes.length === 0 ||
              controller.activeOperation !== null
            }
            onClick={() => void controller.actions.saveTeamPolicy()}
            data-testid="setup-save-team-policy"
          >
            {t("readiness.sharing.save")}
          </Button>
          <Button
            icon={<Link2 size={15} />}
            loading={controller.activeOperation === "create-invite"}
            disabled={!isSaved || controller.activeOperation !== null}
            onClick={() => void controller.actions.createInvite()}
            data-testid="setup-create-team-invite"
          >
            {t("readiness.sharing.createInvite")}
          </Button>
        </div>
      )}
      {controller.progress.inviteLink && (
        <SectionContainer>
          <SectionRow label={t("readiness.organization.invite")}>
            <div className={SECTION_ACTION_GAP_CLASSES}>
              <code className={SECTION_PATH_TEXT_CLASSES}>
                {controller.progress.inviteLink}
              </code>
              <Button
                size="small"
                icon={<Clipboard size={14} />}
                onClick={() =>
                  void navigator.clipboard.writeText(
                    controller.progress.inviteLink ?? ""
                  )
                }
              >
                {t("readiness.sharing.copy")}
              </Button>
            </div>
          </SectionRow>
        </SectionContainer>
      )}
      {isSaved && (
        <InlineAlert type="success" role="status">
          {t(
            isMember
              ? "readiness.sharing.memberVerified"
              : "readiness.sharing.verified"
          )}
        </InlineAlert>
      )}
    </WizardStepContent>
  );
};

export const BasicsStep: React.FC<StepProps> = ({ controller }) => {
  const { t } = useTranslation(["onboarding", "settings"]);
  const {
    appearanceMode,
    appearanceModeOptions,
    globalThemeId,
    themeOptions,
    handleAppearanceModeChange,
    handleThemeChange,
  } = useAppearanceState();
  return (
    <WizardStepContent
      title={t("onboarding:readiness.basics.title")}
      description={t("onboarding:readiness.basics.description")}
      icon={BasicsStepIcon}
    >
      <SectionContainer>
        <SectionRow label={t("settings:general.appearanceMode")}>
          <Select
            value={appearanceMode}
            onChange={handleAppearanceModeChange}
            options={appearanceModeOptions}
            style={SECTION_CONTROL_STYLE}
          />
        </SectionRow>
        <SectionRow label={t("settings:general.themePreset")}>
          <Select
            value={globalThemeId}
            onChange={(value) => handleThemeChange(String(value))}
            options={themeOptions}
            showSearch
            style={SECTION_CONTROL_STYLE}
          />
        </SectionRow>
        <SectionRow
          label={t("onboarding:readiness.basics.workspace")}
          description={t("onboarding:readiness.basics.workspaceDescription")}
        >
          <Button
            size="small"
            icon={<FolderGit2 size={14} />}
            onClick={() => openWorkspaceSpotlight("open")}
          >
            {controller.workspaceFolders.length
              ? t("onboarding:readiness.basics.changeWorkspace")
              : t("onboarding:readiness.basics.openWorkspace")}
          </Button>
        </SectionRow>
      </SectionContainer>
      <InlineAlert type="info">
        {t("onboarding:readiness.basics.settingsHint")}
      </InlineAlert>
    </WizardStepContent>
  );
};

export const TutorialStep: React.FC<StepProps> = ({ controller }) => {
  const { t } = useTranslation("onboarding");
  const options = TUTORIALS.map((tutorial) => ({
    key: tutorial.id,
    label: t(tutorial.titleKey),
    description: `${t(tutorial.descriptionKey)} · ${t(tutorial.durationKey)}`,
    icon: tutorial.id === "general-layout" ? LayoutDashboard : MonitorCog,
  }));
  return (
    <WizardStepContent
      title={t("readiness.tutorial.title")}
      description={t("readiness.tutorial.description")}
      icon={TutorialStepIcon}
    >
      <SelectionGrid
        options={options}
        selected={controller.progress.tutorialId}
        onSelect={(tutorialId) => controller.patchProgress({ tutorialId })}
        columns={2}
        className={SETUP_WALKTHROUGH_LAYOUT_TOKENS.choiceGrid}
      />
      <InlineAlert type="info">{t("readiness.tutorial.hint")}</InlineAlert>
    </WizardStepContent>
  );
};

const MODEL_ITEMS = [
  { key: "project", icon: Boxes },
  { key: "workItem", icon: ListChecks },
  { key: "session", icon: MessageSquare },
  { key: "workspace", icon: FolderGit2 },
] as const;

export const WorkModelStep: React.FC<StepProps> = () => {
  const { t } = useTranslation("onboarding");
  return (
    <WizardStepContent
      title={t("readiness.model.title")}
      description={t("readiness.model.description")}
      icon={WorkModelStepIcon}
    >
      <SectionContainer>
        {MODEL_ITEMS.map(({ key, icon: Icon }) => (
          <SectionRow key={key} showHeader={false}>
            <div className="flex w-full min-w-0 items-start gap-3">
              <span className="flex size-7 flex-shrink-0 items-center justify-center rounded-lg bg-fill-2 text-text-2">
                <Icon size={15} />
              </span>
              <div className="min-w-0">
                <div className={`${TYPOGRAPHY.contentTitle} text-text-1`}>
                  {t(`readiness.model.${key}.title`)}
                </div>
                <SectionDescription>
                  {t(`readiness.model.${key}.description`)}
                </SectionDescription>
              </div>
            </div>
          </SectionRow>
        ))}
      </SectionContainer>
      <InlineAlert
        type="info"
        icon={<FolderGit2 size={14} className="flex-shrink-0" />}
      >
        {t("readiness.model.relationship")}
      </InlineAlert>
    </WizardStepContent>
  );
};

export const ReadyStep: React.FC<StepProps> = ({ controller }) => {
  const { t } = useTranslation("onboarding");
  const team = controller.progress.goal === "team_activity";
  const destination =
    controller.progress.goal === "work_management"
      ? t("readiness.ready.workDestination")
      : team
        ? t("readiness.ready.teamDestination")
        : t("readiness.ready.personalDestination");
  const DestinationIcon =
    controller.progress.goal === "team_activity"
      ? Inbox
      : controller.progress.goal === "work_management"
        ? BriefcaseBusiness
        : Play;
  const readinessItems = [
    {
      key: "tools",
      icon: KeyRound,
      label: controller.progress.tools.some((tool) => tool.found)
        ? t("readiness.ready.toolsReady")
        : t("readiness.ready.toolsLater"),
    },
    {
      key: "workspace",
      icon: FolderGit2,
      label: controller.workspaceFolders.length
        ? t("readiness.ready.workspaceReady")
        : t("readiness.ready.workspaceLater"),
    },
    ...(team
      ? [
          {
            key: "organization",
            icon: Building2,
            label: controller.progress.selectedOrgName ?? "",
          },
          {
            key: "visibility",
            icon: Eye,
            label: t(
              controller.progress.selectedOrgRole === "member"
                ? "readiness.ready.memberSyncReady"
                : "readiness.ready.teamPolicyReady"
            ),
          },
        ]
      : []),
  ];
  return (
    <WizardStepContent
      title={t("readiness.ready.title")}
      description={t("readiness.ready.description")}
      icon={ReadyStepIcon}
    >
      <SectionContainer>
        {readinessItems.map(({ key, icon: Icon, label }) => (
          <SectionRow key={key} showHeader={false}>
            <div className="flex w-full min-w-0 items-center gap-2.5">
              <Icon size={14} className="flex-shrink-0 text-text-2" />
              <span
                className={`min-w-0 flex-1 ${SECTION_VALUE_SMALL_SECONDARY_CLASSES}`}
              >
                {label}
              </span>
              <Check
                size={14}
                className="flex-shrink-0 text-success-6"
                aria-hidden
              />
            </div>
          </SectionRow>
        ))}
      </SectionContainer>
      <InlineAlert
        type="info"
        title={destination}
        icon={<DestinationIcon size={14} className="flex-shrink-0" />}
      >
        {t(
          team
            ? "readiness.ready.teamDestinationHint"
            : "readiness.ready.destinationHint"
        )}
      </InlineAlert>
    </WizardStepContent>
  );
};

export const SetupOperationError: React.FC<StepProps> = ({ controller }) =>
  controller.operationError ? (
    <div
      className={`${DETAIL_PANEL_TOKENS.contentWidth} ${DETAIL_PANEL_TOKENS.contentPaddingBottom}`}
    >
      <InlineAlert type="danger" role="alert">
        {controller.operationError}
      </InlineAlert>
    </div>
  ) : null;
