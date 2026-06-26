/**
 * Config Atoms
 *
 * Configuration state for UI preferences and settings.
 * Backed by the central settings system (~/.orgii/settings.jsonc).
 */
import { atom } from "jotai";

import { WORKSPACE_DEFAULT_REPO_LOCATION } from "@src/config/workspaceDefaultRepoPaths";
import type { WorkspaceDefaultRepoLocation } from "@src/config/workspaceDefaultRepoPaths";
import {
  settingsAtom,
  updateSettingAtom,
  updateSettingsBatchAtom,
} from "@src/store/settings/settingsAtom";

// ============================================
// Workspace Defaults Settings (backed by settings.jsonc)
// ============================================

export const workspaceDefaultRepoLocationAtom = atom(
  (get) =>
    get(settingsAtom)[
      "workspace.defaultRepoLocation"
    ] as WorkspaceDefaultRepoLocation,
  (_get, set, value: WorkspaceDefaultRepoLocation) => {
    set(updateSettingAtom, { key: "workspace.defaultRepoLocation", value });
  }
);
workspaceDefaultRepoLocationAtom.debugLabel =
  "workspaceDefaultRepoLocationAtom";

export const workspaceCustomDefaultRepoPathAtom = atom(
  (get) => get(settingsAtom)["workspace.customDefaultRepoPath"],
  (_get, set, value: string) => {
    set(updateSettingAtom, { key: "workspace.customDefaultRepoPath", value });
  }
);
workspaceCustomDefaultRepoPathAtom.debugLabel =
  "workspaceCustomDefaultRepoPathAtom";

export const effectiveWorkspaceDefaultRepoLocationAtom = atom((get) => {
  const location = get(workspaceDefaultRepoLocationAtom);
  if (
    location === WORKSPACE_DEFAULT_REPO_LOCATION.CUSTOM &&
    !get(workspaceCustomDefaultRepoPathAtom).trim()
  ) {
    return WORKSPACE_DEFAULT_REPO_LOCATION.DOCUMENTS_ORGII;
  }
  return location;
});
effectiveWorkspaceDefaultRepoLocationAtom.debugLabel =
  "effectiveWorkspaceDefaultRepoLocationAtom";

// ============================================
// Internal UI Editor Config
// ============================================

export interface InternalUIEditorConfig {
  workspacePath: string;
}

export const internalUIEditorConfigAtom = atom<InternalUIEditorConfig>({
  workspacePath: "",
});
internalUIEditorConfigAtom.debugLabel = "internalUIEditorConfigAtom";

// ============================================
// Chat Appearance Settings
// ============================================

export interface ChatAppearanceSettings {
  /** Font size in pixels (10-16) */
  fontSize: number;
  /** Code block font size in pixels (10-16) */
  codeFontSize: number;
  /** Line height multiplier (1.2 - 2.0) */
  lineHeight: number;
  /** Enable typing effect animation */
  typingEffectEnabled: boolean;
  /** Typing speed in milliseconds per character */
  typingSpeed: number;
  /** Enable decrypt text animation effect */
  decryptEffectEnabled: boolean;
  /** Send messages with Enter instead of Ctrl/Cmd+Enter */
  sendOnEnter: boolean;
}

export const DEFAULT_CHAT_APPEARANCE: ChatAppearanceSettings = {
  fontSize: 14,
  codeFontSize: 13,
  lineHeight: 1.6,
  typingEffectEnabled: true,
  typingSpeed: 5,
  decryptEffectEnabled: false,
  sendOnEnter: false,
};

/** Chat appearance derived from central settings */
export const chatAppearanceAtom = atom<ChatAppearanceSettings>((get) => {
  const settings = get(settingsAtom);
  return {
    fontSize: settings["chat.fontSize"] ?? DEFAULT_CHAT_APPEARANCE.fontSize,
    codeFontSize:
      settings["chat.codeFontSize"] ?? DEFAULT_CHAT_APPEARANCE.codeFontSize,
    lineHeight:
      settings["chat.lineHeight"] ?? DEFAULT_CHAT_APPEARANCE.lineHeight,
    typingEffectEnabled:
      settings["chat.typingEffectEnabled"] ??
      DEFAULT_CHAT_APPEARANCE.typingEffectEnabled,
    typingSpeed:
      settings["chat.typingSpeed"] ?? DEFAULT_CHAT_APPEARANCE.typingSpeed,
    decryptEffectEnabled:
      settings["chat.decryptEffectEnabled"] ??
      DEFAULT_CHAT_APPEARANCE.decryptEffectEnabled,
    sendOnEnter:
      settings["chat.sendOnEnter"] ?? DEFAULT_CHAT_APPEARANCE.sendOnEnter,
  };
});
chatAppearanceAtom.debugLabel = "chatAppearanceAtom";

/** Persisted chat appearance atom - saves to settings.jsonc */
export const chatAppearancePersistAtom = atom(
  (get) => get(chatAppearanceAtom),
  (get, set, value: Partial<ChatAppearanceSettings>) => {
    const prev = get(chatAppearanceAtom);
    const merged = { ...prev, ...value };
    set(updateSettingsBatchAtom, {
      "chat.fontSize": merged.fontSize,
      "chat.codeFontSize": merged.codeFontSize,
      "chat.lineHeight": merged.lineHeight,
      "chat.typingEffectEnabled": merged.typingEffectEnabled,
      "chat.typingSpeed": merged.typingSpeed,
      "chat.decryptEffectEnabled": merged.decryptEffectEnabled,
      "chat.sendOnEnter": merged.sendOnEnter,
    });
  }
);
chatAppearancePersistAtom.debugLabel = "chatAppearancePersistAtom";

// ============================================
// Focused Layout Atoms (selectAtom)
// ChatHistory only needs layout props — subscribing to the full
// chatAppearanceAtom re-renders on animation setting changes too.
// ============================================

/** Font size only — avoids re-render on unrelated settings */
export const chatFontSizeAtom = atom(
  (get) => get(chatAppearanceAtom).fontSize ?? DEFAULT_CHAT_APPEARANCE.fontSize
);
chatFontSizeAtom.debugLabel = "chatFontSizeAtom";

/** Code font size only */
export const chatCodeFontSizeAtom = atom(
  (get) =>
    get(chatAppearanceAtom).codeFontSize ?? DEFAULT_CHAT_APPEARANCE.codeFontSize
);
chatCodeFontSizeAtom.debugLabel = "chatCodeFontSizeAtom";

/** Line height only */
export const chatLineHeightAtom = atom(
  (get) =>
    get(chatAppearanceAtom).lineHeight ?? DEFAULT_CHAT_APPEARANCE.lineHeight
);
chatLineHeightAtom.debugLabel = "chatLineHeightAtom";
