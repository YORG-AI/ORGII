import { CheckCircle2, KeyRound, TriangleAlert } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { rpc } from "@src/api/tauri/rpc";
import type { KeyInfo } from "@src/api/tauri/rpc/schemas/validation";
import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import Select, { type SelectOption } from "@src/components/Select";
import {
  WIZARD_IDS,
  buildIntegrationsPath,
  buildWizardPath,
} from "@src/config/mainAppPaths";
import { createLogger } from "@src/hooks/logger";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import {
  SESSION_MEMORY_EMBEDDING_PROVIDERS,
  type SessionMemoryEmbeddingConfig,
  type SessionMemoryEmbeddingProvider,
  readSessionMemoryEmbeddingConfig,
  sessionMemoryEmbeddingFingerprint,
} from "./sessionMemoryEmbeddingConfig";

const log = createLogger("SessionMemoryEmbeddingPanel");

const PROVIDER_LABELS: Record<SessionMemoryEmbeddingProvider, string> = {
  disabled: "sessionMemoryEmbedding.providers.disabled",
  local_qwen: "sessionMemoryEmbedding.providers.localQwen",
  local_coderank: "sessionMemoryEmbedding.providers.localCodeRank",
  embedding_api: "sessionMemoryEmbedding.providers.embeddingApi",
};

function isFreshVerifiedCredential(key: KeyInfo): boolean {
  if (!key.enabled || !key.has_api_key || key.health_status !== "valid") {
    return false;
  }
  const validatedAt = key.last_validated_at
    ? Date.parse(key.last_validated_at)
    : Number.NaN;
  return (
    Number.isFinite(validatedAt) &&
    Date.now() - validatedAt <= 24 * 60 * 60 * 1_000
  );
}

const SessionMemoryEmbeddingPanel: React.FC = () => {
  const { t } = useTranslation("integrations");
  const navigate = useNavigate();
  const [config, setConfig] = useState<SessionMemoryEmbeddingConfig>(() =>
    readSessionMemoryEmbeddingConfig(undefined)
  );
  const [savedConfig, setSavedConfig] =
    useState<SessionMemoryEmbeddingConfig | null>(null);
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reembedRequired, setReembedRequired] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [integrations, listedKeys] = await Promise.all([
        rpc.integrations.get(),
        rpc.validation.listKeys(),
      ]);
      const next = readSessionMemoryEmbeddingConfig(
        (integrations as Record<string, unknown>).embedding
      );
      setConfig(next);
      setSavedConfig(next);
      setKeys(listedKeys.filter((key) => key.agent_type === "zenmux_api"));
      setReembedRequired(false);
    } catch (err: unknown) {
      log.error("[SessionMemoryEmbeddingPanel] load failed", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const providerOptions = useMemo<SelectOption[]>(
    () =>
      SESSION_MEMORY_EMBEDDING_PROVIDERS.map((provider) => ({
        value: provider,
        label: t(PROVIDER_LABELS[provider]),
      })),
    [t]
  );

  const fingerprint = sessionMemoryEmbeddingFingerprint(config);
  const savedFingerprint = savedConfig
    ? sessionMemoryEmbeddingFingerprint(savedConfig)
    : fingerprint;
  const fingerprintChanged = fingerprint !== savedFingerprint;
  const credential = keys.find(isFreshVerifiedCredential) ?? null;
  const credentialReady = credential != null;

  const updateOptionalNumber = useCallback((value: string) => {
    const number = Number(value);
    setConfig((previous) => ({
      ...previous,
      dimensions: Number.isFinite(number) && number > 0 ? number : undefined,
    }));
  }, []);

  const updateRequiredNumber = useCallback(
    (
      field:
        | "minTokenDelta"
        | "minIntervalSecs"
        | "requestTimeoutSecs"
        | "maxInputChars",
      value: string
    ) => {
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) return;
      setConfig((previous) => ({
        ...previous,
        [field]: number,
      }));
    },
    []
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await rpc.integrations.updatePatch({ patch: { embedding: config } });
      if (fingerprintChanged) setReembedRequired(true);
      setSavedConfig(config);
    } catch (err: unknown) {
      log.error("[SessionMemoryEmbeddingPanel] save failed", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [config, fingerprintChanged]);

  const openKeyVault = useCallback(() => {
    navigate(
      buildWizardPath(
        buildIntegrationsPath({ category: "models" }),
        WIZARD_IDS.KEY_ADD
      )
    );
  }, [navigate]);

  return (
    <SectionContainer title={t("sessionMemoryEmbedding.title")}>
      <SectionRow label={t("sessionMemoryEmbedding.description")} align="start">
        <span className="text-xs text-text-3">
          {t("sessionMemoryEmbedding.autoRun")}
        </span>
      </SectionRow>
      <SectionRow
        label={t("sessionMemoryEmbedding.provider.label")}
        description={t("sessionMemoryEmbedding.provider.description")}
      >
        <Select
          value={config.provider}
          options={providerOptions}
          onChange={(value) =>
            setConfig((previous) => ({
              ...previous,
              provider: value as SessionMemoryEmbeddingProvider,
            }))
          }
          disabled={loading}
          style={SECTION_CONTROL_STYLE}
          dataTestId="session-memory-embedding-provider"
        />
      </SectionRow>
      <SectionRow
        label={t("sessionMemoryEmbedding.model.label")}
        description={t("sessionMemoryEmbedding.model.description")}
      >
        <Input
          value={config.model ?? ""}
          onChange={(model) =>
            setConfig((previous) => ({
              ...previous,
              model: model || undefined,
            }))
          }
          disabled={loading}
          placeholder={t("sessionMemoryEmbedding.model.placeholder")}
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>
      <SectionRow
        label={t("sessionMemoryEmbedding.localBaseUrl.label")}
        description={t("sessionMemoryEmbedding.localBaseUrl.description")}
      >
        <Input
          value={config.localBaseUrl ?? ""}
          onChange={(localBaseUrl) =>
            setConfig((previous) => ({
              ...previous,
              localBaseUrl: localBaseUrl || undefined,
            }))
          }
          disabled={loading}
          placeholder="http://localhost:8000/v1"
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>
      <SectionRow
        label={t("sessionMemoryEmbedding.dimensions.label")}
        description={t("sessionMemoryEmbedding.dimensions.description")}
      >
        <Input
          type="number"
          value={config.dimensions?.toString() ?? ""}
          onChange={updateOptionalNumber}
          disabled={loading}
          min={1}
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>
      <SectionRow
        label={t("sessionMemoryEmbedding.minTokenDelta.label")}
        description={t("sessionMemoryEmbedding.minTokenDelta.description")}
      >
        <Input
          type="number"
          value={config.minTokenDelta.toString()}
          onChange={(value) => updateRequiredNumber("minTokenDelta", value)}
          disabled={loading}
          min={1}
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>
      <SectionRow
        label={t("sessionMemoryEmbedding.minIntervalSecs.label")}
        description={t("sessionMemoryEmbedding.minIntervalSecs.description")}
      >
        <Input
          type="number"
          value={config.minIntervalSecs.toString()}
          onChange={(value) => updateRequiredNumber("minIntervalSecs", value)}
          disabled={loading}
          min={1}
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>
      <SectionRow
        label={t("sessionMemoryEmbedding.requestTimeoutSecs.label")}
        description={t("sessionMemoryEmbedding.requestTimeoutSecs.description")}
      >
        <Input
          type="number"
          value={config.requestTimeoutSecs.toString()}
          onChange={(value) =>
            updateRequiredNumber("requestTimeoutSecs", value)
          }
          disabled={loading}
          min={1}
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>
      <SectionRow
        label={t("sessionMemoryEmbedding.maxInputChars.label")}
        description={t("sessionMemoryEmbedding.maxInputChars.description")}
      >
        <Input
          type="number"
          value={config.maxInputChars.toString()}
          onChange={(value) => updateRequiredNumber("maxInputChars", value)}
          disabled={loading}
          min={1}
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>
      <SectionRow
        label={t("sessionMemoryEmbedding.fingerprint.label")}
        description={t("sessionMemoryEmbedding.fingerprint.description")}
      >
        <code className="break-all text-xs text-text-2">{fingerprint}</code>
      </SectionRow>

      {config.provider === "embedding_api" && (
        <SectionRow
          label={t("sessionMemoryEmbedding.credential.label")}
          description={t("sessionMemoryEmbedding.credential.description")}
        >
          <div className="flex items-center gap-2">
            {credentialReady ? (
              <CheckCircle2 size={16} className="text-success-6" />
            ) : (
              <TriangleAlert size={16} className="text-warning-6" />
            )}
            <span className="text-xs text-text-2">
              {credentialReady
                ? t("sessionMemoryEmbedding.credential.verified", {
                    name: credential?.name ?? credential?.id,
                  })
                : t("sessionMemoryEmbedding.credential.missing")}
            </span>
            <Button
              size="small"
              variant="secondary"
              icon={<KeyRound size={14} />}
              onClick={openKeyVault}
            >
              {t("sessionMemoryEmbedding.credential.add")}
            </Button>
          </div>
        </SectionRow>
      )}

      {(fingerprintChanged || reembedRequired) && (
        <InlineAlert
          type="warning"
          title={t("sessionMemoryEmbedding.reembed.title")}
        >
          {t("sessionMemoryEmbedding.reembed.description")}
        </InlineAlert>
      )}
      {error && <InlineAlert type="danger">{error}</InlineAlert>}
      <SectionRow showHeader={false}>
        <div className="flex w-full justify-end">
          <div className={SECTION_ACTION_GAP_CLASSES}>
            <Button
              size="small"
              variant="secondary"
              onClick={() => void load()}
              disabled={loading || saving}
            >
              {t("common:actions.refresh")}
            </Button>
            <Button
              size="small"
              variant="primary"
              onClick={() => void handleSave()}
              disabled={loading || saving}
              data-testid="session-memory-embedding-save"
            >
              {t("common:actions.save")}
            </Button>
          </div>
        </div>
      </SectionRow>
    </SectionContainer>
  );
};

export default SessionMemoryEmbeddingPanel;
