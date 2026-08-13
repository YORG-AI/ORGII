import { useAtomValue } from "jotai";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { type RoutineDefinition, projectApi } from "@src/api/http/project";
import { rpc } from "@src/api/tauri/rpc";
import type { DispatchCategory } from "@src/api/tauri/session";
import Button from "@src/components/Button";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";
import type { AgentDefinition } from "@src/modules/MainApp/AgentOrgs/types";
import { SECTION_GAP_CLASSES } from "@src/modules/shared/layouts/SectionLayout";
import type { AgentSelection } from "@src/scaffold/GlobalSpotlight/palettes";
import {
  DispatchCategoryPalette,
  UnifiedModelPalette,
  WorkspacePalette,
} from "@src/scaffold/GlobalSpotlight/palettes";
import type { RepoItem } from "@src/scaffold/GlobalSpotlight/types";
import {
  WizardShell,
  WizardStepLayout,
} from "@src/scaffold/WizardSystem/primitives";
import { timezoneAtom } from "@src/store/ui/timezoneAtom";

import RoutineBasicsSection from "./RoutineBasicsSection";
import RoutineExecutionSections from "./RoutineExecutionSections";
import RoutineOutputSection from "./RoutineOutputSection";
import {
  ROUTINE_TARGET_KIND,
  type RoutineDraft,
  type RoutineProjectOption,
  createRoutineDefinition,
  createRoutineDraft,
  isRoutineDraftValid,
  normalizeFsUri,
} from "./routineDraft";

interface RoutineWizardProps {
  routine?: RoutineDefinition;
  agents?: AgentDefinition[];
  onSave: (routine: RoutineDefinition) => void;
  onCancel: () => void;
}

interface AgentOrgOption {
  id: string;
  name: string;
  agentId: string;
}

const ROUTINE_MODEL_PALETTE_CATEGORY: DispatchCategory = "rust_agent";

const RoutineWizard: React.FC<RoutineWizardProps> = ({
  routine,
  agents = [],
  onSave,
  onCancel,
}) => {
  const { t } = useTranslation("integrations");
  const configuredTimezone = useAtomValue(timezoneAtom);
  const defaultTimezone = useMemo(() => {
    if (!configuredTimezone || configuredTimezone === "auto") {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "utc";
    }
    return configuredTimezone;
  }, [configuredTimezone]);
  const [draft, setDraft] = useState<RoutineDraft>(() =>
    createRoutineDraft(routine, defaultTimezone)
  );
  const [agentOrgs, setAgentOrgs] = useState<AgentOrgOption[]>([]);
  const [projects, setProjects] = useState<RoutineProjectOption[]>([]);
  const [isAgentPaletteOpen, setIsAgentPaletteOpen] = useState(false);
  const [isWorkspacePaletteOpen, setIsWorkspacePaletteOpen] = useState(false);
  const [isModelPaletteOpen, setIsModelPaletteOpen] = useState(false);

  useEffect(() => {
    setDraft(createRoutineDraft(routine, defaultTimezone));
  }, [defaultTimezone, routine]);

  useEffect(() => {
    let cancelled = false;
    rpc.agentOrgs.orgs.list().then((orgs) => {
      if (cancelled) return;
      setAgentOrgs(
        orgs.map((org) => ({
          id: org.id,
          name: org.name,
          agentId: org.agentId,
        }))
      );
    });
    projectApi.readProjects().then((projectList) => {
      if (cancelled) return;
      setProjects(
        projectList.map((project) => ({
          slug: project.slug,
          name: project.meta.name,
        }))
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Backfill the display label after a routine is loaded for edit. The
  // draft stores only the target id; the human label lives on the
  // `agents` / `agentOrgs` lists which arrive asynchronously.
  useEffect(() => {
    setDraft((current) => {
      const target = current.target;
      if (!target || current.targetLabel) return current;
      if (target.kind === ROUTINE_TARGET_KIND.AGENT_DEFINITION) {
        const agent = agents.find(
          (candidate) => candidate.id === target.agentDefinitionId
        );
        if (!agent) return current;
        return {
          ...current,
          targetLabel: agent.name,
          targetIconId: undefined,
          targetIsOrg: false,
        };
      }
      const org = agentOrgs.find(
        (candidate) => candidate.id === target.agentOrgId
      );
      if (!org) return current;
      return {
        ...current,
        targetLabel: org.name,
        targetIsOrg: true,
      };
    });
  }, [agents, agentOrgs]);

  const canSave = isRoutineDraftValid(draft);

  const updateDraft = useCallback(function updateRoutineDraft<
    Key extends keyof RoutineDraft,
  >(key: Key, value: RoutineDraft[Key]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }, []);

  const handleAgentSelect = useCallback((selection: AgentSelection) => {
    // Routines only persist agent_definition or agent_org targets — the
    // wire format has no slot for CLI agents or external Cursor IDE.
    if (selection.targetKind === "agent_org" && selection.agentOrgId) {
      setDraft((current) => ({
        ...current,
        target: {
          kind: ROUTINE_TARGET_KIND.AGENT_ORG,
          agentOrgId: selection.agentOrgId!,
        },
        targetLabel: selection.agentName,
        targetIconId: selection.agentIconId,
        targetIsOrg: true,
      }));
      return;
    }
    if (selection.targetKind === "agent" && selection.agentDefinitionId) {
      setDraft((current) => ({
        ...current,
        target: {
          kind: ROUTINE_TARGET_KIND.AGENT_DEFINITION,
          agentDefinitionId: selection.agentDefinitionId!,
        },
        targetLabel: selection.agentName,
        targetIconId: selection.agentIconId,
        targetIsOrg: false,
      }));
    }
  }, []);

  const handleWorkspaceSelect = useCallback(
    (_repoId: string, repo: RepoItem) => {
      const path = normalizeFsUri(repo.fs_uri);
      setDraft((current) => ({
        ...current,
        workspacePath: path,
        workspaceLabel: repo.name || path,
        // Picking a repo only makes sense when we actually want a
        // workspace; promote NONE -> LOCAL_WORKSPACE so save can wire
        // the path through.
        workspaceKind:
          current.workspaceKind === "NONE"
            ? "LOCAL_WORKSPACE"
            : current.workspaceKind,
      }));
    },
    []
  );

  const modelAdvancedConfig = useMemo<AdvancedConfig>(
    () => ({
      model: draft.model || undefined,
      selectedAccountId: draft.accountId || undefined,
    }),
    [draft.model, draft.accountId]
  );

  const handleModelConfigChange = useCallback((config: AdvancedConfig) => {
    setDraft((current) => ({
      ...current,
      model: config.model ?? config.listingModel ?? "",
      accountId: config.selectedAccountId ?? "",
      modelLabel:
        config.listingModelDisplay ??
        config.listingName ??
        config.model ??
        config.listingModel ??
        "",
      modelType:
        config.selectedSourceModelType ?? config.listingModelType ?? undefined,
    }));
  }, []);

  const currentAgentDefinitionId =
    draft.target?.kind === ROUTINE_TARGET_KIND.AGENT_DEFINITION
      ? draft.target.agentDefinitionId
      : undefined;
  const currentAgentOrgId =
    draft.target?.kind === ROUTINE_TARGET_KIND.AGENT_ORG
      ? draft.target.agentOrgId
      : undefined;

  const handleSave = useCallback(() => {
    if (!canSave || !draft.target) return;
    const updatedAt = new Date().toISOString();
    onSave(createRoutineDefinition(draft, routine, updatedAt));
  }, [canSave, draft, onSave, routine]);

  const actions = (
    <>
      <Button
        variant="secondary"
        size="small"
        onClick={onCancel}
        data-testid="routine-wizard-cancel-button"
      >
        {t("common:actions.cancel")}
      </Button>
      <Button
        variant="primary"
        size="small"
        disabled={!canSave}
        onClick={handleSave}
        data-testid="routine-wizard-save-button"
      >
        {t("common:actions.save")}
      </Button>
    </>
  );

  return (
    <WizardShell
      title={
        routine ? t("routineFields.editRoutine") : t("routineFields.addRoutine")
      }
      onCancel={onCancel}
      testId="routine-wizard-root"
    >
      <WizardStepLayout
        currentStep={1}
        totalSteps={1}
        actions={actions}
        hideStepIndicator
        contentWidthFooter
      >
        <div className={SECTION_GAP_CLASSES}>
          <RoutineBasicsSection
            draft={draft}
            setDraft={setDraft}
            updateDraft={updateDraft}
            isAgentPaletteOpen={isAgentPaletteOpen}
            onOpenAgentPalette={() => setIsAgentPaletteOpen(true)}
          />
          <RoutineExecutionSections
            draft={draft}
            updateDraft={updateDraft}
            isWorkspacePaletteOpen={isWorkspacePaletteOpen}
            isModelPaletteOpen={isModelPaletteOpen}
            onOpenWorkspacePalette={() => setIsWorkspacePaletteOpen(true)}
            onOpenModelPalette={() => setIsModelPaletteOpen(true)}
          />
          <RoutineOutputSection
            draft={draft}
            projects={projects}
            updateDraft={updateDraft}
          />
        </div>
      </WizardStepLayout>

      <DispatchCategoryPalette
        isOpen={isAgentPaletteOpen}
        onClose={() => setIsAgentPaletteOpen(false)}
        onSelect={handleAgentSelect}
        currentCategory={draft.target ? "rust_agent" : undefined}
        currentAgentDefinitionId={currentAgentDefinitionId}
        currentAgentOrgId={currentAgentOrgId}
      />

      <WorkspacePalette
        isOpen={isWorkspacePaletteOpen}
        onClose={() => setIsWorkspacePaletteOpen(false)}
        onSelect={handleWorkspaceSelect}
      />

      <UnifiedModelPalette
        isOpen={isModelPaletteOpen}
        onClose={() => setIsModelPaletteOpen(false)}
        advancedConfig={modelAdvancedConfig}
        onConfigChange={handleModelConfigChange}
        dispatchCategoryOverride={ROUTINE_MODEL_PALETTE_CATEGORY}
      />
    </WizardShell>
  );
};

export default RoutineWizard;
