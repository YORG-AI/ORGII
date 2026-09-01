/**
 * State and form logic for AgentWizard.
 * Extracted to keep the component under the UI line limit.
 */
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  AgentDefinition,
  CapabilitySet,
  SubAgentRef,
} from "@src/modules/MainApp/AgentOrgs/types";
import { useMarkdownEditorTabs } from "@src/modules/shared/components/MarkdownEditor";

interface UseAgentWizardReturn {
  // Navigation
  activeTab: string;
  setActiveTab: (tab: string) => void;
  tabs: Array<{ key: string; label: string }>;

  // Core fields
  agentName: string;
  setAgentName: (name: string) => void;
  description: string;
  setDescription: (desc: string) => void;

  // Model config
  contextWindow: number;
  setContextWindow: (v: number) => void;
  maxTokens: number;
  setMaxTokens: (v: number) => void;
  temperature: number;
  setTemperature: (v: number) => void;
  isCustomContextWindow: boolean;
  contextWindowOptions: Array<{
    label: string;
    value: string;
    dataTestId?: string;
  }>;

  // Compaction
  compactionEnabled: boolean;
  setCompactionEnabled: (v: boolean) => void;
  compactionTriggerRatio: number;
  setCompactionTriggerRatio: (v: number) => void;
  compactionKeepRatio: number;
  setCompactionKeepRatio: (v: number) => void;
  compactionModel: string;
  setCompactionModel: (v: string) => void;
  compactionSummaryMaxTokens: number;
  setCompactionSummaryMaxTokens: (v: number) => void;
  compactionMinMessages: number;
  setCompactionMinMessages: (v: number) => void;
  compactionFloorTokens: number;
  setCompactionFloorTokens: (v: number) => void;
  compactionReservedSummaryTokens: number;
  setCompactionReservedSummaryTokens: (v: number) => void;
  compactionBufferTokens: number;
  setCompactionBufferTokens: (v: number) => void;

  // Personality
  soulContent: string;
  setSoulContent: (v: string) => void;
  soulTab: string;
  setSoulTab: (v: string) => void;
  editorTabs: ReturnType<typeof useMarkdownEditorTabs>;

  // Capabilities
  capCoding: boolean;
  setCapCoding: (v: boolean) => void;
  capCodingModeSwitch: boolean;
  setCapCodingModeSwitch: (v: boolean) => void;
  capDesktop: boolean;
  setCapDesktop: (v: boolean) => void;
  capBrowserExternal: boolean;
  setCapBrowserExternal: (v: boolean) => void;
  capBrowserInternal: boolean;
  setCapBrowserInternal: (v: boolean) => void;
  capGateway: boolean;
  setCapGateway: (v: boolean) => void;
  capData: boolean;
  setCapData: (v: boolean) => void;
  capManagement: boolean;
  setCapManagement: (v: boolean) => void;

  // Sub-agents
  subAgents: SubAgentRef[];
  setSubAgents: (agents: SubAgentRef[]) => void;
  maxToolUseConcurrency: number;
  setMaxToolUseConcurrency: (value: number) => void;

  // Derived
  canCreate: boolean;

  // Actions
  handleCreate: () => void;
}

export function useAgentWizard(
  onSave: (agent: AgentDefinition) => void | Promise<void>
): UseAgentWizardReturn {
  const { t } = useTranslation("integrations");
  const { t: tSettings } = useTranslation("settings");

  const [activeTab, setActiveTab] = useState("core");
  const [agentName, setAgentName] = useState("");
  const [description, setDescription] = useState("");
  const [subAgents, setSubAgents] = useState<SubAgentRef[]>([]);
  const [maxToolUseConcurrency, setMaxToolUseConcurrency] = useState(10);
  const [contextWindow, setContextWindow] = useState(0);
  const [maxTokens, setMaxTokens] = useState(16384);
  const [temperature, setTemperature] = useState(0.0);
  const [compactionEnabled, setCompactionEnabled] = useState(true);
  const [compactionTriggerRatio, setCompactionTriggerRatio] = useState(0.8);
  const [compactionKeepRatio, setCompactionKeepRatio] = useState(0.4);
  const [compactionModel, setCompactionModel] = useState<string>("");
  const [compactionSummaryMaxTokens, setCompactionSummaryMaxTokens] =
    useState(4096);
  const [compactionMinMessages, setCompactionMinMessages] = useState(8);
  const [compactionFloorTokens, setCompactionFloorTokens] = useState(16000);
  const [compactionReservedSummaryTokens, setCompactionReservedSummaryTokens] =
    useState(20000);
  const [compactionBufferTokens, setCompactionBufferTokens] = useState(13000);
  const [soulContent, setSoulContent] = useState("");
  const [soulTab, setSoulTab] = useState("edit");
  const editorTabs = useMarkdownEditorTabs();

  const [capCoding, setCapCoding] = useState<boolean>(false);
  const [capCodingModeSwitch, setCapCodingModeSwitch] = useState<boolean>(true);
  const [capDesktop, setCapDesktop] = useState<boolean>(false);
  const [capBrowserExternal, setCapBrowserExternal] = useState<boolean>(false);
  const [capBrowserInternal, setCapBrowserInternal] = useState<boolean>(false);
  const [capGateway, setCapGateway] = useState<boolean>(false);
  const [capData, setCapData] = useState<boolean>(false);
  const [capManagement, setCapManagement] = useState<boolean>(false);

  const canCreate = agentName.trim().length > 0;
  const isCustomContextWindow = contextWindow > 0;

  const contextWindowOptions = useMemo(
    () => [
      {
        label: tSettings("sharedAgentConfig.contextWindowAuto"),
        value: "auto",
        dataTestId: "agent-orgs-agent-wizard-context-window-option-auto",
      },
      {
        label: tSettings("sharedAgentConfig.contextWindowCustom"),
        value: "custom",
        dataTestId: "agent-orgs-agent-wizard-context-window-option-custom",
      },
    ],
    [tSettings]
  );

  const tabs = useMemo(
    () => [
      { key: "core", label: tSettings("sharedAgentConfig.generalTitle") },
      { key: "models", label: tSettings("sharedAgentConfig.modelsTitle") },
      {
        key: "capabilities",
        label: tSettings("sharedAgentConfig.capabilities.title"),
      },
      {
        key: "subagents",
        label: t("agentOrgs.agentWizard.subAgentsTab"),
      },
    ],
    [tSettings, t]
  );

  const handleCreate = useCallback(() => {
    if (!canCreate) return;
    const capabilities: CapabilitySet = {};
    if (capCoding) capabilities.coding = { modeSwitch: capCodingModeSwitch };
    if (capDesktop) capabilities.desktop = { enabled: true };
    if (capBrowserExternal || capBrowserInternal) {
      capabilities.browser = {
        external: capBrowserExternal,
        internal: capBrowserInternal,
      };
    }
    if (capGateway) capabilities.gateway = {};
    if (capData) capabilities.data = {};
    if (capManagement) capabilities.management = {};
    const agent: AgentDefinition = {
      id: crypto.randomUUID(),
      name: agentName.trim(),
      description: description.trim() || undefined,
      builtIn: false,
      contextWindow: contextWindow > 0 ? contextWindow : undefined,
      maxTokens,
      temperature,
      sessionModel: {
        mode: "per-session",
        maxIterations: 500,
        processingLock: true,
        compaction: {
          enabled: compactionEnabled,
          triggerRatio: compactionTriggerRatio,
          keepRatio: compactionKeepRatio,
          model: compactionModel.trim() ? compactionModel.trim() : null,
          summaryMaxTokens: compactionSummaryMaxTokens,
          minMessages: compactionMinMessages,
          floorTokens: compactionFloorTokens,
          reservedSummaryTokens: compactionReservedSummaryTokens,
          bufferTokens: compactionBufferTokens,
        },
      },
      soulContent: soulContent.trim() || undefined,
      subAgents: subAgents.length > 0 ? subAgents : undefined,
      maxToolUseConcurrency,
      capabilities,
    };
    onSave(agent);
  }, [
    canCreate,
    agentName,
    description,
    contextWindow,
    maxTokens,
    temperature,
    compactionEnabled,
    compactionTriggerRatio,
    compactionKeepRatio,
    compactionModel,
    compactionSummaryMaxTokens,
    compactionMinMessages,
    compactionFloorTokens,
    compactionReservedSummaryTokens,
    compactionBufferTokens,
    soulContent,
    subAgents,
    maxToolUseConcurrency,
    capCoding,
    capCodingModeSwitch,
    capDesktop,
    capBrowserExternal,
    capBrowserInternal,
    capGateway,
    capData,
    capManagement,
    onSave,
  ]);

  return {
    activeTab,
    setActiveTab,
    tabs,
    agentName,
    setAgentName,
    description,
    setDescription,
    contextWindow,
    setContextWindow,
    maxTokens,
    setMaxTokens,
    temperature,
    setTemperature,
    isCustomContextWindow,
    contextWindowOptions,
    compactionEnabled,
    setCompactionEnabled,
    compactionTriggerRatio,
    setCompactionTriggerRatio,
    compactionKeepRatio,
    setCompactionKeepRatio,
    compactionModel,
    setCompactionModel,
    compactionSummaryMaxTokens,
    setCompactionSummaryMaxTokens,
    compactionMinMessages,
    setCompactionMinMessages,
    compactionFloorTokens,
    setCompactionFloorTokens,
    compactionReservedSummaryTokens,
    setCompactionReservedSummaryTokens,
    compactionBufferTokens,
    setCompactionBufferTokens,
    soulContent,
    setSoulContent,
    soulTab,
    setSoulTab,
    editorTabs,
    capCoding,
    setCapCoding,
    capCodingModeSwitch,
    setCapCodingModeSwitch,
    capDesktop,
    setCapDesktop,
    capBrowserExternal,
    setCapBrowserExternal,
    capBrowserInternal,
    setCapBrowserInternal,
    capGateway,
    setCapGateway,
    capData,
    setCapData,
    capManagement,
    setCapManagement,
    subAgents,
    setSubAgents,
    maxToolUseConcurrency,
    setMaxToolUseConcurrency,
    canCreate,
    handleCreate,
  };
}
