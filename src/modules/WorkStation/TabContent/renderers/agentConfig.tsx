/**
 * Renderer wrapper for `agent-config` tabs.
 *
 * Hosts the multi-tab agent / team detail view inside the WorkStation Code
 * Editor surface. Opened from the Agent Teams page table rows via
 * `openAgentConfigInWorkStation`, mirroring how skill previews are opened.
 *
 * The component dispatches on `tab.data.variant`:
 *   - "builtin-os" / "builtin-sde" → BuiltInAgentDetailView
 *   - "wingman"                    → WingmanDetailView
 *   - "custom"                     → CustomAgentDetailView
 *   - "cli"                        → CliAgentDetailView
 *   - "org"                        → OrgDetailView
 *
 * All data fetched here lives on shared Jotai atoms / module-scoped RPC
 * hooks so opening the tab does not require the Agent Teams page to be
 * mounted.
 */
import { useAtomValue } from "jotai";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import { Message } from "@src/components/Message";
import { useKeyVault } from "@src/hooks/keyVault";
import { createLogger } from "@src/hooks/logger";
import { usePublishWorkstationTabHeader } from "@src/hooks/workStation";
import { BuiltInAgentDetailView } from "@src/modules/MainApp/AgentOrgs/components/BuiltInAgentDetailViews";
import CliAgentDetailView from "@src/modules/MainApp/AgentOrgs/components/CliAgentDetailView";
import CustomAgentDetailView from "@src/modules/MainApp/AgentOrgs/components/CustomAgentDetailView";
import OrgDetailView from "@src/modules/MainApp/AgentOrgs/components/OrgDetailView";
import WingmanDetailView from "@src/modules/MainApp/AgentOrgs/components/WingmanDetailView";
import { useAgentDefinitions } from "@src/modules/MainApp/AgentOrgs/hooks/useAgentDefinitions";
import { builtInAgentsAtom } from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";
import type {
  AgentDefinition,
  AvailableCliAgent,
  OrgMember,
} from "@src/modules/MainApp/AgentOrgs/types";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import type { AgentConfigTabData } from "@src/store/workstation/tabs/types";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import type { UnifiedTabContentProps } from "../types";
import { CliAgentHeaderSwitcher } from "./CliAgentHeaderSwitcher";

const logger = createLogger("AgentConfigTab");
const AGENT_ORGS_CHANGED_EVENT = "orgii-agent-orgs-changed";

interface AgentConfigInnerProps {
  data: AgentConfigTabData;
}

const AgentConfigInner: React.FC<AgentConfigInnerProps> = ({ data }) => {
  const { t } = useTranslation("integrations");
  const { variant, entityId, cliAgentType } = data;
  const refreshAttemptedForEntityRef = useRef<string | null>(null);
  const headerDisplayName = data.displayName || entityId;

  // ── Agent definitions (built-ins + custom) ──
  const {
    agents: customAgents,
    refresh: refreshAgentDefinitions,
    removeAgent,
  } = useAgentDefinitions();
  const builtInAgents = useAtomValue(builtInAgentsAtom);

  useEffect(() => {
    if (variant !== "custom" && variant !== "wingman") return;
    const hasAgent =
      customAgents.some((agent) => agent.id === entityId) ||
      builtInAgents.some((agent) => agent.id === entityId);
    if (hasAgent) {
      refreshAttemptedForEntityRef.current = null;
      return;
    }
    if (refreshAttemptedForEntityRef.current === entityId) return;
    refreshAttemptedForEntityRef.current = entityId;
    void refreshAgentDefinitions({ forceFresh: true });
  }, [builtInAgents, customAgents, entityId, refreshAgentDefinitions, variant]);

  // ── Key Vault accounts (CLI compatibility table needs these) ──
  const { accounts } = useKeyVault({ autoLoad: variant === "cli" });

  // ── CLI agents (only fetched when this tab hosts a CLI) ──
  const [cliAgents, setCliAgents] = useState<AvailableCliAgent[]>([]);
  const fetchCliAgents = useCallback(async () => {
    const result = await rpc.agentOrgs.availableCliAgents();
    return result.sort((agentA, agentB) =>
      agentA.displayName.localeCompare(agentB.displayName)
    );
  }, []);

  const refreshCliAgents = useCallback(async () => {
    const installed = await fetchCliAgents();
    setCliAgents(installed);
  }, [fetchCliAgents]);

  useEffect(() => {
    if (variant !== "cli") return;
    let cancelled = false;
    fetchCliAgents().then((installed) => {
      if (!cancelled) setCliAgents(installed);
    });
    return () => {
      cancelled = true;
    };
  }, [variant, fetchCliAgents]);

  const headerContent = useMemo(() => {
    if (variant === "cli") {
      return (
        <CliAgentHeaderSwitcher
          activeAgentName={cliAgentType ?? entityId}
          fallbackDisplayName={headerDisplayName}
          cliAgents={cliAgents}
        />
      );
    }

    return (
      <div className="flex min-w-0 items-center">
        <span className="truncate text-[13px] font-medium text-text-1">
          {headerDisplayName}
        </span>
      </div>
    );
  }, [cliAgentType, cliAgents, entityId, headerDisplayName, variant]);

  usePublishWorkstationTabHeader({
    host: "code",
    content: { content: headerContent, sidebarToggleDisabled: true },
  });

  // ── Orgs (only fetched when this tab hosts an org) ──
  const entitySnapshot = data.entitySnapshot as OrgMember | undefined;
  const [orgs, setOrgs] = useState<OrgMember[]>([]);

  const loadOrgs = useCallback(async () => {
    const result = await rpc.agentOrgs.orgs.list();
    return result;
  }, []);

  useEffect(() => {
    if (variant !== "org") return;
    let cancelled = false;
    loadOrgs().then((result) => {
      if (!cancelled) setOrgs(result);
    });
    return () => {
      cancelled = true;
    };
  }, [variant, loadOrgs]);

  // ── Handlers ──
  const handleAgentDelete = useCallback(
    async (agentId: string) => {
      try {
        await removeAgent(agentId);
        Message.success(
          t("agentOrgs.agentDeleted", { defaultValue: "Agent deleted" })
        );
      } catch (err) {
        logger.error("agent delete failed", err);
        Message.error(
          t("agentOrgs.agentDeleteFailed", {
            defaultValue: "Failed to delete agent",
          })
        );
      }
    },
    [removeAgent, t]
  );

  const handleOrgSave = useCallback(
    async (org: OrgMember) => {
      const isUpdate =
        orgs.some((existing) => existing.id === org.id) ||
        entitySnapshot?.id === org.id;
      const orgJson = JSON.stringify(org);
      try {
        if (isUpdate) {
          await rpc.agentOrgs.orgs.update({ orgJson });
        } else {
          await rpc.agentOrgs.orgs.add({ orgJson });
        }
        const refreshed = await loadOrgs();
        setOrgs(refreshed);
        window.dispatchEvent(new Event(AGENT_ORGS_CHANGED_EVENT));
        Message.success(
          t(isUpdate ? "agentOrgs.orgUpdated" : "agentOrgs.orgCreated", {
            defaultValue: isUpdate ? "Team updated" : "Team created",
          })
        );
      } catch (err) {
        logger.error("org save failed", err);
        Message.error(
          t("agentOrgs.orgSaveFailed", {
            defaultValue: "Failed to save team",
          })
        );
      }
    },
    [orgs, entitySnapshot?.id, loadOrgs, t]
  );

  const handleOrgDelete = useCallback(
    async (orgId: string) => {
      const target = orgs.find((o) => o.id === orgId);
      const confirmed = await confirmDestructiveAction({
        title: t("agentOrgs.deleteOrgTitle", {
          defaultValue: "Delete team?",
        }),
        message: t("agentOrgs.deleteOrgMessage", {
          name: target?.name ?? "this team",
          defaultValue: `"${target?.name ?? "this team"}" will be permanently removed. This cannot be undone.`,
        }),
        okLabel: t("common.delete", { defaultValue: "Delete" }),
        cancelLabel: t("common.cancel", { defaultValue: "Cancel" }),
      });
      if (!confirmed) return;
      try {
        await rpc.agentOrgs.orgs.remove({ orgId });
        const refreshed = await loadOrgs();
        setOrgs(refreshed);
        window.dispatchEvent(new Event(AGENT_ORGS_CHANGED_EVENT));
        Message.success(
          t("agentOrgs.orgDeleted", { defaultValue: "Team deleted" })
        );
      } catch (err) {
        logger.error("org delete failed", err);
        Message.error(
          t("agentOrgs.orgDeleteFailed", {
            defaultValue: "Failed to delete team",
          })
        );
      }
    },
    [orgs, loadOrgs, t]
  );

  // ── Variant dispatch ──
  if (variant === "builtin-os") {
    return <BuiltInAgentDetailView variant="os" />;
  }

  if (variant === "builtin-sde") {
    return <BuiltInAgentDetailView variant="sde" />;
  }

  if (variant === "wingman") {
    const agent =
      builtInAgents.find((a) => a.id === entityId) ??
      customAgents.find((a) => a.id === entityId);
    if (!agent) {
      return (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("agentOrgs.emptySelectionTitle")}
          subtitle={t("agentOrgs.emptySelectionSubtitle")}
        />
      );
    }
    return <WingmanDetailView agent={agent} />;
  }

  if (variant === "custom") {
    const agentSnapshot = data.entitySnapshot as AgentDefinition | undefined;
    const agent =
      customAgents.find((customAgent) => customAgent.id === entityId) ??
      builtInAgents.find((builtInAgent) => builtInAgent.id === entityId) ??
      (agentSnapshot?.id === entityId ? agentSnapshot : undefined);
    if (!agent) {
      return (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("agentOrgs.emptySelectionTitle")}
          subtitle={t("agentOrgs.emptySelectionSubtitle")}
        />
      );
    }
    return (
      <CustomAgentDetailView agent={agent} onAgentDelete={handleAgentDelete} />
    );
  }

  if (variant === "cli") {
    const cliName = cliAgentType ?? entityId;
    const cliAgent = cliAgents.find((agent) => agent.name === cliName);
    if (!cliAgent) {
      return (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("agentOrgs.emptySelectionTitle")}
          subtitle={t("agentOrgs.emptySelectionSubtitle")}
        />
      );
    }
    return (
      <CliAgentDetailView
        agent={cliAgent}
        accounts={accounts}
        onRefresh={refreshCliAgents}
      />
    );
  }

  if (variant === "org") {
    const org =
      orgs.find((o) => o.id === entityId) ??
      (entitySnapshot?.id === entityId ? entitySnapshot : undefined);
    if (!org) {
      return (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("agentOrgs.emptySelectionTitle")}
          subtitle={t("agentOrgs.emptySelectionSubtitle")}
        />
      );
    }
    return (
      <OrgDetailView
        selectedOrg={org}
        customAgents={customAgents}
        onOrgSave={handleOrgSave}
        onOrgDelete={handleOrgDelete}
      />
    );
  }

  return (
    <Placeholder
      variant="empty"
      placement="detail-panel"
      title={t("agentOrgs.emptySelectionTitle")}
      subtitle={t("agentOrgs.emptySelectionSubtitle")}
    />
  );
};

const AgentConfigTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const data = tab.data as unknown as AgentConfigTabData;
    return (
      <div
        className="h-full min-h-0"
        data-testid={`agent-config-tab-${data.variant}-${data.entityId}`}
      >
        <AgentConfigInner data={data} />
      </div>
    );
  }
);

AgentConfigTabRenderer.displayName = "AgentConfigTabRenderer";

export default AgentConfigTabRenderer;
