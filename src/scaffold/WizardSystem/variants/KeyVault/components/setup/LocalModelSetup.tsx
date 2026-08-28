import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import { LOCAL_MODEL_PROVIDER } from "@src/api/types/keys";
import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import { HugeiconsIcon, Tick01Icon } from "@src/icons";
import {
  SECTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import type { AgentSetupProps } from "./types";

type LocalRuntime =
  | "ollama"
  | "lm_studio"
  | "vllm"
  | "vllm_minicpm"
  | "sglang_minicpm"
  | "llamacpp"
  | "custom";

type LocalPreset = {
  runtime: LocalRuntime;
  baseUrl: string;
  apiKey: string;
  models: string[];
};

const DEFAULT_LOCAL_ACCOUNT_NAME = "Local Models";

const LOCAL_PRESETS: Record<LocalRuntime, LocalPreset> = {
  ollama: {
    runtime: "ollama",
    baseUrl: "http://localhost:11434/v1",
    apiKey: "ollama-local",
    models: ["llama3.2", "qwen2.5", "mistral"],
  },
  lm_studio: {
    runtime: "lm_studio",
    baseUrl: "http://localhost:1234/v1",
    apiKey: "lm-studio-local",
    models: ["local-model"],
  },
  vllm: {
    runtime: "vllm",
    baseUrl: "http://localhost:8000/v1",
    apiKey: "vllm-local",
    models: ["meta-llama/Llama-3.1-8B-Instruct"],
  },
  vllm_minicpm: {
    runtime: "vllm_minicpm",
    baseUrl: "http://127.0.0.1:8000/v1",
    apiKey: "vllm-local",
    models: ["openbmb/MiniCPM5-1B"],
  },
  sglang_minicpm: {
    runtime: "sglang_minicpm",
    baseUrl: "http://127.0.0.1:30000/v1",
    apiKey: "sglang-local",
    models: ["openbmb/MiniCPM5-1B"],
  },
  llamacpp: {
    runtime: "llamacpp",
    baseUrl: "http://localhost:8080/v1",
    apiKey: "llama-cpp-local",
    models: ["local-gguf"],
  },
  custom: {
    runtime: "custom",
    baseUrl: "http://localhost:8000/v1",
    apiKey: "local-model",
    models: ["local-model"],
  },
};

function mergeUniqueModels(existingModels: string[], presetModels: string[]) {
  const merged = [...existingModels];
  for (const model of presetModels) {
    if (!merged.includes(model)) merged.push(model);
  }
  return merged;
}

function isLocalRuntime(
  value: string | null | undefined
): value is LocalRuntime {
  return Boolean(value && value in LOCAL_PRESETS);
}

const LocalModelSetup: React.FC<AgentSetupProps> = ({
  data,
  onChange,
  keyValidated,
  validatingKey,
  validateKey,
}) => {
  const { t } = useTranslation("integrations");
  const [searchParams] = useSearchParams();
  const requestedRuntime = searchParams.get("localRuntime");
  const [cookbookDismissed, setCookbookDismissed] = useState(false);

  const selectedRuntime = useMemo<LocalRuntime>(() => {
    if (isLocalRuntime(requestedRuntime)) return requestedRuntime;
    if (isLocalRuntime(data.setup_method)) return data.setup_method;
    const currentUrl = data.extracted_base_url;
    const match = Object.values(LOCAL_PRESETS).find(
      (preset) => preset.baseUrl === currentUrl
    );
    return match?.runtime ?? "ollama";
  }, [data.extracted_base_url, data.setup_method, requestedRuntime]);
  const selectedPreset = LOCAL_PRESETS[selectedRuntime];
  const effectiveBaseUrl = data.extracted_base_url || selectedPreset.baseUrl;

  useEffect(() => {
    if (data.name.trim() || data.agent_type !== LOCAL_MODEL_PROVIDER) return;
    onChange({ name: DEFAULT_LOCAL_ACCOUNT_NAME });
  }, [data.agent_type, data.name, onChange]);

  useEffect(() => {
    if (!isLocalRuntime(data.setup_method) && !isLocalRuntime(requestedRuntime))
      return;
    if (data.extracted_base_url) return;
    const preset = LOCAL_PRESETS[selectedRuntime];
    onChange({
      raw_key_input: data.raw_key_input.trim() || preset.apiKey,
      extracted_base_url: preset.baseUrl,
      custom_models: mergeUniqueModels(data.custom_models ?? [], preset.models),
      enabled_models: mergeUniqueModels(
        data.enabled_models ?? [],
        preset.models
      ),
      validated: false,
    });
  }, [
    data.custom_models,
    data.enabled_models,
    data.extracted_base_url,
    data.raw_key_input,
    data.setup_method,
    onChange,
    requestedRuntime,
    selectedRuntime,
  ]);

  const modelQuickAddOptions = useMemo(
    () =>
      selectedPreset.models.map((model) => ({
        value: model,
        label: model,
      })),
    [selectedPreset.models]
  );

  const addModel = (model: string) => {
    const trimmedModel = model.trim();
    if (!trimmedModel) return;
    onChange({
      custom_models: mergeUniqueModels(data.custom_models ?? [], [
        trimmedModel,
      ]),
      enabled_models: mergeUniqueModels(data.enabled_models ?? [], [
        trimmedModel,
      ]),
    });
  };

  return (
    <div className={SECTION_GAP_CLASSES}>
      {!cookbookDismissed && (
        <InlineAlert
          type="info"
          title={t("keyVault.localModel.title")}
          onClose={() => setCookbookDismissed(true)}
        >
          {t("keyVault.localModel.description")}
        </InlineAlert>
      )}

      <SectionContainer>
        <SectionRow
          label={t("keyVault.baseUrlLabel")}
          description={t("keyVault.localModel.baseUrlDesc")}
          layout="vertical"
          required
        >
          <Input
            value={effectiveBaseUrl}
            onChange={(value) =>
              onChange({ extracted_base_url: value, validated: false })
            }
            placeholder={selectedPreset.baseUrl}
            size="default"
            className="w-full"
          />
        </SectionRow>

        <SectionRow
          label={t("keyVault.apiKeyLabel")}
          description={t("keyVault.localModel.apiKeyDesc")}
          layout="vertical"
        >
          <Input
            value={data.raw_key_input}
            onChange={(value) =>
              onChange({ raw_key_input: value, validated: false })
            }
            placeholder={selectedPreset.apiKey}
            size="default"
            className="w-full"
          />
        </SectionRow>
      </SectionContainer>

      <SectionContainer>
        <SectionRow
          label={t("keyVault.localModel.quickModelsLabel")}
          description={t("keyVault.localModel.quickModelsDesc")}
          required
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Select
              value=""
              placeholder={t("keyVault.localModel.quickModelsPlaceholder")}
              options={modelQuickAddOptions}
              onChange={(value) => addModel(value as string)}
              size="default"
              className="min-w-0 flex-1"
            />
            <Button
              variant="secondary"
              appearance="outline"
              size="default"
              icon={
                <HugeiconsIcon icon={Tick01Icon} data-icon="check" size={14} />
              }
              onClick={() => addModel(selectedPreset.models[0])}
            >
              {t("keyVault.localModel.addSuggestedModel")}
            </Button>
          </div>
        </SectionRow>

        <SectionRow
          label={t("keyVault.validate", "Validate")}
          description={t("keyVault.localModel.validateDesc")}
          required
        >
          <Button
            variant={keyValidated ? "success" : "primary"}
            appearance={keyValidated ? "outline" : undefined}
            size="default"
            loading={validatingKey}
            disabled={validatingKey || !effectiveBaseUrl}
            onClick={validateKey}
            className="h-8 min-h-8"
          >
            {keyValidated
              ? `✓ ${t("keyVault.validated", "Validated")}`
              : t("keyVault.validate", "Validate")}
          </Button>
        </SectionRow>
      </SectionContainer>
    </div>
  );
};

export { LocalModelSetup };
