import type { SettingDefinition, SettingsCategory } from "../types";
import { AGENT_SETTINGS_REGISTRY } from "./agent";
import { AGENT_BROWSER_SETTINGS_REGISTRY } from "./agentBrowser";
import { CHAT_SETTINGS_REGISTRY } from "./chat";
import { EDITOR_SETTINGS_REGISTRY } from "./editor";
import { GENERAL_SETTINGS_REGISTRY } from "./general";
import { GIT_SETTINGS_REGISTRY } from "./git";
import { HOUSEKEEPER_SETTINGS_REGISTRY } from "./housekeeper";
import { MOBILE_REMOTE_SETTINGS_REGISTRY } from "./mobileRemote";
import { NETWORK_SETTINGS_REGISTRY } from "./network";
import { NOTIFICATIONS_SETTINGS_REGISTRY } from "./notifications";
import { PRIVACY_SETTINGS_REGISTRY } from "./privacy";
import { TERMINAL_SETTINGS_REGISTRY } from "./terminal";
import { WORKSPACE_SETTINGS_REGISTRY } from "./workspace";

export const SETTINGS_REGISTRY = {
  ...GENERAL_SETTINGS_REGISTRY,
  ...EDITOR_SETTINGS_REGISTRY,
  ...TERMINAL_SETTINGS_REGISTRY,
  ...NOTIFICATIONS_SETTINGS_REGISTRY,
  ...CHAT_SETTINGS_REGISTRY,
  ...GIT_SETTINGS_REGISTRY,
  ...WORKSPACE_SETTINGS_REGISTRY,
  ...AGENT_SETTINGS_REGISTRY,
  ...AGENT_BROWSER_SETTINGS_REGISTRY,
  ...HOUSEKEEPER_SETTINGS_REGISTRY,
  ...NETWORK_SETTINGS_REGISTRY,
  ...PRIVACY_SETTINGS_REGISTRY,
  ...MOBILE_REMOTE_SETTINGS_REGISTRY,
} as const satisfies Record<string, SettingDefinition>;

export const SETTINGS_CATEGORY_LABELS: Record<SettingsCategory, string> = {
  general: "General",
  editor: "Editor",
  terminal: "Terminal",
  notifications: "Notifications",
  chat: "Chat Appearance",
  workspace: "Workspace",
  git: "Git",
  agent: "Agent",
  agentBrowser: "Computer Use",
  housekeeper: "MiniCPM Housekeeper",
  network: "Network",
  privacy: "Privacy",
  mobileRemote: "Mobile Remote",
};
