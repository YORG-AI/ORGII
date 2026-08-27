/**
 * Preview panel for a channel (Connections category).
 * Shows enable toggle, overview, probe section, and channel config.
 */
import { ChevronsLeftRightEllipsis } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import { PLACEHOLDER_TOKENS, Placeholder } from "@src/components/Placeholder";
import Switch from "@src/components/Switch";
import type { useChannelState } from "@src/modules/MainApp/Integrations/hooks/useChannelState";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  PanelFooter,
  PanelHeader,
} from "@src/modules/shared/layouts/blocks";
import { InfoRow } from "@src/modules/shared/layouts/blocks/InfoRow";

import { ChannelDetailContent, ChannelWizard } from ".";
import { DetailHeaderClose } from "../../shared/DetailHeaderClose";
import { ChannelOverviewSection, ProbeSection } from "./components";

interface ChannelPreviewPanelProps {
  channel: Pick<
    ReturnType<typeof useChannelState>,
    | "config"
    | "update"
    | "selectedChannel"
    | "channelWizardMode"
    | "channelWizardInitialSelection"
    | "selectedChannelPath"
    | "isSelectedChannelEnabled"
    | "selectedChannelStatus"
    | "channelProbing"
    | "channelProbeResult"
    | "existingAccountsMap"
    | "refreshProjectConnections"
    | "handleChannelWizardSubmit"
    | "handleChannelWizardCancel"
    | "handleProbeChannel"
    | "handleRemoveChannel"
    | "toggleChannelEnabled"
  >;
  onGitConnected?: () => void;
  onClose: () => void;
  onExpand?: () => void;
}

const ChannelPreviewPanel: React.FC<ChannelPreviewPanelProps> = ({
  channel,
  onGitConnected,
  onClose,
  onExpand,
}) => {
  const { t: tIntegrations } = useTranslation("integrations");

  const {
    config,
    update,
    selectedChannel,
    channelWizardMode,
    channelWizardInitialSelection,
    selectedChannelPath,
    isSelectedChannelEnabled,
    selectedChannelStatus,
    channelProbing,
    channelProbeResult,
    existingAccountsMap,
    refreshProjectConnections,
    handleChannelWizardSubmit,
    handleChannelWizardCancel,
    handleProbeChannel,
    handleRemoveChannel,
    toggleChannelEnabled,
  } = channel;

  if (channelWizardMode) {
    return (
      <ChannelWizard
        onSubmit={handleChannelWizardSubmit}
        onCancel={handleChannelWizardCancel}
        existingAccounts={existingAccountsMap}
        initialCategory={channelWizardInitialSelection?.category}
        initialType={channelWizardInitialSelection?.type}
        onGitConnected={onGitConnected}
        onProjectsConnected={refreshProjectConnections}
      />
    );
  }

  if (!selectedChannel) {
    return (
      <Placeholder
        variant="empty"
        placement="detail-panel"
        icon={<ChevronsLeftRightEllipsis size={PLACEHOLDER_TOKENS.iconSize} />}
        title={tIntegrations("common:placeholders.selectToViewConfig", {
          type: tIntegrations("common:placeholderTypes.connection"),
        })}
        subtitle={tIntegrations(
          "common:placeholders.selectToViewConfigSubtitle"
        )}
      />
    );
  }

  return (
    <DetailPanelContainer>
      <PanelHeader
        title={tIntegrations("common:common.preview")}
        actions={<DetailHeaderClose onClick={onClose} onExpand={onExpand} />}
      />

      <div className={DETAIL_PANEL_TOKENS.scrollContent}>
        <div className={DETAIL_PANEL_TOKENS.contentWidthWithPadding}>
          <div className="rounded-lg bg-fill-2 p-4">
            <InfoRow label={tIntegrations("status.enabled")}>
              <Switch
                size="small"
                checked={isSelectedChannelEnabled}
                onCheckedChange={toggleChannelEnabled}
              />
            </InfoRow>
          </div>

          <div className="mt-3">
            <ChannelOverviewSection
              channelType={selectedChannel.type}
              accountId={selectedChannel.accountId}
              enabled={isSelectedChannelEnabled}
              connectionStatus={selectedChannelStatus.connectionStatus}
              connectionError={selectedChannelStatus.connectionError}
              probeResult={channelProbeResult}
            />
          </div>

          {channelProbeResult && (
            <div className="mt-3">
              <ProbeSection
                probing={channelProbing}
                result={channelProbeResult}
                onProbe={handleProbeChannel}
                compact
              />
            </div>
          )}

          <div className="mt-3">
            <ChannelDetailContent
              channelType={selectedChannel.type}
              config={config}
              update={update}
              pathPrefix={selectedChannelPath}
            />
          </div>
        </div>
      </div>
      <PanelFooter
        primaryAction={{
          label: tIntegrations("channels.quickActions.testConnection"),
          onClick: handleProbeChannel,
          loading: channelProbing,
        }}
        secondaryActions={[
          {
            label: tIntegrations("common:actions.remove"),
            onClick: handleRemoveChannel,
            variant: "danger",
            appearance: "outline",
          },
        ]}
      />
    </DetailPanelContainer>
  );
};

export default ChannelPreviewPanel;
