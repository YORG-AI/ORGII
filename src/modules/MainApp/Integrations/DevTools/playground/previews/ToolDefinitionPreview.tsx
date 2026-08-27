/**
 * ToolDefinitionPreview
 *
 * Loads tools from the Rust registry (`list_all_tools`) and reuses the same
 * sidebar + chat/simulator layout as SingleEventPreview, including
 * single / multiple selection for the tool list.
 */
import { Search } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import type { ToolInfo } from "@src/api/tauri/rpc/schemas/tools";
import Input from "@src/components/Input";
import { Placeholder } from "@src/components/Placeholder";
import type { EventDisplayStatus } from "@src/engines/SessionCore/core/types";
import { getCliUiCanonical } from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import type { ToolActionEntry } from "@src/modules/MainApp/Integrations/BuiltInTools/types";
import { useUnifiedToolsMetadata } from "@src/modules/MainApp/Integrations/BuiltInTools/useUnifiedToolsMetadata";
import { createPlaygroundEventForToolName } from "@src/modules/MainApp/ToolPreview/mockData";

import {
  type ModeControlProps,
  useModeTabsDefinition,
  usePlaygroundTokenOverrides,
  usePlaygroundVariantTabs,
} from "../hooks";
import {
  PlaygroundCommandPickerSection,
  PlaygroundPreviewMainArea,
  PlaygroundSidebarHeader,
  PlaygroundSidebarShell,
  PlaygroundStatusPresetSection,
  PlaygroundToolTypeSection,
  TokenOverridePanel,
} from "../panels";
import { SingleEventPreviewContent } from "../single-event/SingleEventPreviewContent";
import {
  COMMAND_STATUS_PRESETS,
  DEFAULT_STATUS_PRESETS,
  type StatusPreset,
  resolveStatusPresets,
} from "../single-event/statusPresets";
import {
  type PlaygroundListSelectionMode,
  type PlaygroundVariant,
} from "../types";
import { ToolDefinitionTypeList } from "./ToolDefinitionTypeList";
import { useToolDefinitionPreviewEvents } from "./useToolDefinitionPreviewEvents";

function toolInfoToEventJson(tool: ToolInfo): string {
  return JSON.stringify(
    createPlaygroundEventForToolName(tool.name, "completed"),
    null,
    2
  );
}

export function ToolDefinitionPreview({
  mode,
  onModeChange,
}: ModeControlProps) {
  const { t } = useTranslation("integrations");
  const modeTabs = useModeTabsDefinition();

  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [tokenPanelOpen, setTokenPanelOpen] = useState(false);
  const toggleTokenPanel = useCallback(
    () => setTokenPanelOpen((prev) => !prev),
    []
  );
  const [jsonPanelOpen, setJsonPanelOpen] = useState(false);
  const toggleJsonPanel = useCallback(
    () => setJsonPanelOpen((prev) => !prev),
    []
  );

  useEffect(() => {
    let cancelled = false;
    rpc.tools
      .listAllTools()
      .then((result) => {
        if (cancelled) return;
        setTools(result);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const { rawTools } = useUnifiedToolsMetadata();
  const actionsMap = useMemo(() => {
    const map = new Map<string, ToolActionEntry[]>();
    for (const tool of rawTools) {
      if (tool.actions && tool.actions.length > 0) {
        map.set(tool.name, tool.actions);
      }
    }
    return map;
  }, [rawTools]);

  const [selectedCommands, setSelectedCommands] = useState<string[]>([]);
  const [selectedSingleCommand, setSelectedSingleCommand] =
    useState<string>("");
  const [commandSelectionMode, setCommandSelectionMode] =
    useState<PlaygroundListSelectionMode>("single");

  const {
    fontSizePreset,
    setFontSizePreset,
    spacingPreset,
    setSpacingPreset,
    radiusPreset,
    setRadiusPreset,
    handleResetTokens,
    overrideStyles,
    overrideClassName,
  } = usePlaygroundTokenOverrides();

  const [listSelectionMode, setListSelectionMode] =
    useState<PlaygroundListSelectionMode>("single");
  const [selectedType, setSelectedType] = useState<string>("");
  const [selectedTypesMulti, setSelectedTypesMulti] = useState<string[]>([]);
  const [selectedStatus, setSelectedStatus] =
    useState<EventDisplayStatus>("completed");
  const [activePresetKey, setActivePresetKey] = useState<string>("completed");
  const [statusSelectionMode, setStatusSelectionMode] =
    useState<PlaygroundListSelectionMode>("single");
  const [selectedPresetKeys, setSelectedPresetKeys] = useState<string[]>([
    "completed",
  ]);
  const handleStatusPresetToggle = useCallback(
    (key: string, checked: boolean) => {
      setSelectedPresetKeys((prev) => {
        if (checked) {
          return prev.includes(key) ? prev : [...prev, key];
        }
        return prev.filter((item) => item !== key);
      });
    },
    []
  );
  const [selectedVariant, setSelectedVariant] =
    useState<PlaygroundVariant>("chat");
  const [jsonInput, setJsonInput] = useState<string>("{}");

  const currentActions = useMemo(
    () => actionsMap.get(selectedType) ?? [],
    [actionsMap, selectedType]
  );

  const handleCommandToggle = useCallback(
    (commandName: string, checked: boolean) => {
      setSelectedCommands((prev) => {
        if (checked) {
          return prev.includes(commandName) ? prev : [...prev, commandName];
        }
        return prev.filter((name) => name !== commandName);
      });
    },
    []
  );

  const handleSingleCommandSelect = useCallback(
    (commandName: string) => {
      setSelectedSingleCommand(commandName);
      const canonical = getCliUiCanonical(selectedType);
      const hasCommandTable =
        Boolean(COMMAND_STATUS_PRESETS[selectedType]) ||
        Boolean(COMMAND_STATUS_PRESETS[canonical]);
      if (!hasCommandTable) return;
      let presets = resolveStatusPresets(selectedType, commandName);
      if (presets === DEFAULT_STATUS_PRESETS && canonical !== selectedType) {
        presets = resolveStatusPresets(canonical, commandName);
      }
      const firstPreset = presets[0];
      if (firstPreset) {
        setActivePresetKey(firstPreset.key);
        setSelectedStatus(firstPreset.status);
        setSelectedPresetKeys([firstPreset.key]);
      }
    },
    [selectedType]
  );

  const [toolTypeFilter, setToolTypeFilter] = useState("");

  const isMultiSelect = listSelectionMode === "multiple";

  const normalizedToolTypeFilter = toolTypeFilter.trim().toLowerCase();

  const filteredTools = useMemo(() => {
    if (!normalizedToolTypeFilter) return tools;
    return tools.filter((tool) =>
      tool.name.toLowerCase().includes(normalizedToolTypeFilter)
    );
  }, [tools, normalizedToolTypeFilter]);

  const displayToolsSingle = useMemo(() => {
    if (!normalizedToolTypeFilter) return filteredTools;
    if (filteredTools.some((tool) => tool.name === selectedType))
      return filteredTools;
    const selectedTool = tools.find((tool) => tool.name === selectedType);
    if (selectedTool) return [selectedTool, ...filteredTools];
    return filteredTools;
  }, [filteredTools, normalizedToolTypeFilter, selectedType, tools]);

  const applyToolSelection = useCallback(
    (toolName: string) => {
      setSelectedType(toolName);
      const tool = tools.find((item) => item.name === toolName);
      if (tool) {
        setJsonInput(toolInfoToEventJson(tool));
      }
      const newActions = actionsMap.get(toolName) ?? [];
      setSelectedCommands(newActions.map((action) => action.name));
      const firstCommand = newActions[0]?.name ?? "";
      setSelectedSingleCommand(firstCommand);
      let presets = resolveStatusPresets(toolName, firstCommand);
      if (presets === DEFAULT_STATUS_PRESETS) {
        const canonical = getCliUiCanonical(toolName);
        if (canonical !== toolName) {
          presets = resolveStatusPresets(canonical, firstCommand);
        }
      }
      const firstPreset = presets[0];
      if (firstPreset) {
        setActivePresetKey(firstPreset.key);
        setSelectedStatus(firstPreset.status);
        setSelectedPresetKeys([firstPreset.key]);
      }
    },
    [tools, actionsMap]
  );

  useEffect(() => {
    if (tools.length === 0 || selectedType) return;
    const first = tools[0];
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setSelectedTypesMulti([first.name]);
      applyToolSelection(first.name);
    });
    return () => {
      cancelled = true;
    };
  }, [tools, selectedType, applyToolSelection]);

  const statusPresetsForTool = useMemo<StatusPreset[]>(() => {
    if (!selectedType) return DEFAULT_STATUS_PRESETS;
    const commandKey =
      commandSelectionMode === "single" ? selectedSingleCommand : undefined;
    const directHit = resolveStatusPresets(selectedType, commandKey);
    if (directHit !== DEFAULT_STATUS_PRESETS) return directHit;
    const canonical = getCliUiCanonical(selectedType);
    if (canonical === selectedType) return directHit;
    return resolveStatusPresets(canonical, commandKey);
  }, [selectedType, commandSelectionMode, selectedSingleCommand]);

  useEffect(() => {
    if (statusPresetsForTool.length === 0) return;
    if (statusPresetsForTool.some((p) => p.key === activePresetKey)) return;
    const first = statusPresetsForTool[0];
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setActivePresetKey(first.key);
      setSelectedStatus(first.status);
      setSelectedPresetKeys((prev) => {
        const filtered = prev.filter((key) =>
          statusPresetsForTool.some((p) => p.key === key)
        );
        return filtered.length > 0 ? filtered : [first.key];
      });
    });
    return () => {
      cancelled = true;
    };
  }, [statusPresetsForTool, activePresetKey]);

  const {
    eventData,
    parseError,
    multiPreviewEvents,
    commandPreviewEvents,
    multiStatusPreviewEvents,
  } = useToolDefinitionPreviewEvents({
    isMultiSelect,
    selectedTypesMulti,
    selectedType,
    selectedStatus,
    jsonInput,
    commandSelectionMode,
    selectedSingleCommand,
    selectedCommands,
    statusSelectionMode,
    selectedPresetKeys,
    statusPresetsForTool,
    activePresetKey,
  });

  const handleListSelectionModeChange = useCallback(
    (next: PlaygroundListSelectionMode) => {
      if (next === "multiple") {
        setListSelectionMode("multiple");
        setSelectedTypesMulti((prev) => {
          if (prev.length > 0) return prev;
          const fallback = selectedType || tools[0]?.name;
          return fallback ? [fallback] : [];
        });
        setSelectedVariant("chat");
        setActivePresetKey("completed");
        setSelectedStatus("completed");
        setSelectedPresetKeys(["completed"]);
      } else {
        setListSelectionMode("single");
        const primary = selectedTypesMulti[0] ?? selectedType;
        applyToolSelection(primary);
      }
    },
    [applyToolSelection, selectedType, selectedTypesMulti, tools]
  );

  const handleMultiTypeToggle = useCallback(
    (toolName: string, checked: boolean) => {
      setSelectedTypesMulti((prev) => {
        if (checked) {
          if (prev.includes(toolName)) return prev;
          return [...prev, toolName];
        }
        return prev.filter((item) => item !== toolName);
      });
    },
    []
  );

  const handlePresetChange = useCallback(
    (key: string) => {
      const preset = statusPresetsForTool.find((p) => p.key === key);
      if (!preset) return;
      setActivePresetKey(key);
      setSelectedStatus(preset.status);
    },
    [statusPresetsForTool]
  );

  const handleJsonChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setJsonInput(event.target.value);
    },
    []
  );

  const handleResetPlayground = useCallback(() => {
    if (tools.length === 0) return;
    const first = tools[0];
    setListSelectionMode("single");
    setCommandSelectionMode("single");
    setStatusSelectionMode("single");
    setSelectedTypesMulti([first.name]);
    setSelectedVariant("chat");
    setToolTypeFilter("");
    applyToolSelection(first.name);
  }, [applyToolSelection, tools]);

  const variantTabs = usePlaygroundVariantTabs(isMultiSelect);

  const renderPreviewContent = () => (
    <SingleEventPreviewContent
      isMultiSelect={isMultiSelect}
      selectedTypesMulti={selectedTypesMulti}
      selectedVariant={selectedVariant}
      multiPreviewEvents={multiPreviewEvents}
      multiStatusPreviewEvents={multiStatusPreviewEvents}
      commandPreviewEvents={commandPreviewEvents}
      parseError={parseError}
      effectiveEventData={eventData}
    />
  );

  if (loading) {
    return (
      <div className="tool-event-single">
        <Placeholder variant="loading" />
      </div>
    );
  }

  return (
    <div className="tool-event-single relative min-h-0 flex-1">
      <div className="tool-event-single-with-sidebar gap-2">
        <PlaygroundSidebarShell>
          <PlaygroundSidebarHeader
            mode={mode}
            onModeChange={onModeChange}
            modeTabs={modeTabs}
            variantTabs={variantTabs}
            selectedVariant={selectedVariant}
            onVariantChange={setSelectedVariant}
            onReset={handleResetPlayground}
            tokenPanelOpen={tokenPanelOpen}
            onToggleTokenPanel={toggleTokenPanel}
            jsonPanelOpen={jsonPanelOpen}
            onToggleJsonPanel={toggleJsonPanel}
          />
          <PlaygroundToolTypeSection
            selectionMode={listSelectionMode}
            onSelectionModeChange={handleListSelectionModeChange}
            searchSlot={
              <Input
                value={toolTypeFilter}
                onChange={(value) => setToolTypeFilter(value)}
                placeholder={t("devTools.toolTypeFilterPlaceholder")}
                size="small"
                allowClear
                prefix={<Search size={14} className="text-text-3" />}
                aria-label={t("devTools.toolTypeFilterPlaceholder")}
              />
            }
          >
            <ToolDefinitionTypeList
              selectionMode={listSelectionMode}
              selectedType={selectedType}
              selectedTypesMulti={selectedTypesMulti}
              displayToolsSingle={displayToolsSingle}
              filteredTools={filteredTools}
              onSingleSelect={applyToolSelection}
              onMultiToggle={handleMultiTypeToggle}
            />
          </PlaygroundToolTypeSection>

          {!isMultiSelect && currentActions.length > 0 && (
            <PlaygroundCommandPickerSection
              actions={currentActions}
              selectionMode={commandSelectionMode}
              onSelectionModeChange={setCommandSelectionMode}
              selectedCommand={selectedSingleCommand}
              selectedCommands={selectedCommands}
              onSingleSelect={handleSingleCommandSelect}
              onMultiToggle={handleCommandToggle}
            />
          )}

          <PlaygroundStatusPresetSection
            presets={
              isMultiSelect ? DEFAULT_STATUS_PRESETS : statusPresetsForTool
            }
            activePresetKey={activePresetKey}
            onPresetChange={handlePresetChange}
            selectionMode={statusSelectionMode}
            onSelectionModeChange={setStatusSelectionMode}
            selectedPresetKeys={selectedPresetKeys}
            onPresetToggle={handleStatusPresetToggle}
          />
        </PlaygroundSidebarShell>

        <PlaygroundPreviewMainArea
          jsonVisible={jsonPanelOpen && !isMultiSelect}
          overrideClassName={overrideClassName}
          overrideStyles={overrideStyles}
          jsonInput={jsonInput}
          onJsonChange={handleJsonChange}
          jsonPlaceholder={t("devTools.activityDataPlaceholder")}
          renderPreviewContent={renderPreviewContent}
        />
      </div>

      <TokenOverridePanel
        isOpen={tokenPanelOpen}
        onClose={() => setTokenPanelOpen(false)}
        fontSizePreset={fontSizePreset}
        spacingPreset={spacingPreset}
        radiusPreset={radiusPreset}
        onFontSizeChange={setFontSizePreset}
        onSpacingChange={setSpacingPreset}
        onRadiusChange={setRadiusPreset}
        onReset={handleResetTokens}
      />
    </div>
  );
}
