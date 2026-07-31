import {
  AlertCircle,
  Boxes,
  BriefcaseBusiness,
  Building2,
  Check,
  CircleCheck,
  Clipboard,
  Cloud,
  Eye,
  FolderGit2,
  Inbox,
  Info,
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
import type { LucideIcon } from "lucide-react";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import { openOrg2CloudSignIn } from "@src/features/Org2Cloud/useOrg2CloudSignIn";
import { useAppearanceState } from "@src/modules/MainApp/Settings/sections/useAppearanceState";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { openWorkspaceSpotlight } from "@src/scaffold/GlobalSpotlight/openSpotlight";
import { TUTORIALS } from "@src/scaffold/Tutorials/tutorialRegistry";
import SelectionGrid from "@src/scaffold/WizardSystem/primitives/SelectionGrid";
import type { SelectionGridOption } from "@src/scaffold/WizardSystem/primitives/SelectionGrid";

import type { SetupWalkthroughController } from "../useSetupWalkthroughController";

type StepProps = { controller: SetupWalkthroughController };

const CONTROL_STYLE = { width: "100%", maxWidth: "100%" } as const;

const StepFrame: React.FC<{
  title: string;
  description: string;
  icon: LucideIcon;
  children: React.ReactNode;
}> = ({ title, description, icon: Icon, children }) => {
  const titleId = React.useId();
  return (
    <section
      className="walkthrough-step-frame mx-auto flex w-full max-w-3xl flex-col gap-6"
      aria-labelledby={titleId}
    >
      <header className="flex items-start gap-3">
        <Icon
          size={16}
          strokeWidth={1.7}
          className="mt-1 flex-shrink-0 text-text-3"
          aria-hidden
        />
        <div className="min-w-0">
          <h1
            id={titleId}
            className="m-0 text-2xl font-semibold tracking-tight text-text-1"
          >
            {title}
          </h1>
          <p className="m-0 mt-1.5 max-w-2xl text-sm leading-6 text-text-3">
            {description}
          </p>
        </div>
      </header>
      <div className="walkthrough-step-body flex flex-col gap-5">
        {children}
      </div>
    </section>
  );
};

const STATUS_STYLES = {
  error: {
    icon: AlertCircle,
    className:
      "border-danger-6/30 bg-danger-1 text-danger-6 shadow-sm shadow-danger-6/5",
  },
  success: {
    icon: CircleCheck,
    className:
      "border-success-6/30 bg-success-1 text-success-7 shadow-sm shadow-success-6/5",
  },
  info: {
    icon: Info,
    className: "border-border-1 bg-fill-2/80 text-text-2",
  },
} as const;

const StatusBanner: React.FC<{
  kind?: keyof typeof STATUS_STYLES;
  className?: string;
  children: React.ReactNode;
}> = ({ kind = "info", className = "", children }) => {
  const config = STATUS_STYLES[kind];
  const StatusIcon = config.icon;
  return (
    <div
      className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm leading-5 ${config.className} ${className}`.trim()}
      role={kind === "error" ? "alert" : "status"}
    >
      <StatusIcon size={16} className="mt-0.5 flex-shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
};

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
    <StepFrame
      title={t("readiness.goal.title")}
      description={t("readiness.goal.description")}
      icon={ListChecks}
    >
      <SelectionGrid
        options={options}
        selected={controller.progress.goal}
        onSelect={controller.selectGoal}
        columns={3}
        cardLayout="inline"
        showSelectionCheck={false}
        cardClassName="walkthrough-goal-card"
        className="walkthrough-choice-grid walkthrough-goal-grid"
      />
      <StatusBanner className="walkthrough-goal-hint">
        {t("readiness.goal.hint")}
      </StatusBanner>
    </StepFrame>
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
    <StepFrame
      title={t("readiness.tools.title")}
      description={t("readiness.tools.description")}
      icon={KeyRound}
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
                    ? "text-success-7 inline-flex items-center gap-1.5 text-sm"
                    : "text-sm text-text-3"
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
        <StatusBanner kind="success">
          {t("readiness.tools.historyImported", {
            count: controller.progress.historySessionCount,
          })}
        </StatusBanner>
      )}
      <p className="m-0 text-xs leading-5 text-text-3">
        {t("readiness.tools.privacy")}
      </p>
    </StepFrame>
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
    <StepFrame
      title={t("readiness.organization.title")}
      description={t("readiness.organization.description")}
      icon={Building2}
    >
      {!controller.cloudAuth ? (
        <StatusBanner>
          <div className="flex items-center justify-between gap-3">
            <span>{t("readiness.organization.signInHint")}</span>
            <Button
              variant="primary"
              icon={<Cloud size={15} />}
              onClick={openSignIn}
              data-testid="setup-cloud-sign-in"
            >
              {t("readiness.organization.signIn")}
            </Button>
          </div>
        </StatusBanner>
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
                  className="walkthrough-choice-grid"
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
                className="walkthrough-choice-grid"
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
        <StatusBanner kind="success">
          {t("readiness.organization.selected", {
            org: controller.progress.selectedOrgName,
          })}
        </StatusBanner>
      )}
    </StepFrame>
  );
};

export const SharingStep: React.FC<StepProps> = ({ controller }) => {
  const { t } = useTranslation("onboarding");
  const isMember = controller.progress.selectedOrgRole === "member";
  const isSaved = controller.progress.verifiedAt !== null;
  return (
    <StepFrame
      title={t("readiness.sharing.title")}
      description={t("readiness.sharing.description")}
      icon={ShieldCheck}
    >
      <SectionContainer>
        <SectionRow
          label={t("readiness.sharing.workspace")}
          description={t("readiness.sharing.workspaceDescription")}
        >
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className="max-w-64 truncate text-sm text-text-2">
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
                <code className="break-all text-xs text-text-2">{scope}</code>
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
          <StatusBanner>
            {t("readiness.sharing.memberHint", {
              org: controller.progress.selectedOrgName,
            })}
          </StatusBanner>
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
        <div className="flex items-center gap-2 rounded-lg border border-border-1 bg-fill-2 p-2">
          <code className="min-w-0 flex-1 truncate text-xs">
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
      )}
      {isSaved && (
        <StatusBanner kind="success">
          {t(
            isMember
              ? "readiness.sharing.memberVerified"
              : "readiness.sharing.verified"
          )}
        </StatusBanner>
      )}
    </StepFrame>
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
    <StepFrame
      title={t("onboarding:readiness.basics.title")}
      description={t("onboarding:readiness.basics.description")}
      icon={MonitorCog}
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
      <StatusBanner>
        {t("onboarding:readiness.basics.settingsHint")}
      </StatusBanner>
    </StepFrame>
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
    <StepFrame
      title={t("readiness.tutorial.title")}
      description={t("readiness.tutorial.description")}
      icon={Play}
    >
      <SelectionGrid
        options={options}
        selected={controller.progress.tutorialId}
        onSelect={(tutorialId) => controller.patchProgress({ tutorialId })}
        columns={2}
        className="walkthrough-choice-grid"
      />
      <StatusBanner>{t("readiness.tutorial.hint")}</StatusBanner>
    </StepFrame>
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
    <StepFrame
      title={t("readiness.model.title")}
      description={t("readiness.model.description")}
      icon={Boxes}
    >
      <div className="grid grid-cols-2 gap-3">
        {MODEL_ITEMS.map(({ key, icon: Icon }, index) => (
          <div
            key={key}
            className="group relative overflow-hidden rounded-2xl border border-border-1 bg-bg-1 p-4 transition-colors hover:border-border-3"
          >
            <span className="absolute right-3 top-3 text-xs font-medium tabular-nums text-text-4">
              0{index + 1}
            </span>
            <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-primary-1 text-primary-6 transition-transform group-hover:scale-105">
              <Icon size={17} />
            </div>
            <div className="mb-1.5 text-sm font-semibold text-text-1">
              {t(`readiness.model.${key}.title`)}
            </div>
            <p className="m-0 text-xs leading-5 text-text-2">
              {t(`readiness.model.${key}.description`)}
            </p>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-center gap-2 rounded-xl border border-primary-6/20 bg-primary-1 px-4 py-3 text-xs font-medium text-primary-6">
        <FolderGit2 size={15} />
        <span>{t("readiness.model.relationship")}</span>
      </div>
    </StepFrame>
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
  return (
    <StepFrame
      title={t("readiness.ready.title")}
      description={t("readiness.ready.description")}
      icon={Check}
    >
      <div className="grid grid-cols-2 gap-3">
        <StatusBanner kind="success">
          <div className="flex items-center gap-2">
            <KeyRound size={15} />
            {controller.progress.tools.some((tool) => tool.found)
              ? t("readiness.ready.toolsReady")
              : t("readiness.ready.toolsLater")}
          </div>
        </StatusBanner>
        <StatusBanner kind="success">
          <div className="flex items-center gap-2">
            <FolderGit2 size={15} />
            {controller.workspaceFolders.length
              ? t("readiness.ready.workspaceReady")
              : t("readiness.ready.workspaceLater")}
          </div>
        </StatusBanner>
        {team && (
          <>
            <StatusBanner kind="success">
              <div className="flex items-center gap-2">
                <Building2 size={15} />
                {controller.progress.selectedOrgName}
              </div>
            </StatusBanner>
            <StatusBanner kind="success">
              <div className="flex items-center gap-2">
                <Eye size={15} />
                {t(
                  controller.progress.selectedOrgRole === "member"
                    ? "readiness.ready.memberSyncReady"
                    : "readiness.ready.teamPolicyReady"
                )}
              </div>
            </StatusBanner>
          </>
        )}
      </div>
      <div className="relative overflow-hidden rounded-2xl border border-primary-6/30 bg-primary-1 p-5">
        <div
          className="absolute -right-8 -top-8 h-28 w-28 rounded-full bg-primary-6/10 blur-2xl"
          aria-hidden
        />
        <div className="relative mb-1.5 flex items-center gap-2 font-semibold text-text-1">
          {team ? (
            <Inbox size={17} />
          ) : controller.progress.goal === "work_management" ? (
            <BriefcaseBusiness size={17} />
          ) : (
            <Play size={17} />
          )}
          {destination}
        </div>
        <p className="relative m-0 text-xs leading-5 text-text-2">
          {t(
            team
              ? "readiness.ready.teamDestinationHint"
              : "readiness.ready.destinationHint"
          )}
        </p>
      </div>
    </StepFrame>
  );
};

export const SetupOperationError: React.FC<StepProps> = ({ controller }) =>
  controller.operationError ? (
    <div className="mx-auto w-full max-w-3xl pb-2">
      <StatusBanner kind="error">{controller.operationError}</StatusBanner>
    </div>
  ) : null;
