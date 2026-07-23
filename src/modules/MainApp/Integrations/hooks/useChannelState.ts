/**
 * Channel state & callbacks for the Integrations tab.
 * Extracted from IntegrationsPage to keep the page component thin.
 *
 * "Add channel" wizard open-state lives in the URL via
 * {@link useWizardParam} (`?wizard=channel-add`).
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import {
  type SyncConnection,
  syncConnectionsApi,
} from "@src/api/http/integrations";
import { toggleChannel } from "@src/api/tauri/agent";
import { WIZARD_IDS, buildWizardPath } from "@src/config/mainAppPaths";
import { useAsyncResource } from "@src/hooks/async";
import { createLogger } from "@src/hooks/logger";
import { useWizardParam } from "@src/hooks/navigation";
import type { WizardCategory } from "@src/scaffold/WizardSystem/variants/Channel/channelWizardTypes";
import { showChannelActionDialogSafely } from "@src/util/dialogs/channelActionDialog";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import type { ChannelStatusEntry } from "../../AgentOrgs/config/osAgent/types";
import { useOSAgentConfig } from "../../AgentOrgs/config/osAgent/useOSAgentConfig";
import {
  deleteNested,
  getNestedBool,
  getNestedRecord,
} from "../../AgentOrgs/config/osAgent/utils";
import {
  CHANNEL_TYPES,
  accountPathPrefix,
  probeChannel,
} from "../Connections/Channels";
import type {
  ChannelConnectionStatus,
  ChannelInstance,
  ChannelProbeResult,
  ChannelSelection,
} from "../Connections/Channels";

const log = createLogger("integrations");
const EMPTY_SYNC_CONNECTIONS: SyncConnection[] = [];

function resolveConnectionStatus(
  enabled: boolean,
  channelName: string,
  channelStatuses: ChannelStatusEntry[] | undefined
): { status: ChannelConnectionStatus; error?: string } {
  if (!enabled) return { status: "disabled" };
  if (!channelStatuses) return { status: "connecting" };

  const entry = channelStatuses.find((ch) => ch.name === channelName);
  if (!entry) return { status: "connecting" };

  if (entry.connected) return { status: "connected" };
  if (entry.error) return { status: "error", error: entry.error };
  return { status: "reconnecting" };
}

export interface UseChannelStateOptions {
  channelStatuses?: ChannelStatusEntry[];
}

interface ChannelWizardInitialSelection {
  category: WizardCategory;
  type: string;
}

interface ChannelAddOptions {
  initialSelection?: ChannelWizardInitialSelection;
  targetPath?: string;
}

export function useChannelState(options: UseChannelStateOptions = {}) {
  const { channelStatuses } = options;
  const { t: tIntegrations } = useTranslation("integrations");
  const navigate = useNavigate();
  const { config, loaded, update, rawUpdate } = useOSAgentConfig();

  // ── Selection ──
  const [selectedChannel, setSelectedChannel] =
    useState<ChannelSelection | null>(null);
  const [channelWizardInitialSelection, setChannelWizardInitialSelection] =
    useState<ChannelWizardInitialSelection | null>(null);
  const { wizard, openWizard, closeWizard } = useWizardParam();
  const channelWizardMode = wizard === WIZARD_IDS.CHANNEL_ADD;

  // ── Probe ──
  const [channelProbing, setChannelProbing] = useState(false);
  const [channelProbeResult, setChannelProbeResult] =
    useState<ChannelProbeResult | null>(null);
  const probeIdRef = useRef(0);

  const loadProjectConnections = useCallback(() => {
    return syncConnectionsApi.list();
  }, []);
  const projectConnectionsResource = useAsyncResource<SyncConnection[]>({
    fetcher: loadProjectConnections,
    initialData: EMPTY_SYNC_CONNECTIONS,
    scopeKey: "project-connections",
  });
  const projectConnections = projectConnectionsResource.data;
  const projectConnectionsLoading = projectConnectionsResource.loading;
  const projectConnectionsError = projectConnectionsResource.error;
  const refreshProjectConnections = projectConnectionsResource.refresh;

  // ── Derived data ──
  const channelInstances = useMemo(() => {
    const instances: ChannelInstance[] = [];
    for (const channelType of CHANNEL_TYPES) {
      const accountsMap = getNestedRecord(
        config,
        `channels.${channelType.type}.accounts`
      );
      for (const [accountId, accountConfig] of Object.entries(accountsMap)) {
        if (accountConfig && typeof accountConfig === "object") {
          const enabled =
            (accountConfig as Record<string, unknown>).enabled === true;
          const channelName = `${channelType.type}:${accountId}`;
          const { status, error } = resolveConnectionStatus(
            enabled,
            channelName,
            channelStatuses
          );
          instances.push({
            type: channelType.type,
            accountId,
            enabled,
            connectionStatus: status,
            connectionError: error,
          });
        }
      }
    }
    return instances;
  }, [config, channelStatuses]);

  const groupedChannels = useMemo(() => {
    const groups = new Map<string, ChannelInstance[]>();
    for (const instance of channelInstances) {
      const list = groups.get(instance.type) ?? [];
      list.push(instance);
      groups.set(instance.type, list);
    }
    return groups;
  }, [channelInstances]);

  const existingAccountsMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const [type, instances] of groupedChannels.entries()) {
      map.set(
        type,
        instances.map((inst) => inst.accountId)
      );
    }
    for (const connection of projectConnections) {
      const existing = map.get(connection.adapter_id) ?? [];
      existing.push(connection.label.trim().toLowerCase().replace(/\s+/g, "-"));
      map.set(connection.adapter_id, existing);
    }
    return map;
  }, [groupedChannels, projectConnections]);

  /** Derive which services have API keys configured */
  // ── Selection helpers ──
  const selectedChannelPath = useMemo(() => {
    if (!selectedChannel) return "";
    return accountPathPrefix(selectedChannel.type, selectedChannel.accountId);
  }, [selectedChannel]);

  const isSelectedChannelEnabled = useMemo(() => {
    if (!selectedChannel) return false;
    return getNestedBool(config, `${selectedChannelPath}.enabled`, false);
  }, [selectedChannel, selectedChannelPath, config]);

  const selectedChannelStatus = useMemo(() => {
    if (!selectedChannel) return { connectionStatus: "unknown" as const };
    const instance = channelInstances.find(
      (inst) =>
        inst.type === selectedChannel.type &&
        inst.accountId === selectedChannel.accountId
    );
    return {
      connectionStatus: instance?.connectionStatus ?? ("unknown" as const),
      connectionError: instance?.connectionError,
    };
  }, [selectedChannel, channelInstances]);

  const isChannelSelected = useCallback(
    (type: string, accountId: string) =>
      selectedChannel?.type === type &&
      selectedChannel?.accountId === accountId,
    [selectedChannel]
  );

  const handleChannelClick = useCallback(
    (compositeId: string) => {
      const colonIdx = compositeId.indexOf(":");
      if (colonIdx === -1) return;
      setSelectedChannel({
        type: compositeId.slice(0, colonIdx),
        accountId: compositeId.slice(colonIdx + 1),
      });
      closeWizard();
      setChannelProbeResult(null);
    },
    [closeWizard]
  );

  // ── Actions ──
  const toggleChannelEnabled = useCallback(
    (checked: boolean) => {
      if (!selectedChannel) return;
      update(`${selectedChannelPath}.enabled`, checked);
      toggleChannel(
        selectedChannel.type,
        selectedChannel.accountId,
        checked
      ).catch((err: unknown) => {
        log.error("[integrations] Failed to toggle channel:", err);
        // Roll back the optimistic local write so the UI reflects the
        // actual backend state, and surface the failure to the user.
        update(`${selectedChannelPath}.enabled`, !checked);
        const errorMessage =
          err instanceof Error ? err.message : String(err ?? "Unknown error");
        showChannelActionDialogSafely(
          tIntegrations("channels.toggleFailed", { error: errorMessage }),
          "error"
        );
      });
    },
    [selectedChannel, selectedChannelPath, update, tIntegrations]
  );

  const clearSelection = useCallback(() => {
    setSelectedChannel(null);
  }, []);

  const handleChannelAdd = useCallback(
    (options: ChannelAddOptions = {}) => {
      setSelectedChannel(null);
      setChannelWizardInitialSelection(options.initialSelection ?? null);
      if (options.targetPath) {
        navigate(buildWizardPath(options.targetPath, WIZARD_IDS.CHANNEL_ADD));
        return;
      }
      openWizard(WIZARD_IDS.CHANNEL_ADD);
    },
    [navigate, openWizard]
  );

  const handleChannelWizardCancel = useCallback(() => {
    setChannelWizardInitialSelection(null);
    closeWizard();
  }, [closeWizard]);

  const handleChannelWizardSubmit = useCallback(
    (
      channelType: string,
      accountId: string,
      configData: Record<string, unknown>
    ) => {
      const prefix = accountPathPrefix(channelType, accountId);
      update(prefix, configData);
      setChannelWizardInitialSelection(null);
      closeWizard();
      setSelectedChannel({ type: channelType, accountId });
    },
    [update, closeWizard]
  );

  const handleProbeChannel = useCallback(async () => {
    if (!selectedChannel) return;
    const currentId = ++probeIdRef.current;
    setChannelProbing(true);
    setChannelProbeResult(null);
    try {
      const accountConfig = getNestedRecord(config, selectedChannelPath);
      const result = await probeChannel(selectedChannel.type, accountConfig);
      if (probeIdRef.current !== currentId) return;
      setChannelProbeResult(result);
    } catch (err) {
      if (probeIdRef.current !== currentId) return;
      setChannelProbeResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        elapsed_ms: 0,
      });
    } finally {
      if (probeIdRef.current === currentId) setChannelProbing(false);
    }
  }, [selectedChannel, selectedChannelPath, config]);

  const handleRemoveChannel = useCallback(async () => {
    if (!selectedChannel || !selectedChannelPath) return;

    const confirmed = await confirmDestructiveAction({
      title: tIntegrations("integrations.removeAccountTitle", {
        name: selectedChannel.accountId,
      }),
      message: tIntegrations("integrations.removeAccountConfirm"),
      okLabel: tIntegrations("common:actions.remove"),
      cancelLabel: tIntegrations("common:actions.cancel"),
    });
    if (!confirmed) return;

    const newConfig = deleteNested(config, selectedChannelPath);
    rawUpdate(newConfig);
    setSelectedChannel(null);
  }, [selectedChannel, selectedChannelPath, config, rawUpdate, tIntegrations]);

  // Inline row-action remove for a channel — same destructive flow as
  // `handleRemoveChannel` but addresses an arbitrary `(type, accountId)`
  // rather than the currently-selected one. The connections list uses
  // this from the trash icon column.
  const handleRemoveChannelRow = useCallback(
    async (channelType: string, accountId: string) => {
      const confirmed = await confirmDestructiveAction({
        title: tIntegrations("integrations.removeAccountTitle", {
          name: accountId,
        }),
        message: tIntegrations("integrations.removeAccountConfirm"),
        okLabel: tIntegrations("common:actions.remove"),
        cancelLabel: tIntegrations("common:actions.cancel"),
      });
      if (!confirmed) return;

      const prefix = accountPathPrefix(channelType, accountId);
      const newConfig = deleteNested(config, prefix);
      rawUpdate(newConfig);
      if (
        selectedChannel?.type === channelType &&
        selectedChannel?.accountId === accountId
      ) {
        setSelectedChannel(null);
      }
    },
    [config, rawUpdate, selectedChannel, tIntegrations]
  );

  // Trash-icon handler for a project sync connection row. Mirrors the
  // GitHub-tab "Disconnect" UX: confirm, hit `sync_connection_delete`,
  // then refetch the list so the row falls out without a manual reload.
  const handleRemoveProjectConnection = useCallback(
    async (connectionId: string, label: string) => {
      const confirmed = await confirmDestructiveAction({
        title: tIntegrations("integrations.removeAccountTitle", {
          name: label,
        }),
        message: tIntegrations("integrations.removeAccountConfirm"),
        okLabel: tIntegrations("common:actions.remove"),
        cancelLabel: tIntegrations("common:actions.cancel"),
      });
      if (!confirmed) return;

      try {
        await syncConnectionsApi.delete(connectionId);
        await refreshProjectConnections();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showChannelActionDialogSafely(
          tIntegrations("channels.toggleFailed", { error: message }),
          "error"
        );
      }
    },
    [refreshProjectConnections, tIntegrations]
  );

  return {
    // Config
    config,
    loaded,
    update,
    // Selection
    selectedChannel,
    channelWizardMode,
    channelWizardInitialSelection,
    selectedChannelPath,
    isSelectedChannelEnabled,
    selectedChannelStatus,
    isChannelSelected,
    clearSelection,
    // Probe
    channelProbing,
    channelProbeResult,
    // Data
    groupedChannels,
    projectConnections,
    projectConnectionsLoading,
    projectConnectionsError,
    existingAccountsMap,
    // Actions
    refreshProjectConnections,
    handleChannelClick,
    handleChannelAdd,
    handleChannelWizardCancel,
    handleChannelWizardSubmit,
    handleProbeChannel,
    handleRemoveChannel,
    handleRemoveChannelRow,
    handleRemoveProjectConnection,
    toggleChannelEnabled,
  };
}
