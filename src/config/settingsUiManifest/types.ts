import type { ComponentType } from "react";

import type { RenderableIcon } from "@src/components/AnyIcon";
import type { SettingsKey } from "@src/config/settingsSchema";
import type { SettingsSectionSlotId } from "@src/config/settingsUiManifest/slotIds";

/**
 * Tab discriminator for {@link SETTINGS_UI_SECTIONS}. The Settings page
 * only ever queries `"app"` — the `"agent"` and `"integrations"` values
 * exist as parity-assertion placeholders so schema keys whose UI lives in
 * Agent Teams or Integrations still have matching "covered" manifest entries.
 */
export type SettingsTabId = "app" | "agent" | "integrations";

type SettingsFieldControlType =
  | "switch"
  | "select"
  | "number"
  | "slider"
  | "text"
  | "custom";

interface SettingsSelectOption {
  value: string | number;
  labelKey?: string;
  label?: string;
}

interface SettingsRowBase {
  id: string;
  labelKey: string;
  descriptionKey?: string;
  indent?: boolean;
  light?: boolean;
  visibleWhen?: {
    key: SettingsKey;
    equals: unknown;
  };
}

export interface SettingsFieldRow extends SettingsRowBase {
  kind: "field";
  key: SettingsKey;
  controlType: Exclude<SettingsFieldControlType, "custom">;
  options?: SettingsSelectOption[];
  min?: number;
  max?: number;
  step?: number;
  noPadding?: boolean;
}

interface SettingsCustomRow extends SettingsRowBase {
  kind: "custom";
  customSlotId: string;
  /** Render slot directly without SectionRow wrapper */
  raw?: boolean;
}

type SettingsRowDefinition = SettingsFieldRow | SettingsCustomRow;

export interface SettingsContainerDefinition {
  id: string;
  titleKey?: string;
  rows: SettingsRowDefinition[];
  /** Render rows directly without SectionContainer wrapper */
  raw?: boolean;
}

export interface SettingsSectionDefinition {
  id: string;
  tab: SettingsTabId;
  labelKey: string;
  headingTitleKey: string;
  /** Glyph data or a brand component — render via `AnyIcon`. */
  icon: RenderableIcon;
  containers?: SettingsContainerDefinition[];
  customSectionSlotId?: SettingsSectionSlotId;
  /**
   * Used by parity checks for sections still rendered by custom slots.
   * Keep this list explicit until the section is fully declarative.
   */
  coveredKeys?: SettingsKey[];
}

interface SettingsCustomSectionSlotProps {
  activeTab?: string;
}

export type SettingsCustomSectionSlot =
  ComponentType<SettingsCustomSectionSlotProps>;
export type SettingsCustomRowSlot = ComponentType<{
  sectionId: string;
  rowId: string;
}>;
