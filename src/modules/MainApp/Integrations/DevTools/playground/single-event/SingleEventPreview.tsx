import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Input from "@src/components/Input";
import { CHAT_RETRY_KIND } from "@src/engines/ChatPanel/components/ChatStatusBanners";
import type { EventDisplayStatus } from "@src/engines/SessionCore/core/types";
import { getCliUiCanonical } from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import { HugeiconsIcon, Search01Icon } from "@src/icons";
import type { ToolActionEntry } from "@src/modules/MainApp/Integrations/BuiltInTools/types";
import { useUnifiedToolsMetadata } from "@src/modules/MainApp/Integrations/BuiltInTools/useUnifiedToolsMetadata";
import {
  MOCK_EVENT_DATA,
  SUBAGENT_PLAYGROUND_PRESETS,
  getAvailableEventTypes,
} from "@src/modules/MainApp/ToolPreview/mockData";

import {
  type ModeControlProps,
  useModeTabsDefinition,
  usePlaygroundTokenOverrides,
  usePlaygroundVariantTabs,
} from "../hooks";
import {
  type PlaygroundChatExtras,
  PlaygroundCommandPickerSection,
  PlaygroundPreviewMainArea,
  PlaygroundSidebarHeader,
  PlaygroundSidebarShell,
  PlaygroundStatusPresetSection,
  PlaygroundToolTypeSection,
  TokenOverridePanel,
} from "../panels";
import type { PlaygroundListSelectionMode, PlaygroundVariant } from "../types";
import { SingleEventPreviewContent } from "./SingleEventPreviewContent";
import { SingleEventTypeList } from "./SingleEventTypeList";
import {
  CHAT_PREVIEW_TYPE,
  CHAT_PREVIEW_TYPES,
  type ChatPreviewType,
  isChatPreviewType,
} from "./chatPreviewTypes";
import {
  COMMAND_STATUS_PRESETS,
  DEFAULT_STATUS_PRESETS,
  resolveStatusPresets,
  subagentSidebarStatusPresets,
} from "./statusPresets";
import { useSingleEventPreviewEvents } from "./useSingleEventPreviewEvents";

const DEFAULT_INPUT_PREVIEW_TYPES: ChatPreviewType[] = [
  CHAT_PREVIEW_TYPE.QUEUED,
  CHAT_PREVIEW_TYPE.TERMINAL,
  CHAT_PREVIEW_TYPE.REVIEW,
];

export function SingleEventPreview({ mode, onModeChange }: ModeControlProps) {
  const { t } = useTranslation("integrations");
  const modeTabs = useModeTabsDefinition();
  const isInputMode = mode === "input";
  const eventTypes = useMemo(() => getAvailableEventTypes(), []);
  const { rawTools } = useUnifiedToolsMetadata();
  const actionsMap = useMemo(() => {
    const map = new Map<string, ToolActionEntry[]>();
    for (const tool of rawTools) {
      if (tool.actions && tool.actions.length > 0) {
        map.set(tool.name, tool.actions);
        const uiName = getCliUiCanonical(tool.name);
        if (uiName !== tool.name) {
          map.set(uiName, tool.actions);
        }
      }
    }
    return map;
  }, [rawTools]);
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
    useState<PlaygroundListSelectionMode>("multiple");
  const [commandSelectionMode, setCommandSelectionMode] =
    useState<PlaygroundListSelectionMode>("single");
  const [selectedType, setSelectedType] = useState<string>(
    eventTypes[0] || "read_file"
  );
  const [selectedTypesMulti, setSelectedTypesMulti] = useState<string[]>(() =>
    mode === "input" ? [...DEFAULT_INPUT_PREVIEW_TYPES] : [...eventTypes]
  );
  const [selectedCommands, setSelectedCommands] = useState<string[]>([]);
  const [selectedSingleCommand, setSelectedSingleCommand] =
    useState<string>("");

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

  const [selectedStatus, setSelectedStatus] =
    useState<EventDisplayStatus>("completed");
  const [activePresetKey, setActivePresetKey] = useState<string>("completed");
  const [statusSelectionMode, setStatusSelectionMode] =
    useState<PlaygroundListSelectionMode>("single");
  const [selectedPresetKeys, setSelectedPresetKeys] = useState<string[]>([
    "completed",
  ]);

  const handleSingleCommandSelect = useCallback(
    (commandName: string) => {
      setSelectedSingleCommand(commandName);
      if (!COMMAND_STATUS_PRESETS[selectedType]) return;
      const presets = resolveStatusPresets(selectedType, commandName);
      const firstPreset = presets[0];
      if (firstPreset) {
        setActivePresetKey(firstPreset.key);
        setSelectedStatus(firstPreset.status);
        setSelectedPresetKeys([firstPreset.key]);
      }
    },
    [selectedType]
  );
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
  const [toolTypeFilter, setToolTypeFilter] = useState("");
  const isMultiSelect = listSelectionMode === "multiple";
  const wasInputModeRef = useRef(isInputMode);
  const selectedInputPreviewTypes =
    isInputMode && !isMultiSelect ? [selectedType] : selectedTypesMulti;

  const chatRetryKinds = [
    ...(selectedInputPreviewTypes.includes(CHAT_PREVIEW_TYPE.RECONNECTING)
      ? [CHAT_RETRY_KIND.RECONNECTING]
      : []),
    ...(selectedInputPreviewTypes.includes(CHAT_PREVIEW_TYPE.RATE_LIMITED)
      ? [CHAT_RETRY_KIND.RATE_LIMITED]
      : []),
  ];

  const chatExtras: PlaygroundChatExtras = {
    showQueuedMessages: selectedInputPreviewTypes.includes(
      CHAT_PREVIEW_TYPE.QUEUED
    ),
    showTerminalProcesses: selectedInputPreviewTypes.includes(
      CHAT_PREVIEW_TYPE.TERMINAL
    ),
    showFileReview: selectedInputPreviewTypes.includes(
      CHAT_PREVIEW_TYPE.REVIEW
    ),
    showModeSwitch: selectedInputPreviewTypes.includes(
      CHAT_PREVIEW_TYPE.MODE_SWITCH
    ),
    retryKinds: chatRetryKinds,
    showInterventionBanner: selectedInputPreviewTypes.includes(
      CHAT_PREVIEW_TYPE.INTERVENTION
    ),
    showPausedBanner: selectedInputPreviewTypes.includes(
      CHAT_PREVIEW_TYPE.PAUSED
    ),
  };

  const [jsonInput, setJsonInput] = useState<string>(() => {
    const data = MOCK_EVENT_DATA[selectedType];
    return data ? JSON.stringify(data, null, 2) : "{}";
  });

  const normalizedToolTypeFilter = toolTypeFilter.trim().toLowerCase();

  const displayableEventTypes = useMemo(() => {
    if (isInputMode) return [...CHAT_PREVIEW_TYPES];
    return eventTypes;
  }, [eventTypes, isInputMode]);

  const filteredEventTypes = useMemo(() => {
    if (!normalizedToolTypeFilter) return displayableEventTypes;
    return displayableEventTypes.filter((eventType) =>
      eventType.toLowerCase().includes(normalizedToolTypeFilter)
    );
  }, [displayableEventTypes, normalizedToolTypeFilter]);

  const displayEventTypesSingle = useMemo(() => {
    if (!normalizedToolTypeFilter) return filteredEventTypes;
    if (filteredEventTypes.includes(selectedType)) return filteredEventTypes;
    if (displayableEventTypes.includes(selectedType)) {
      return [selectedType, ...filteredEventTypes];
    }
    return filteredEventTypes;
  }, [
    filteredEventTypes,
    normalizedToolTypeFilter,
    selectedType,
    displayableEventTypes,
  ]);

  const displayEventTypesMulti = filteredEventTypes;

  const statusPresetsForUi = useMemo(() => {
    if (isMultiSelect) return DEFAULT_STATUS_PRESETS;
    if (selectedType === "subagent") return subagentSidebarStatusPresets();
    const commandKey =
      commandSelectionMode === "single" ? selectedSingleCommand : undefined;
    return resolveStatusPresets(selectedType, commandKey);
  }, [
    isMultiSelect,
    selectedType,
    commandSelectionMode,
    selectedSingleCommand,
  ]);

  // If the active preset key is no longer in the resolved list (e.g. user
  // switched commands and the new command has a different state vocabulary),
  // snap back to the first preset.
  useEffect(() => {
    if (statusPresetsForUi.length === 0) return;
    if (statusPresetsForUi.some((p) => p.key === activePresetKey)) return;
    const first = statusPresetsForUi[0];
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setActivePresetKey(first.key);
      setSelectedStatus(first.status);
      setSelectedPresetKeys((prev) => {
        const filtered = prev.filter((key) =>
          statusPresetsForUi.some((p) => p.key === key)
        );
        return filtered.length > 0 ? filtered : [first.key];
      });
    });
    return () => {
      cancelled = true;
    };
  }, [statusPresetsForUi, activePresetKey]);

  const applyEventTypeSelection = useCallback(
    (newType: string) => {
      setSelectedType(newType);
      const newActions = actionsMap.get(newType) ?? [];
      setSelectedCommands(newActions.map((action) => action.name));
      const firstCommand = newActions[0]?.name ?? "";
      setSelectedSingleCommand(firstCommand);
      const data = MOCK_EVENT_DATA[newType];
      if (data) {
        setJsonInput(JSON.stringify(data, null, 2));
      }
      const presets =
        newType === "subagent"
          ? subagentSidebarStatusPresets()
          : resolveStatusPresets(newType, firstCommand);
      const firstPreset = presets[0];
      setActivePresetKey(firstPreset.key);
      setSelectedStatus(firstPreset.status);
      setSelectedPresetKeys([firstPreset.key]);
    },
    [actionsMap]
  );

  useEffect(() => {
    if (wasInputModeRef.current === isInputMode) return;
    wasInputModeRef.current = isInputMode;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (isInputMode) {
        setListSelectionMode("multiple");
        setSelectedVariant("chat");
        setSelectedTypesMulti([...DEFAULT_INPUT_PREVIEW_TYPES]);
        return;
      }
      setListSelectionMode("multiple");
      setSelectedTypesMulti([...eventTypes]);
      setSelectedVariant("chat");
      setToolTypeFilter("");
      if (isChatPreviewType(selectedType)) {
        const firstType = eventTypes[0] || "read_file";
        applyEventTypeSelection(firstType);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [applyEventTypeSelection, eventTypes, isInputMode, selectedType]);

  const handleListSelectionModeChange = useCallback(
    (next: PlaygroundListSelectionMode) => {
      if (next === "multiple") {
        setListSelectionMode("multiple");
        setSelectedTypesMulti((prev) => {
          if (prev.length > 0) return prev;
          return isInputMode
            ? [...DEFAULT_INPUT_PREVIEW_TYPES]
            : [selectedType];
        });
        setSelectedVariant("chat");
        setActivePresetKey("completed");
        setSelectedStatus("completed");
        setSelectedPresetKeys(["completed"]);
        return;
      }

      setListSelectionMode("single");
      const primary = isInputMode
        ? (selectedTypesMulti.find(isChatPreviewType) ??
          DEFAULT_INPUT_PREVIEW_TYPES[0])
        : (selectedTypesMulti.find(
            (eventType) => !isChatPreviewType(eventType)
          ) ?? selectedType);
      applyEventTypeSelection(primary);
    },
    [applyEventTypeSelection, isInputMode, selectedType, selectedTypesMulti]
  );

  const handleMultiTypeToggle = useCallback(
    (eventType: string, checked: boolean) => {
      setSelectedTypesMulti((prev) => {
        if (checked) {
          if (prev.includes(eventType)) return prev;
          return [...prev, eventType];
        }
        return prev.filter((item) => item !== eventType);
      });
    },
    []
  );

  const handleJsonChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setJsonInput(event.target.value);
    },
    []
  );

  const handlePresetChange = useCallback(
    (key: string) => {
      if (selectedType === "subagent") {
        const subPreset = SUBAGENT_PLAYGROUND_PRESETS.find(
          (p) => p.key === key
        );
        if (!subPreset) return;
        setActivePresetKey(key);
        setSelectedStatus(subPreset.status);
        if (!isMultiSelect) {
          try {
            const parsed = JSON.parse(jsonInput) as Record<string, unknown>;
            setJsonInput(
              JSON.stringify(
                {
                  ...parsed,
                  args: subPreset.args,
                  result: subPreset.result,
                },
                null,
                2
              )
            );
          } catch {
            /* invalid JSON — ignore */
          }
        }
        return;
      }

      const preset = statusPresetsForUi.find((p) => p.key === key);
      if (!preset) return;
      setActivePresetKey(key);
      setSelectedStatus(preset.status);
      if (!isMultiSelect) {
        const baseMock = MOCK_EVENT_DATA[selectedType];
        if (!baseMock) return;
        const base = JSON.parse(JSON.stringify(baseMock)) as Record<
          string,
          unknown
        >;
        if (preset.resultPatch) {
          base.result = {
            ...(base.result as Record<string, unknown>),
            ...preset.resultPatch,
          };
        }
        if (preset.argsPatch) {
          base.args = {
            ...(base.args as Record<string, unknown>),
            ...preset.argsPatch,
          };
        }
        setJsonInput(JSON.stringify(base, null, 2));
      }
    },
    [selectedType, statusPresetsForUi, jsonInput, isMultiSelect]
  );

  const handleResetPlayground = useCallback(() => {
    const firstType = eventTypes[0] || "read_file";
    const resetType = isInputMode ? DEFAULT_INPUT_PREVIEW_TYPES[0] : firstType;
    setListSelectionMode("multiple");
    setCommandSelectionMode("single");
    setStatusSelectionMode("single");
    setSelectedTypesMulti(
      isInputMode ? [...DEFAULT_INPUT_PREVIEW_TYPES] : [...eventTypes]
    );
    setSelectedVariant("chat");
    setToolTypeFilter("");
    applyEventTypeSelection(resetType);
  }, [applyEventTypeSelection, eventTypes, isInputMode]);

  const variantTabs = usePlaygroundVariantTabs(isMultiSelect, isInputMode);

  const {
    effectiveEventData,
    parseError,
    multiPreviewEvents,
    commandPreviewEvents,
    multiStatusPreviewEvents,
  } = useSingleEventPreviewEvents({
    isMultiSelect,
    selectedTypesMulti,
    selectedType,
    selectedStatus,
    activePresetKey,
    jsonInput,
    commandSelectionMode,
    selectedSingleCommand,
    selectedCommands,
    statusSelectionMode,
    selectedPresetKeys,
    statusPresetsForUi,
  });

  const renderPreviewContent = () => (
    <SingleEventPreviewContent
      isMultiSelect={isMultiSelect}
      selectedTypesMulti={selectedTypesMulti}
      selectedVariant={selectedVariant}
      multiPreviewEvents={multiPreviewEvents}
      multiStatusPreviewEvents={multiStatusPreviewEvents}
      commandPreviewEvents={commandPreviewEvents}
      parseError={parseError}
      effectiveEventData={effectiveEventData}
      chatExtras={chatExtras}
      inputOnly={isInputMode}
    />
  );

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
            title={isInputMode ? t("devTools.inputType") : undefined}
            selectionMode={listSelectionMode}
            onSelectionModeChange={handleListSelectionModeChange}
            searchSlot={
              <Input
                value={toolTypeFilter}
                onChange={(value) => setToolTypeFilter(value)}
                placeholder={t("devTools.toolTypeFilterPlaceholder")}
                size="small"
                allowClear
                prefix={
                  <HugeiconsIcon
                    icon={Search01Icon}
                    data-icon="search"
                    size={14}
                    className="text-text-3"
                  />
                }
                aria-label={t("devTools.toolTypeFilterPlaceholder")}
              />
            }
          >
            <SingleEventTypeList
              selectionMode={listSelectionMode}
              selectedType={selectedType}
              selectedTypesMulti={selectedTypesMulti}
              chatOnly={isInputMode}
              displayEventTypesSingle={displayEventTypesSingle}
              displayEventTypesMulti={displayEventTypesMulti}
              onSingleSelect={applyEventTypeSelection}
              onMultiToggle={handleMultiTypeToggle}
            />
          </PlaygroundToolTypeSection>

          {!isInputMode && !isMultiSelect && currentActions.length > 0 && (
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

          {!isInputMode && (
            <PlaygroundStatusPresetSection
              presets={statusPresetsForUi}
              activePresetKey={activePresetKey}
              onPresetChange={handlePresetChange}
              selectionMode={statusSelectionMode}
              onSelectionModeChange={setStatusSelectionMode}
              selectedPresetKeys={selectedPresetKeys}
              onPresetToggle={handleStatusPresetToggle}
            />
          )}

          {/* <PlaygroundChatExtrasSection
            extras={chatExtras}
            onToggle={handleChatExtrasToggle}
          /> */}
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
