import { Braces, Palette, RotateCcw } from "lucide-react";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Checkbox from "@src/components/Checkbox";
import Radio from "@src/components/Radio";
import type { RadioValue } from "@src/components/Radio";
import TabPill from "@src/components/TabPill";
import type { ChatRetryKind } from "@src/engines/ChatPanel/components/ChatStatusBanners";

import type {
  PlaygroundListSelectionMode,
  PlaygroundVariant,
  PreviewMode,
} from "../types";

const PLAYGROUND_SIDEBAR_SECTION = "flex min-h-0 min-w-0 flex-col gap-2";
const PLAYGROUND_SIDEBAR_SECTION_DIVIDER = "mt-2 border-t border-border-2 pt-2";
const PLAYGROUND_SIDEBAR_FIELD_LABEL = "text-[12px] font-medium text-text-2";
const PLAYGROUND_SIDEBAR_SCROLL = "min-h-0 overflow-y-auto scrollbar-hide";
const PLAYGROUND_SIDEBAR_SCROLL_COMPACT = `h-[140px] max-h-[140px] shrink-0 ${PLAYGROUND_SIDEBAR_SCROLL}`;

interface PlaygroundSidebarShellProps {
  children: React.ReactNode;
}

export function PlaygroundSidebarShell({
  children,
}: PlaygroundSidebarShellProps) {
  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg bg-primary-container p-2">
      {children}
    </aside>
  );
}

interface TabLike {
  key: string;
  label: string;
  disabled?: boolean;
}

interface PlaygroundSidebarHeaderProps {
  mode: PreviewMode;
  onModeChange: (mode: PreviewMode) => void;
  modeTabs: TabLike[];
  variantTabs: TabLike[];
  selectedVariant: PlaygroundVariant;
  onVariantChange: (variant: PlaygroundVariant) => void;
  onReset: () => void;
  tokenPanelOpen?: boolean;
  onToggleTokenPanel?: () => void;
  jsonPanelOpen?: boolean;
  onToggleJsonPanel?: () => void;
}

export function PlaygroundSidebarHeader({
  mode,
  onModeChange,
  modeTabs,
  variantTabs,
  selectedVariant,
  onVariantChange,
  onReset,
  tokenPanelOpen,
  onToggleTokenPanel,
  jsonPanelOpen,
  onToggleJsonPanel,
}: PlaygroundSidebarHeaderProps) {
  const { t } = useTranslation("integrations");
  return (
    <div className={`${PLAYGROUND_SIDEBAR_SECTION} shrink-0`}>
      <label className={PLAYGROUND_SIDEBAR_FIELD_LABEL}>
        {t("devTools.preview")}
      </label>
      <div className="flex flex-col gap-2">
        <TabPill
          tabs={modeTabs}
          activeTab={mode}
          onChange={(key) => onModeChange(key as PreviewMode)}
          variant="pill"
          color="fill"
          fillWidth={false}
          size="small"
        />
        <TabPill
          tabs={variantTabs}
          activeTab={selectedVariant}
          onChange={(tab: string) => onVariantChange(tab as PlaygroundVariant)}
          variant="pill"
          color="fill"
          fillWidth={false}
          size="small"
        />
        <div className="flex items-center justify-start gap-1">
          {onToggleJsonPanel && (
            <Button
              variant={jsonPanelOpen ? "primary" : "secondary"}
              size="small"
              htmlType="button"
              icon={<Braces size={12} />}
              iconOnly
              title="JSON"
              onClick={onToggleJsonPanel}
            />
          )}
          {onToggleTokenPanel && (
            <Button
              variant={tokenPanelOpen ? "primary" : "secondary"}
              size="small"
              htmlType="button"
              icon={<Palette size={12} />}
              iconOnly
              title="Tokens"
              onClick={onToggleTokenPanel}
            />
          )}
          <Button
            size="small"
            htmlType="button"
            icon={<RotateCcw size={12} />}
            iconOnly
            title={t("devTools.reset")}
            onClick={onReset}
          />
        </div>
      </div>
    </div>
  );
}

interface PlaygroundStatusPresetRow {
  key: string;
  label: string;
}

interface PlaygroundStatusPresetSectionProps {
  presets: PlaygroundStatusPresetRow[];
  activePresetKey: string;
  onPresetChange: (key: string) => void;
  selectionMode: PlaygroundListSelectionMode;
  onSelectionModeChange: (mode: PlaygroundListSelectionMode) => void;
  selectedPresetKeys: string[];
  onPresetToggle: (key: string, checked: boolean) => void;
}

export function PlaygroundStatusPresetSection({
  presets,
  activePresetKey,
  onPresetChange,
  selectionMode,
  onSelectionModeChange,
  selectedPresetKeys,
  onPresetToggle,
}: PlaygroundStatusPresetSectionProps) {
  const { t } = useTranslation("integrations");
  const selectionTabs: TabLike[] = useMemo(
    () => [
      { key: "single", label: t("devTools.selectionModeSingle") },
      { key: "multiple", label: t("devTools.selectionModeMultiple") },
    ],
    [t]
  );
  return (
    <div
      className={`${PLAYGROUND_SIDEBAR_SECTION} ${PLAYGROUND_SIDEBAR_SECTION_DIVIDER}`}
    >
      <div className="flex items-center justify-between gap-2">
        <label className={PLAYGROUND_SIDEBAR_FIELD_LABEL}>
          {t("devTools.status")}
        </label>
        <TabPill
          tabs={selectionTabs}
          activeTab={selectionMode}
          onChange={(key) =>
            onSelectionModeChange(key as PlaygroundListSelectionMode)
          }
          variant="pill"
          color="fill"
          fillWidth={false}
          size="small"
        />
      </div>
      <div className={PLAYGROUND_SIDEBAR_SCROLL_COMPACT}>
        {selectionMode === "single" ? (
          <Radio.Group
            value={activePresetKey}
            onChange={(value: RadioValue) => onPresetChange(String(value))}
            direction="vertical"
            size="small"
            className="flex flex-col gap-2"
          >
            {presets.map((preset) => (
              <Radio key={preset.key} value={preset.key}>
                {preset.label}
              </Radio>
            ))}
          </Radio.Group>
        ) : (
          <div className="flex flex-col gap-2">
            {presets.map((preset) => (
              <Checkbox
                key={preset.key}
                checked={selectedPresetKeys.includes(preset.key)}
                onChange={(checked) => onPresetToggle(preset.key, checked)}
                size="small"
              >
                <span className="text-[13px] text-text-1">{preset.label}</span>
              </Checkbox>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface PlaygroundToolTypeSectionProps {
  children: React.ReactNode;
  title?: string;
  searchSlot?: React.ReactNode;
  selectionMode: PlaygroundListSelectionMode;
  onSelectionModeChange: (mode: PlaygroundListSelectionMode) => void;
  selectionModeVisible?: boolean;
}

export function PlaygroundToolTypeSection({
  children,
  title,
  searchSlot,
  selectionMode,
  onSelectionModeChange,
  selectionModeVisible = true,
}: PlaygroundToolTypeSectionProps) {
  const { t } = useTranslation("integrations");
  const selectionTabs: TabLike[] = useMemo(
    () => [
      { key: "single", label: t("devTools.selectionModeSingle") },
      { key: "multiple", label: t("devTools.selectionModeMultiple") },
    ],
    [t]
  );
  return (
    <div
      className={`${PLAYGROUND_SIDEBAR_SECTION} min-h-0 flex-1 ${PLAYGROUND_SIDEBAR_SECTION_DIVIDER}`}
    >
      <div className="flex items-center justify-between gap-2">
        <label className={PLAYGROUND_SIDEBAR_FIELD_LABEL}>
          {title ?? t("devTools.toolType")}
        </label>
        {selectionModeVisible && (
          <TabPill
            tabs={selectionTabs}
            activeTab={selectionMode}
            onChange={(key) =>
              onSelectionModeChange(key as PlaygroundListSelectionMode)
            }
            variant="pill"
            color="fill"
            fillWidth={false}
            size="small"
          />
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
        {searchSlot && <div className="shrink-0">{searchSlot}</div>}
        <div className={`min-h-0 flex-1 ${PLAYGROUND_SIDEBAR_SCROLL}`}>
          {children}
        </div>
      </div>
    </div>
  );
}

// ============================================
// Command picker (tool actions / subcommands)
// ============================================

export interface PlaygroundCommandPickerSectionProps {
  actions: ReadonlyArray<{ name: string; summary: string; layout?: string[] }>;
  selectionMode: PlaygroundListSelectionMode;
  onSelectionModeChange: (mode: PlaygroundListSelectionMode) => void;
  selectedCommand: string;
  selectedCommands: string[];
  onSingleSelect: (commandName: string) => void;
  onMultiToggle: (commandName: string, checked: boolean) => void;
}

export function PlaygroundCommandPickerSection({
  actions,
  selectionMode,
  onSelectionModeChange,
  selectedCommand,
  selectedCommands,
  onSingleSelect,
  onMultiToggle,
}: PlaygroundCommandPickerSectionProps) {
  const { t } = useTranslation("integrations");
  const selectionTabs: TabLike[] = useMemo(
    () => [
      { key: "single", label: t("devTools.selectionModeSingle") },
      { key: "multiple", label: t("devTools.selectionModeMultiple") },
    ],
    [t]
  );
  if (actions.length === 0) return null;
  return (
    <div
      className={`${PLAYGROUND_SIDEBAR_SECTION} ${PLAYGROUND_SIDEBAR_SECTION_DIVIDER}`}
    >
      <div className="flex items-center justify-between gap-2">
        <label className={PLAYGROUND_SIDEBAR_FIELD_LABEL}>
          {t("devTools.commands")}
        </label>
        <TabPill
          tabs={selectionTabs}
          activeTab={selectionMode}
          onChange={(key) =>
            onSelectionModeChange(key as PlaygroundListSelectionMode)
          }
          variant="pill"
          color="fill"
          fillWidth={false}
          size="small"
        />
      </div>
      <div className={PLAYGROUND_SIDEBAR_SCROLL_COMPACT}>
        {selectionMode === "single" ? (
          <Radio.Group
            value={selectedCommand}
            onChange={(value: RadioValue) => onSingleSelect(String(value))}
            direction="vertical"
            size="small"
            className="flex flex-col gap-2"
          >
            {actions.map((action) => (
              <Radio key={action.name} value={action.name}>
                <span className="flex items-center gap-1.5">
                  <span className="text-[13px] text-text-1">{action.name}</span>
                  {action.layout && action.layout.length > 0 && (
                    <span className="flex gap-0.5">
                      {action.layout.map((slot) => (
                        <span
                          key={slot}
                          className="rounded bg-fill-3 px-1 py-px text-[10px] text-text-3"
                        >
                          {slot}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </Radio>
            ))}
          </Radio.Group>
        ) : (
          <div className="flex flex-col gap-2">
            {actions.map((action) => (
              <Checkbox
                key={action.name}
                checked={selectedCommands.includes(action.name)}
                onChange={(checked) => onMultiToggle(action.name, checked)}
                size="small"
              >
                <span className="flex items-center gap-1.5">
                  <span className="text-[13px] text-text-1">{action.name}</span>
                  {action.layout && action.layout.length > 0 && (
                    <span className="flex gap-0.5">
                      {action.layout.map((slot) => (
                        <span
                          key={slot}
                          className="rounded bg-fill-3 px-1 py-px text-[10px] text-text-3"
                        >
                          {slot}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </Checkbox>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================
// Chat Extras toggles
// ============================================

export interface PlaygroundChatExtras {
  showQueuedMessages: boolean;
  showTerminalProcesses: boolean;
  showFileReview: boolean;
  showModeSwitch?: boolean;
  retryKinds?: ChatRetryKind[];
  showInterventionBanner?: boolean;
  showPausedBanner?: boolean;
}

interface PlaygroundChatExtrasSectionProps {
  extras: PlaygroundChatExtras;
  onToggle: (key: keyof PlaygroundChatExtras, value: boolean) => void;
}

export function PlaygroundChatExtrasSection({
  extras,
  onToggle,
}: PlaygroundChatExtrasSectionProps) {
  const { t } = useTranslation("integrations");
  return (
    <div
      className={`${PLAYGROUND_SIDEBAR_SECTION} ${PLAYGROUND_SIDEBAR_SECTION_DIVIDER}`}
    >
      <label className={PLAYGROUND_SIDEBAR_FIELD_LABEL}>
        {t("devTools.chatExtras")}
      </label>
      <div className={PLAYGROUND_SIDEBAR_SCROLL_COMPACT}>
        <div className="flex flex-col gap-2">
          <Checkbox
            checked={extras.showQueuedMessages}
            onChange={(checked) => onToggle("showQueuedMessages", checked)}
            size="small"
          >
            <span className="text-[13px] text-text-2">
              {t("devTools.queuedMessages")}
            </span>
          </Checkbox>
          <Checkbox
            checked={extras.showTerminalProcesses}
            onChange={(checked) => onToggle("showTerminalProcesses", checked)}
            size="small"
          >
            <span className="text-[13px] text-text-2">
              {t("devTools.terminalProcesses")}
            </span>
          </Checkbox>
          <Checkbox
            checked={extras.showFileReview}
            onChange={(checked) => onToggle("showFileReview", checked)}
            size="small"
          >
            <span className="text-[13px] text-text-2">
              {t("devTools.fileReview")}
            </span>
          </Checkbox>
        </div>
      </div>
    </div>
  );
}

// ============================================
// Preview main area
// ============================================

interface PlaygroundPreviewMainAreaProps {
  jsonVisible: boolean;
  overrideClassName: string;
  overrideStyles: React.CSSProperties;
  jsonInput: string;
  onJsonChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  jsonPlaceholder: string;
  renderPreviewContent: () => React.ReactNode;
}

export function PlaygroundPreviewMainArea({
  jsonVisible,
  overrideClassName,
  overrideStyles,
  jsonInput,
  onJsonChange,
  jsonPlaceholder,
  renderPreviewContent,
}: PlaygroundPreviewMainAreaProps) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className={
          jsonVisible
            ? "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4"
            : "flex min-h-0 flex-1 flex-col"
        }
      >
        {jsonVisible && (
          <textarea
            className="box-border min-h-[200px] w-full min-w-0 flex-1 resize-none rounded-md border border-border-2 bg-fill-2 p-2.5 text-[12px] leading-normal text-text-1 placeholder:text-text-4 focus:border-primary-6 focus:outline-none"
            value={jsonInput}
            onChange={onJsonChange}
            placeholder={jsonPlaceholder}
            spellCheck={false}
          />
        )}
        <div
          className={`flex min-h-0 flex-1 flex-col ${overrideClassName}`}
          style={overrideStyles}
        >
          {renderPreviewContent()}
        </div>
      </div>
    </div>
  );
}
