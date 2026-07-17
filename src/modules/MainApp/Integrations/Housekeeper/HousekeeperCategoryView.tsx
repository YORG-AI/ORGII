import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import {
  type HousekeeperTokenBenchmarkResponse,
  housekeeperHealthCheck,
  housekeeperTokenBenchmark,
} from "@src/api/services/keyValidation";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select/types";
import Switch from "@src/components/Switch";
import TabPill from "@src/components/TabPill";
import {
  WIZARD_IDS,
  buildIntegrationsPath,
  buildWizardPath,
} from "@src/config/mainAppPaths";
import {
  HOUSEKEEPER_DEFAULT_BASE_URL,
  HOUSEKEEPER_DEFAULT_MODEL,
  useHousekeeperConfig,
} from "@src/hooks/housekeeper";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_CONTROL_STYLE,
  SECTION_VALUE_SMALL_MUTED_CLASSES,
  SECTION_VALUE_SMALL_SECONDARY_CLASSES,
  SECTION_VALUE_TEXT_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  InternalHeader,
  ScrollFadeContainer,
} from "@src/modules/shared/layouts/blocks";

type HealthState =
  | { status: "idle" }
  | { status: "checking" }
  | {
      status: "ready" | "error";
      ok: boolean;
      detail: string;
      maxModelLen?: number | null;
    };

type BenchmarkState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ready"; result: HousekeeperTokenBenchmarkResponse }
  | { status: "error"; detail: string };

function SummaryValue({ value }: { value: React.ReactNode }) {
  return (
    <span className={`${SECTION_VALUE_TEXT_CLASSES} min-w-0 truncate`}>
      {value}
    </span>
  );
}

function StatusValue({ children }: { children: React.ReactNode }) {
  return (
    <span className={`${SECTION_VALUE_SMALL_SECONDARY_CLASSES} min-w-0`}>
      {children}
    </span>
  );
}

function formatDescription(value: string): string {
  return value.replace(/[.。]+$/u, "");
}

const HOUSEKEEPER_TAB = "housekeeper";

export const HousekeeperCategoryView: React.FC = () => {
  const { t } = useTranslation("integrations");
  const navigate = useNavigate();
  const config = useHousekeeperConfig();
  const [health, setHealth] = useState<HealthState>({ status: "idle" });
  const [benchmark, setBenchmark] = useState<BenchmarkState>({
    status: "idle",
  });
  const tabs = useMemo(
    () => [
      {
        key: HOUSEKEEPER_TAB,
        label: t("settings:coreSidebar.items.housekeeper"),
      },
    ],
    [t]
  );

  const accountOptions = useMemo<SelectOption[]>(
    () => [
      {
        label: t("housekeeper.autoAccount"),
        value: "__auto__",
      },
      ...config.vllmAccounts.map((account) => ({
        label: `${account.name} (${account.baseUrl ?? HOUSEKEEPER_DEFAULT_BASE_URL})`,
        triggerLabel: account.name,
        value: account.id,
      })),
    ],
    [config.vllmAccounts, t]
  );

  const openAddMiniCPMAccount = () => {
    const accountsPath = `${buildIntegrationsPath({
      category: "models",
    })}?modelsTab=my-accounts&localRuntime=vllm_minicpm`;
    navigate(buildWizardPath(accountsPath, WIZARD_IDS.KEY_ADD));
  };

  const runHealthCheck = async () => {
    if (!config.resolvedAccountId) {
      setHealth({
        status: "error",
        ok: false,
        detail: t("housekeeper.health.configureFirst"),
      });
      return;
    }

    setHealth({ status: "checking" });
    try {
      const result = await housekeeperHealthCheck({
        accountId: config.resolvedAccountId,
        model: config.resolvedModel,
      });
      setHealth({
        status: result.ok ? "ready" : "error",
        ok: result.ok,
        detail: result.ok
          ? t("housekeeper.health.connectedTo", {
              baseUrl: result.baseUrl ?? HOUSEKEEPER_DEFAULT_BASE_URL,
            })
          : result.error || t("housekeeper.health.failed"),
        maxModelLen: result.maxModelLen,
      });
    } catch (error) {
      setHealth({
        status: "error",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const runTokenBenchmark = async () => {
    if (!config.resolvedAccountId) {
      setBenchmark({
        status: "error",
        detail: t("housekeeper.health.configureFirst"),
      });
      return;
    }

    setBenchmark({ status: "running" });
    try {
      const result = await housekeeperTokenBenchmark({
        accountId: config.resolvedAccountId,
        model: config.resolvedModel,
      });
      setBenchmark({ status: "ready", result });
    } catch (error) {
      setBenchmark({
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const checkedHealth =
    health.status === "ready" || health.status === "error" ? health : null;
  const benchmarkSummary =
    benchmark.status === "idle"
      ? t("housekeeper.benchmark.idle")
      : benchmark.status === "running"
        ? t("housekeeper.benchmark.running")
        : benchmark.status === "ready"
          ? t("housekeeper.benchmark.ready", {
              tokens: benchmark.result.completionTokens.toLocaleString(),
              seconds: (benchmark.result.elapsedMs / 1000).toFixed(2),
            })
          : benchmark.detail;

  const content = (
    <>
      <SectionContainer>
        <SectionRow
          label={t("housekeeper.title")}
          description={formatDescription(t("housekeeper.description"))}
          align="start"
        >
          <Button variant="secondary" onClick={openAddMiniCPMAccount}>
            {t("housekeeper.addModel")}
          </Button>
        </SectionRow>
        <SectionRow label={t("housekeeper.tiles.model")} indent>
          <SummaryValue
            value={config.resolvedModel || HOUSEKEEPER_DEFAULT_MODEL}
          />
        </SectionRow>
        <SectionRow label={t("housekeeper.tiles.endpoint")} indent>
          <SummaryValue
            value={
              config.resolvedAccount?.baseUrl ?? HOUSEKEEPER_DEFAULT_BASE_URL
            }
          />
        </SectionRow>
        <SectionRow label={t("housekeeper.tiles.safeContext")} indent>
          <SummaryValue
            value={`${config.contextLimitTokens.toLocaleString()} tokens`}
          />
        </SectionRow>
      </SectionContainer>

      <SectionContainer title={t("housekeeper.sections.configuration")}>
        <SectionRow
          label={t("housekeeper.settings.enabled.title")}
          description={formatDescription(
            t("housekeeper.settings.enabled.description")
          )}
        >
          <Switch
            checked={config.enabled}
            onChange={(checked) => config.setEnabled(checked)}
          />
        </SectionRow>
        <SectionRow
          label={t("housekeeper.settings.account.title")}
          description={formatDescription(
            t("housekeeper.settings.account.description")
          )}
        >
          <Select
            value={config.accountId ?? "__auto__"}
            options={accountOptions}
            size="default"
            style={SECTION_CONTROL_STYLE}
            dropdownMinWidth={280}
            onChange={(value) =>
              config.setAccountId(value === "__auto__" ? null : String(value))
            }
          />
        </SectionRow>
        <SectionRow
          label={t("housekeeper.settings.model.title")}
          description={formatDescription(
            t("housekeeper.settings.model.description")
          )}
        >
          <Input
            value={config.model}
            size="default"
            style={SECTION_CONTROL_STYLE}
            placeholder={HOUSEKEEPER_DEFAULT_MODEL}
            onChange={(value) =>
              config.setModel(value.trim() || HOUSEKEEPER_DEFAULT_MODEL)
            }
          />
        </SectionRow>
        <SectionRow
          label={t("housekeeper.settings.context.title")}
          description={formatDescription(
            t("housekeeper.settings.context.description")
          )}
        >
          <Input
            type="number"
            value={String(config.contextLimitTokens)}
            size="default"
            style={SECTION_CONTROL_STYLE}
            min={1024}
            max={32768}
            onChange={(value) => {
              const next = Number(value);
              if (Number.isFinite(next)) {
                config.setContextLimitTokens(next);
              }
            }}
          />
        </SectionRow>
      </SectionContainer>

      <SectionContainer title={t("housekeeper.sections.features")}>
        <SectionRow
          label={t("housekeeper.features.promptPolish.title")}
          description={formatDescription(
            t("housekeeper.features.promptPolish.description")
          )}
        >
          <Switch
            checked={config.features.promptPolish}
            disabled={!config.enabled}
            onChange={(checked) => config.setFeatures.promptPolish(checked)}
          />
        </SectionRow>
        <SectionRow
          label={t("housekeeper.features.stepExplain.title")}
          description={formatDescription(
            t("housekeeper.features.stepExplain.description")
          )}
        >
          <Switch
            checked={config.features.stepExplain}
            disabled={!config.enabled}
            onChange={(checked) => config.setFeatures.stepExplain(checked)}
          />
        </SectionRow>
        <SectionRow
          label={t("housekeeper.features.uiControl.title")}
          description={formatDescription(
            t("housekeeper.features.uiControl.description")
          )}
        >
          <Switch
            checked={config.features.uiControl}
            disabled={!config.enabled}
            onChange={(checked) => config.setFeatures.uiControl(checked)}
          />
        </SectionRow>
        <SectionRow
          label={t("housekeeper.features.contextCompact.title")}
          description={formatDescription(
            t("housekeeper.features.contextCompact.description")
          )}
        >
          <Switch
            checked={config.features.contextCompact}
            disabled={!config.enabled}
            onChange={(checked) => config.setFeatures.contextCompact(checked)}
          />
        </SectionRow>
      </SectionContainer>

      <SectionContainer title={t("housekeeper.sections.diagnostics")}>
        <SectionRow
          label={t("housekeeper.health.title")}
          description={
            health.status === "idle"
              ? formatDescription(t("housekeeper.health.idle"))
              : health.status === "checking"
                ? formatDescription(t("housekeeper.health.checking"))
                : formatDescription(health.detail)
          }
          align="start"
        >
          <div className={SECTION_ACTION_GAP_CLASSES}>
            <StatusValue>
              {checkedHealth?.maxModelLen
                ? `max_model_len=${checkedHealth.maxModelLen.toLocaleString()}`
                : t("housekeeper.health.status")}
            </StatusValue>
            <Button
              variant="secondary"
              loading={health.status === "checking"}
              onClick={runHealthCheck}
            >
              {t("housekeeper.health.checkButton")}
            </Button>
          </div>
        </SectionRow>
        <SectionRow
          label={t("housekeeper.benchmark.title")}
          description={formatDescription(benchmarkSummary)}
          align="start"
        >
          <div className={SECTION_ACTION_GAP_CLASSES}>
            <StatusValue>
              {benchmark.status === "ready"
                ? `${benchmark.result.tokensPerSecond.toFixed(1)} tokens/s`
                : t("housekeeper.benchmark.status")}
            </StatusValue>
            <Button
              variant="secondary"
              loading={benchmark.status === "running"}
              onClick={runTokenBenchmark}
            >
              {t("housekeeper.benchmark.checkButton")}
            </Button>
          </div>
        </SectionRow>
        {benchmark.status === "ready" ? (
          <SectionRow indent showHeader={false}>
            <div className="grid gap-2 @[640px]:grid-cols-3">
              <div className={SECTION_VALUE_SMALL_SECONDARY_CLASSES}>
                {t("housekeeper.benchmark.tokensPerSecond", {
                  value: benchmark.result.tokensPerSecond.toFixed(1),
                })}
              </div>
              <div className={SECTION_VALUE_SMALL_SECONDARY_CLASSES}>
                {t("housekeeper.benchmark.completionTokens", {
                  value: benchmark.result.completionTokens.toLocaleString(),
                })}
              </div>
              <div className={SECTION_VALUE_SMALL_SECONDARY_CLASSES}>
                {t("housekeeper.benchmark.elapsed", {
                  value: (benchmark.result.elapsedMs / 1000).toFixed(2),
                })}
              </div>
            </div>
          </SectionRow>
        ) : null}
        {benchmark.status === "ready" && benchmark.result.sampleText ? (
          <SectionRow indent showHeader={false}>
            <div className={SECTION_VALUE_SMALL_MUTED_CLASSES}>
              {benchmark.result.sampleText}
            </div>
          </SectionRow>
        ) : null}
      </SectionContainer>
    </>
  );

  return (
    <DetailPanelContainer>
      <InternalHeader
        noPanelHeader
        contentPadding
        className={DETAIL_PANEL_TOKENS.headerWidth}
        tabs={
          <TabPill
            tabs={tabs}
            activeTab={HOUSEKEEPER_TAB}
            onChange={() => undefined}
            variant="simple"
            fillWidth={false}
            size="large"
          />
        }
      />
      <ScrollFadeContainer
        className={`scroll-fade-at-top ${DETAIL_PANEL_TOKENS.scrollContentNoTop}`}
      >
        <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
          <div className="flex flex-col gap-3">{content}</div>
        </div>
      </ScrollFadeContainer>
    </DetailPanelContainer>
  );
};
