import type { useChannelState } from "./hooks/useChannelState";

export {
  CATEGORY_KEYS,
  type IntegrationCategory,
  type DetailMode,
  type AddAction,
  type WizardKind,
} from "@src/api/types/integrations";

export type ChannelSlice = Pick<
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
