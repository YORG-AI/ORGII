import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import TabPill from "@src/components/TabPill";
import type { EventVariant } from "@src/engines/SessionCore/rendering/types/universalProps";
import {
  type MockChatItem,
  getAvailableExtendedScenarios,
} from "@src/modules/MainApp/ToolPreview/mockData/scenarios";

import { type ModeControlProps, useModeTabsDefinition } from "../hooks";
import type { PreviewMode } from "../types";
import {
  LiveScenarioControls,
  LiveScriptEditor,
  SessionVariantPreview,
} from "./SessionSimulationPreview";
import {
  buildFlowFromScript,
  buildLiveFlowForMessage,
  createLiveUserItem,
  parseLiveFlowScript,
  waitMilliseconds,
} from "./sessionSimulationFlow";
import {
  DEFAULT_LIVE_FLOW_SCRIPT_TEXT,
  SCRIPT_PRESETS,
} from "./sessionSimulationScripts";
import {
  CUSTOM_SCRIPT_PRESET_ID,
  LIVE_MOCK_SCENARIO_ID,
  type LiveChatItem,
} from "./sessionSimulationTypes";

export function SessionSimulator({ mode, onModeChange }: ModeControlProps) {
  const { t } = useTranslation(["integrations", "common"]);
  const modeTabs = useModeTabsDefinition();
  const scenarios = useMemo(() => getAvailableExtendedScenarios(), []);

  const [sessionVariant, setSessionVariant] = useState<EventVariant>("chat");
  const [liveItems, setLiveItems] = useState<LiveChatItem[]>([]);
  const [liveInput, setLiveInput] = useState<string>("");
  const [selectedScriptPresetId, setSelectedScriptPresetId] =
    useState<string>("default");
  const [flowScriptInput, setFlowScriptInput] = useState<string>(
    DEFAULT_LIVE_FLOW_SCRIPT_TEXT
  );
  const [isLiveResponding, setIsLiveResponding] = useState<boolean>(false);
  const liveRunIdRef = useRef(0);

  const sessionVariantTabs = useMemo(
    () => [
      { key: "chat" as const, label: t("devTools.variantChat") },
      { key: "simulator" as const, label: t("devTools.variantSimulator") },
    ],
    [t]
  );

  const scenarioOptions: SelectOption[] = useMemo(
    () => [
      {
        value: LIVE_MOCK_SCENARIO_ID,
        label: t("devTools.sessionSimulation"),
      },
      ...scenarios.map((scenario) => ({
        value: scenario.id,
        label: scenario.name,
      })),
    ],
    [scenarios, t]
  );

  const [selectedScenarioId, setSelectedScenarioId] = useState<string>(
    LIVE_MOCK_SCENARIO_ID
  );

  const selectedScenario = useMemo(
    () =>
      scenarios.find((scenario) => scenario.id === selectedScenarioId) ?? null,
    [scenarios, selectedScenarioId]
  );

  const handleScenarioChange = useCallback(
    (value: string | number | (string | number)[]) => {
      const nextScenarioId = String(value);
      const leavingLiveScenario =
        selectedScenarioId === LIVE_MOCK_SCENARIO_ID &&
        nextScenarioId !== LIVE_MOCK_SCENARIO_ID;
      if (leavingLiveScenario) {
        setIsLiveResponding(false);
        setLiveInput("");
        liveRunIdRef.current += 1;
      }
      setSelectedScenarioId(nextScenarioId);
    },
    [selectedScenarioId]
  );

  const filterScenarioOption = useCallback(
    (inputValue: string, option: SelectOption) => {
      const query = inputValue.toLowerCase().trim();
      if (String(option.value) === LIVE_MOCK_SCENARIO_ID) {
        if (!query) return true;
        const liveLabel = t("devTools.sessionSimulation").toLowerCase();
        return liveLabel.includes(query);
      }
      const scenario = scenarios.find(
        (item) => item.id === String(option.value)
      );
      if (!scenario) return false;
      if (!query) return true;
      return (
        scenario.name.toLowerCase().includes(query) ||
        scenario.description.toLowerCase().includes(query)
      );
    },
    [scenarios, t]
  );

  const isLiveScenario = selectedScenarioId === LIVE_MOCK_SCENARIO_ID;

  useEffect(() => {
    return () => {
      liveRunIdRef.current += 1;
    };
  }, []);

  const liveDisplayItems = useMemo<MockChatItem[]>(
    () => liveItems.map((item) => ({ ...item })),
    [liveItems]
  );

  const parsedFlowScript = useMemo(
    () => parseLiveFlowScript(flowScriptInput),
    [flowScriptInput]
  );

  const scriptPresetOptions: SelectOption[] = useMemo(
    () => [
      ...SCRIPT_PRESETS.map((preset) => ({
        value: preset.id,
        label: preset.label,
      })),
      {
        value: CUSTOM_SCRIPT_PRESET_ID,
        label: "Custom",
      },
    ],
    []
  );

  const handleLiveSend = useCallback(async () => {
    const trimmedInput = liveInput.trim();
    if (!trimmedInput || isLiveResponding) return;

    const runId = liveRunIdRef.current + 1;
    liveRunIdRef.current = runId;

    setLiveInput("");
    setIsLiveResponding(true);

    const userItem = createLiveUserItem(trimmedInput);
    const flow = parsedFlowScript.data
      ? buildFlowFromScript(parsedFlowScript.data, trimmedInput)
      : buildLiveFlowForMessage(trimmedInput);

    setLiveItems((prev) => [...prev, userItem, flow.intro]);

    for (const step of flow.steps) {
      await waitMilliseconds(step.delayMs);
      if (liveRunIdRef.current !== runId) return;
      setLiveItems((prev) => [...prev, step.item]);
    }

    await waitMilliseconds(280);
    if (liveRunIdRef.current !== runId) return;
    setLiveItems((prev) => [...prev, flow.final]);
    setIsLiveResponding(false);
  }, [isLiveResponding, liveInput, parsedFlowScript.data]);

  const handleLiveClear = useCallback(() => {
    liveRunIdRef.current += 1;
    setIsLiveResponding(false);
    setLiveItems([]);
  }, []);

  const handleLiveInputChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setLiveInput(event.target.value);
    },
    []
  );

  const handleFlowScriptInputChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      if (selectedScriptPresetId !== CUSTOM_SCRIPT_PRESET_ID) {
        setSelectedScriptPresetId(CUSTOM_SCRIPT_PRESET_ID);
      }
      setFlowScriptInput(event.target.value);
    },
    [selectedScriptPresetId]
  );

  const handleScriptPresetChange = useCallback(
    (value: string | number | (string | number)[]) => {
      const nextPresetId = String(value);
      setSelectedScriptPresetId(nextPresetId);
      if (nextPresetId === CUSTOM_SCRIPT_PRESET_ID) {
        return;
      }
      const targetPreset = SCRIPT_PRESETS.find(
        (preset) => preset.id === nextPresetId
      );
      if (!targetPreset) return;
      setFlowScriptInput(JSON.stringify(targetPreset.script, null, 2));
    },
    []
  );

  const handleFlowScriptReset = useCallback(() => {
    setSelectedScriptPresetId("default");
    setFlowScriptInput(DEFAULT_LIVE_FLOW_SCRIPT_TEXT);
  }, []);

  const handleLiveInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void handleLiveSend();
      }
    },
    [handleLiveSend]
  );

  const renderSelectedScenarioPreview = () => {
    if (isLiveScenario) {
      return (
        <>
          <SessionVariantPreview
            variant={sessionVariant}
            items={liveDisplayItems}
          />
          <LiveScenarioControls
            liveInput={liveInput}
            liveItemsLength={liveItems.length}
            isLiveResponding={isLiveResponding}
            onLiveInputChange={handleLiveInputChange}
            onLiveInputKeyDown={handleLiveInputKeyDown}
            onLiveSend={() => {
              void handleLiveSend();
            }}
            onLiveClear={handleLiveClear}
          />
          <LiveScriptEditor
            selectedScriptPresetId={selectedScriptPresetId}
            scriptPresetOptions={scriptPresetOptions}
            flowScriptInput={flowScriptInput}
            flowScriptError={parsedFlowScript.error}
            onScriptPresetChange={handleScriptPresetChange}
            onFlowScriptInputChange={handleFlowScriptInputChange}
            onFlowScriptReset={handleFlowScriptReset}
          />
        </>
      );
    }

    if (selectedScenario) {
      return (
        <SessionVariantPreview
          variant={sessionVariant}
          items={selectedScenario.items}
        />
      );
    }

    return <Placeholder variant="empty" title={t("devTools.selectScenario")} />;
  };

  return (
    <div className="tool-event-session">
      <div className="tool-event-single-controls tool-event-session-controls-row">
        <div className="tool-event-field">
          <label className="tool-event-field-label">{t("devTools.mode")}</label>
          <TabPill
            tabs={modeTabs}
            activeTab={mode}
            onChange={(key) => onModeChange(key as PreviewMode)}
            variant="pill"
            color="fill"
            fillWidth={false}
            size="default"
          />
        </div>

        <div className="tool-event-field">
          <label className="tool-event-field-label">
            {t("devTools.scenario")}
          </label>
          <Select
            value={selectedScenarioId}
            options={scenarioOptions}
            onChange={handleScenarioChange}
            showSearch
            filterOption={filterScenarioOption}
            size="small"
            className="tool-event-select tool-event-select--wide"
          />
        </div>

        <div className="tool-event-field">
          <label className="tool-event-field-label">
            {t("devTools.variant")}
          </label>
          <TabPill
            tabs={sessionVariantTabs}
            activeTab={sessionVariant}
            onChange={(tab) => setSessionVariant(tab as EventVariant)}
            variant="pill"
            color="fill"
            fillWidth={false}
            size="default"
          />
        </div>
      </div>

      <div className="tool-event-session-preview">
        <label className="tool-event-field-label">
          {t("devTools.chatPreview")}
        </label>
        {renderSelectedScenarioPreview()}
      </div>
    </div>
  );
}
