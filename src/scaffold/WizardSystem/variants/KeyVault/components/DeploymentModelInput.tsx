/**
 * DeploymentModelInput Component
 *
 * Shown for gateway accounts (Azure OpenAI, vLLM) when model auto-detection
 * returns no results. Lets users manually enter deployment/model names that
 * are available on their endpoint.
 *
 * When onTestModel is provided, each model is tested via a lightweight
 * completion request before being added to the list.
 */
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import {
  Add01Icon,
  Cancel01Icon,
  HugeiconsIcon,
  Refresh04Icon,
} from "@src/icons";

interface DeploymentModelInputProps {
  models: string[];
  onModelsChange: (models: string[]) => void;
  onTestModel?: (
    model: string
  ) => Promise<{ available: boolean; message: string }>;
  onRevalidate?: () => void;
  revalidating?: boolean;
  className?: string;
}

const DeploymentModelInput: React.FC<DeploymentModelInputProps> = ({
  models,
  onModelsChange,
  onTestModel,
  onRevalidate,
  revalidating = false,
  className = "",
}) => {
  const { t } = useTranslation("integrations");
  const [draft, setDraft] = useState("");
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const addModel = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed || models.includes(trimmed)) return;
      onModelsChange([...models, trimmed]);
    },
    [models, onModelsChange]
  );

  const handleAdd = useCallback(async () => {
    const trimmed = draft.trim();
    if (!trimmed || models.includes(trimmed)) return;

    setTestError(null);

    if (onTestModel) {
      setTesting(true);
      try {
        const result = await onTestModel(trimmed);
        if (!result.available) {
          setTestError(result.message);
          return;
        }
      } catch {
        setTestError("Failed to test model");
        return;
      } finally {
        setTesting(false);
      }
    }

    addModel(trimmed);
    setDraft("");
  }, [draft, models, addModel, onTestModel]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handleAdd();
      }
    },
    [handleAdd]
  );

  const handleRemove = useCallback(
    (index: number) => {
      onModelsChange(models.filter((_, idx) => idx !== index));
    },
    [models, onModelsChange]
  );

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      {!noticeDismissed && (
        <InlineAlert type="info" onClose={() => setNoticeDismissed(true)}>
          {t("keyVault.deploymentModels.description")}
        </InlineAlert>
      )}

      <div className="rounded-lg border border-border-2 bg-bg-1">
        {models.length > 0 && (
          <div className="flex flex-col gap-1 p-2">
            {models.map((model, index) => (
              <div
                key={model}
                className="flex items-center gap-2 rounded-md bg-fill-1 px-3 py-1.5"
              >
                <span className="flex-1 truncate text-[12px] text-text-1">
                  {model}
                </span>
                <button
                  type="button"
                  onClick={() => handleRemove(index)}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-3 transition-colors hover:bg-fill-2 hover:text-danger-6"
                >
                  <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 border-t border-border-2 p-2">
          <div className="flex-1" onKeyDown={handleKeyDown}>
            <Input
              value={draft}
              onChange={setDraft}
              placeholder={t("keyVault.deploymentModels.placeholder")}
              size="small"
            />
          </div>
          <Button
            variant="secondary"
            size="small"
            onClick={handleAdd}
            disabled={!draft.trim() || testing}
            loading={testing}
            icon={<HugeiconsIcon icon={Add01Icon} data-icon="plus" size={14} />}
          >
            {t("keyVault.deploymentModels.addModel")}
          </Button>
        </div>
      </div>

      {testError && (
        <InlineAlert type="danger" onClose={() => setTestError(null)}>
          {testError}
        </InlineAlert>
      )}

      {onRevalidate && models.length > 0 && (
        <Button
          variant="primary"
          appearance="outline"
          size="small"
          onClick={onRevalidate}
          loading={revalidating}
          disabled={revalidating}
          icon={
            <HugeiconsIcon
              icon={Refresh04Icon}
              data-icon="refresh-cw"
              size={14}
            />
          }
        >
          {t("keyVault.revalidate")}
        </Button>
      )}
    </div>
  );
};

export default DeploymentModelInput;
