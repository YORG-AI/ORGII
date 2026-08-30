/**
 * Custom-model row editing for the Key Vault wizard unified ModelTable.
 * Keeps ModelTable/index.tsx under the component size budget.
 *
 * Each custom row has three editable fields:
 *   - icon          (provider icon shown in selectors)
 *   - alias         (model id used to call the LLM; required)
 *   - displayName   (label shown in agent selector / UI; optional, falls
 *                   back to alias when empty)
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import Input from "@src/components/Input";
import ModelIcon from "@src/components/ModelIcon";
import type { IconProvider } from "@src/components/ModelIcon/config";
import {
  MODEL_PROVIDER_ICON_PROVIDERS,
  getIconProviderFromModelName,
} from "@src/components/ModelIcon/config";
import type { SelectOption } from "@src/components/Select";
import { MODEL_TABLE_CONTROL_SIZE } from "@src/config/modelTable";
import type { ModelTableModelAlias } from "@src/types/modelTable";

import type { FlatRow } from "./useModelTableData";

const ICON_PROVIDER_DISPLAY_LABELS: Partial<Record<IconProvider, string>> = {
  aws: "AWS",
  baichuan: "Baichuan",
  bytedance: "ByteDance",
  claude: "Claude",
  claude_code: "Claude Code",
  codex: "Codex",
  copilot: "Copilot",
  cursor: "Cursor",
  deepseek: "DeepSeek",
  doubao: "Doubao",
  gemini: "Gemini",
  grok: "Grok",
  groq: "Groq",
  kimi: "Kimi",
  kiro: "Kiro",
  longcat: "LongCat",
  meta: "Meta",
  minimax: "Minimax",
  mistral: "Mistral",
  openai: "OpenAI",
  opencode: "OpenCode",
  openrouter: "OpenRouter",
  orgii: "ORGII",
  perplexity: "Perplexity",
  qwen: "Qwen",
  vllm: "vLLM",
  volcengine: "Volcengine",
  yi: "Yi",
  zhipu: "Zhipu",
};

function getIconProviderDisplayLabel(provider: IconProvider): string {
  return (
    ICON_PROVIDER_DISPLAY_LABELS[provider] ??
    provider
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

export function buildIconSelectOptions(
  providers: IconProvider[]
): SelectOption[] {
  return providers.map((provider) => {
    const label = getIconProviderDisplayLabel(provider);
    return {
      label: (
        <span className="flex items-center gap-2">
          <ModelIcon provider={provider} size="small" />
          <span>{label}</span>
        </span>
      ),
      triggerLabel: <ModelIcon provider={provider} size="small" />,
      value: provider,
    };
  });
}

const PLACEHOLDER_PREFIX = "new-";
const CUSTOM_ROW_ID_PREFIX = "custom-row-";

export function newCustomRowId(): string {
  return `${CUSTOM_ROW_ID_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
}

export function newPlaceholderModelName(rowId: string): string {
  return `${PLACEHOLDER_PREFIX}${rowId.slice(CUSTOM_ROW_ID_PREFIX.length)}`;
}

/** True when a model name is a placeholder for an unnamed new row. */
export function isPlaceholderModelName(name: string): boolean {
  return name.startsWith(PLACEHOLDER_PREFIX);
}

interface CustomModelNameInputProps {
  modelName: string;
  placeholder: string;
  className: string;
  onCommit: (oldName: string, newName: string) => void;
  onCommittedBlur: (currentName: string) => void;
}

export function CustomModelNameInput({
  modelName,
  placeholder,
  className,
  onCommit,
  onCommittedBlur,
}: CustomModelNameInputProps) {
  const resolvedValue = isPlaceholderModelName(modelName) ? "" : modelName;
  const [draft, setDraft] = useState(resolvedValue);

  useEffect(() => {
    setDraft(resolvedValue);
  }, [resolvedValue]);

  const commit = useCallback(() => {
    if (draft.trim() !== resolvedValue) {
      onCommit(modelName, draft);
    }
    onCommittedBlur(draft);
  }, [draft, modelName, onCommit, onCommittedBlur, resolvedValue]);

  return (
    <Input
      value={draft}
      onChange={setDraft}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      placeholder={placeholder}
      size={MODEL_TABLE_CONTROL_SIZE}
      className={className}
    />
  );
}

interface CustomModelDisplayNameInputProps {
  modelName: string;
  value: string;
  placeholder: string;
  className: string;
  onCommit: (modelName: string, displayName: string) => void;
}

export function CustomModelDisplayNameInput({
  modelName,
  value,
  placeholder,
  className,
  onCommit,
}: CustomModelDisplayNameInputProps) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = useCallback(() => {
    if (draft !== value) {
      onCommit(modelName, draft);
    }
  }, [draft, modelName, onCommit, value]);

  return (
    <Input
      value={draft}
      onChange={setDraft}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      placeholder={placeholder}
      size={MODEL_TABLE_CONTROL_SIZE}
      className={className}
    />
  );
}

export interface UseUnifiedCustomFlatHandlersParams {
  customModels: string[];
  onCustomModelsChange: (models: string[]) => void;
  modelAliases: ModelTableModelAlias[];
  onModelAliasesChange: (aliases: ModelTableModelAlias[]) => void;
  enabledModels?: string[];
  onEnabledModelsChange?: (enabledModels: string[]) => void;
  onTestModel?: (
    model: string
  ) => Promise<{ available: boolean; message: string }>;
  visibleFlatRows: FlatRow[];
}

export function useUnifiedCustomFlatHandlers({
  customModels,
  onCustomModelsChange,
  modelAliases,
  onModelAliasesChange,
  enabledModels = [],
  onEnabledModelsChange,
  onTestModel,
  visibleFlatRows,
}: UseUnifiedCustomFlatHandlersParams) {
  const [testError, setTestError] = useState<string | null>(null);

  const iconOptions = useMemo<SelectOption[]>(() => {
    const ordered: IconProvider[] = [...MODEL_PROVIDER_ICON_PROVIDERS];
    const seen = new Set<string>(ordered);
    const appendProvider = (provider: IconProvider | undefined) => {
      if (!provider || provider === "unknown" || seen.has(provider)) return;
      seen.add(provider);
      ordered.push(provider);
    };

    for (const row of visibleFlatRows) {
      appendProvider(getIconProviderFromModelName(row.model));
    }
    for (const alias of modelAliases) {
      appendProvider(alias.icon as IconProvider | undefined);
    }
    return buildIconSelectOptions(ordered);
  }, [modelAliases, visibleFlatRows]);

  const findOrCreateAlias = useCallback(
    (
      modelName: string,
      patch: Partial<ModelTableModelAlias>
    ): ModelTableModelAlias[] => {
      const existingIdx = modelAliases.findIndex(
        (entry) => entry.alias === modelName
      );
      if (existingIdx >= 0) {
        return modelAliases.map((entry, idx) =>
          idx === existingIdx ? { ...entry, ...patch } : entry
        );
      }
      return [...modelAliases, { displayName: "", alias: modelName, ...patch }];
    },
    [modelAliases]
  );

  const handleAddModel = useCallback(() => {
    const rowId = newCustomRowId();
    const placeholder = newPlaceholderModelName(rowId);
    onCustomModelsChange([...customModels, placeholder]);
    onModelAliasesChange([
      ...modelAliases,
      { displayName: "", alias: placeholder, icon: undefined, rowId },
    ]);
    if (onEnabledModelsChange && !enabledModels.includes(placeholder)) {
      onEnabledModelsChange([...enabledModels, placeholder]);
    }
    setTestError(null);
  }, [
    customModels,
    enabledModels,
    modelAliases,
    onCustomModelsChange,
    onEnabledModelsChange,
    onModelAliasesChange,
  ]);

  const handleRemove = useCallback(
    (modelName: string) => {
      onCustomModelsChange(customModels.filter((m) => m !== modelName));
      onModelAliasesChange(
        modelAliases.filter((entry) => entry.alias !== modelName)
      );
      if (onEnabledModelsChange && enabledModels.includes(modelName)) {
        onEnabledModelsChange(
          enabledModels.filter((model) => model !== modelName)
        );
      }
      setTestError(null);
    },
    [
      customModels,
      enabledModels,
      modelAliases,
      onCustomModelsChange,
      onEnabledModelsChange,
      onModelAliasesChange,
    ]
  );

  const handleIconChange = useCallback(
    (modelName: string, icon: string) => {
      onModelAliasesChange(
        findOrCreateAlias(modelName, { icon: icon || undefined })
      );
    },
    [findOrCreateAlias, onModelAliasesChange]
  );

  const handleModelNameChange = useCallback(
    (oldName: string, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed || (trimmed !== oldName && customModels.includes(trimmed)))
        return;

      onCustomModelsChange(
        customModels.map((model) => (model === oldName ? trimmed : model))
      );

      onModelAliasesChange(
        modelAliases.map((entry) =>
          entry.alias === oldName ? { ...entry, alias: trimmed } : entry
        )
      );

      if (onEnabledModelsChange) {
        const oldEnabledIndex = enabledModels.indexOf(oldName);
        if (oldEnabledIndex >= 0) {
          const nextEnabled = [...enabledModels];
          nextEnabled[oldEnabledIndex] = trimmed;
          onEnabledModelsChange(nextEnabled);
        }
      }
    },
    [
      customModels,
      enabledModels,
      modelAliases,
      onCustomModelsChange,
      onEnabledModelsChange,
      onModelAliasesChange,
    ]
  );

  const handleModelNameBlur = useCallback(
    async (currentName: string) => {
      if (!onTestModel) return;
      const trimmed = currentName.trim();
      if (!trimmed || isPlaceholderModelName(trimmed)) return;

      setTestError(null);
      try {
        const result = await onTestModel(trimmed);
        if (!result.available) {
          setTestError(result.message);
        }
      } catch {
        setTestError("Failed to test model");
      }
    },
    [onTestModel]
  );

  const handleDisplayNameChange = useCallback(
    (modelName: string, displayName: string) => {
      onModelAliasesChange(findOrCreateAlias(modelName, { displayName }));
    },
    [findOrCreateAlias, onModelAliasesChange]
  );

  return {
    testError,
    setTestError,
    iconOptions,
    handleAddModel,
    handleRemove,
    handleIconChange,
    handleModelNameChange,
    handleModelNameBlur,
    handleDisplayNameChange,
  };
}
