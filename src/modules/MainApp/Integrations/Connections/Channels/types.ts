/**
 * Connectivity Page Types
 *
 * Multi-account channel model: each channel type has named accounts.
 * Node Control stays single-instance.
 */

/**
 * Canonical channel-type wire values.
 *
 * Mirrors `agent_core/integrations/channels/config/mod.rs::channel_type::*`
 * — must stay in sync with the Rust constants the gateway dispatches on.
 * Use `CHANNEL_TYPE.TELEGRAM` instead of bare `"telegram"` literals at
 * call sites; bare literals defeat refactoring and bypass type narrowing.
 */
export const CHANNEL_TYPE = {
  TELEGRAM: "telegram",
  DISCORD: "discord",
  SLACK: "slack",
  WHATSAPP: "whatsapp",
  IMESSAGE: "imessage",
  SIGNAL: "signal",
  FEISHU: "feishu",
  DINGTALK: "dingtalk",
  ZALO: "zalo",
  LINE: "line",
  MSTEAMS: "msteams",
  MATRIX: "matrix",
  GOOGLECHAT: "googlechat",
  WEIXIN: "weixin",
  WECOM: "wecom",
  EMAIL: "email",
} as const;

type ChannelTypeKey = (typeof CHANNEL_TYPE)[keyof typeof CHANNEL_TYPE];

export const CHANNEL_TYPE_VALUES = Object.values(
  CHANNEL_TYPE
) as readonly ChannelTypeKey[];

/** Static definition of a channel type (not per-account) */
export interface ChannelType {
  /** Channel type key — mirrors Rust `channel_type::*` */
  type: ChannelTypeKey;
  /** i18n label key */
  labelKey: string;
}

/** Connection status for a channel instance */
export type ChannelConnectionStatus =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "error"
  | "disabled"
  | "unknown";

export const STATUS_I18N_KEY: Record<ChannelConnectionStatus, string> = {
  connected: "integrations.connected",
  connecting: "integrations.connecting",
  reconnecting: "integrations.reconnecting",
  error: "integrations.connectionError",
  disabled: "integrations.disabled",
  unknown: "integrations.disabled",
};

export const STATUS_TEXT_COLOR: Record<ChannelConnectionStatus, string> = {
  connected: "text-success-6",
  connecting: "text-warning-6",
  reconnecting: "text-warning-6",
  error: "text-danger-6",
  disabled: "text-text-3",
  unknown: "text-text-3",
};

export const STATUS_DOT_COLOR: Record<ChannelConnectionStatus, string> = {
  connected: "bg-success-6",
  connecting: "bg-warning-6",
  reconnecting: "bg-warning-6",
  error: "bg-danger-6",
  disabled: "bg-fill-3",
  unknown: "bg-fill-3",
};

/** A specific account instance displayed in the left panel */
export interface ChannelInstance {
  /** Channel type (e.g. "telegram") */
  type: string;
  /** Account identifier (e.g. "default", "work") */
  accountId: string;
  /** Whether this account is enabled */
  enabled: boolean;
  /** Live connection status derived from gateway status polling */
  connectionStatus: ChannelConnectionStatus;
  /** Error message when connectionStatus is "error" */
  connectionError?: string;
}

/** Shared props for all per-channel config components */
export interface ChannelConfigProps {
  config: Record<string, unknown>;
  update: (path: string, value: unknown) => void;
  /** Config path prefix, e.g. "channels.telegram.accounts.default" */
  pathPrefix: string;
}

/** Selection state for the left panel */
export interface ChannelSelection {
  type: string;
  accountId: string;
}

/** Result from probing a channel's connectivity */
export interface ChannelProbeResult {
  ok: boolean;
  error?: string;
  /** Human-readable identity of the verified bot/service */
  identity?: string;
  elapsed_ms: number;
}
