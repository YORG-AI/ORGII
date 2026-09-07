import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import type { ConnectionHarness } from "@src/api/tauri/rpc/schemas/agentOrgs";
import Button from "@src/components/Button";
import Message from "@src/components/Message";
import Select from "@src/components/Select";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_CONTROL_STYLE,
  SECTION_DESCRIPTION_CLASSES,
  SECTION_VALUE_SMALL_MUTED_CLASSES,
  SECTION_VALUE_SMALL_SECONDARY_CLASSES,
  SECTION_VALUE_TEXT_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { HintWithInfo } from "@src/modules/shared/layouts/blocks/HintWithInfo";

import ConnectionCards from "./ConnectionCards";
import DesktopConnectionFields from "./DesktopConnectionFields";
import {
  readHarnessConnection,
  refreshHarnessConnections,
  useHarnessConnection,
} from "./useHarnessConnection";

export default function HarnessConnectionEditor({
  agentName,
  onAdd,
}: {
  agentName: ConnectionHarness;
  onAdd: () => void;
}) {
  const { t } = useTranslation("settings");
  const desktop = agentName === "claude_desktop";
  const [endpointOverride, setEndpointOverride] = useState<string | null>(null);
  const [authOverride, setAuthOverride] = useState<
    "bearer" | "x-api-key" | null
  >(null);
  const { view, error, loading, reload } = useHarnessConnection(agentName);
  const [keyId, setKeyId] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [routingOverride, setRouting] = useState<
    "direct" | "orgii_managed" | null
  >(null);
  const routing =
    routingOverride ??
    (view?.config.mode === "orgii_managed" ? "orgii_managed" : "direct");
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState<
    "test" | "apply" | "restore" | "copy" | null
  >(null);
  const [message, setMessage] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const request = useRef<string | null>(null);
  const revision = useRef(0);
  const selectedKey = keyId ?? view?.config.selectedKeyId ?? "";
  const choice = view?.choices.find((choice) => choice.keyId === selectedKey);
  const selectedModel =
    model ??
    (selectedKey === view?.config.selectedKeyId
      ? view?.config.selectedModel
      : null) ??
    choice?.models[0] ??
    "";

  const appliedDesktop =
    selectedKey === view?.config.selectedKeyId ? view?.desktopOptions : null;
  const endpoint =
    endpointOverride ?? appliedDesktop?.endpoint ?? choice?.endpoint ?? "";
  const authScheme =
    authOverride ??
    appliedDesktop?.authScheme ??
    (endpoint === "https://api.anthropic.com" ? "x-api-key" : "bearer");
  const desktopOptions = desktop ? { endpoint, authScheme } : undefined;
  const copyFromCli = async () => {
    const current = ++revision.current;
    setBusy("copy");
    try {
      const source = await readHarnessConnection("claude_code");
      if (revision.current !== current) return;
      if (source.config.conflict)
        throw new Error(t("harnessConnections.conflict"));
      if (source.config.mode === "default" || !source.config.selectedKeyId) {
        setMessage(t("harnessConnections.desktopCopyMissing"));
        return;
      }
      const sourceEndpoint =
        source.choices.find(
          (item) => item.keyId === source.config.selectedKeyId
        )?.endpoint ?? "";
      setKeyId(source.config.selectedKeyId);
      setModel(source.config.selectedModel ?? null);
      setEndpointOverride(sourceEndpoint);
      setAuthOverride(
        sourceEndpoint === "https://api.anthropic.com" ? "x-api-key" : "bearer"
      );
      setReceipt(null);
      setMessage(t("harnessConnections.desktopCopyReview"));
    } catch (error) {
      if (revision.current === current) setMessage(String(error));
    } finally {
      if (revision.current === current) setBusy(null);
    }
  };
  const cancel = () => {
    revision.current++;
    if (request.current) {
      void rpc.agentOrgs.connections
        .cancelTest({ requestId: request.current })
        .catch(() => undefined);
      request.current = null;
    }
    setBusy(null);
  };
  useEffect(
    () => () => {
      revision.current++;
      if (request.current)
        void rpc.agentOrgs.connections
          .cancelTest({ requestId: request.current })
          .catch(() => undefined);
    },
    []
  );
  useEffect(() => {
    setReceipt(null);
  }, [selectedKey, selectedModel, choice?.endpoint, endpoint, authScheme]);

  const act = async (action: "test" | "apply" | "restore") => {
    const current = ++revision.current;
    setBusy(action);
    setMessage(null);
    try {
      if (action === "test") {
        const requestId = crypto.randomUUID();
        request.current = requestId;
        const token = await rpc.agentOrgs.connections.test({
          agentName,
          keyId: selectedKey,
          model: selectedModel,
          requestId,
          ...(desktopOptions ? { desktopOptions } : {}),
        });
        if (revision.current !== current) return;
        request.current = null;
        setReceipt(token);
        setMessage(t("harnessConnections.testPassed"));
      } else if (action === "apply") {
        await rpc.agentOrgs.connections.apply({
          agentName,
          keyId: selectedKey,
          model: selectedModel,
          routing,
          ...(desktopOptions ? { desktopOptions } : {}),
          receipt,
          expectedHashes: Object.fromEntries(
            (view?.config.targetFiles ?? []).map((target) => [
              target.id,
              target.currentHash ?? null,
            ])
          ),
        });
        if (revision.current !== current) return;
        setMessage(
          t(
            desktop
              ? "harnessConnections.desktopApplied"
              : "harnessConnections.applied"
          )
        );
        refreshHarnessConnections();
      } else {
        await rpc.agentOrgs.managedConfig.restoreDefault({
          agentName,
          force: false,
        });
        if (revision.current !== current) return;
        setMessage(
          t(
            desktop
              ? "harnessConnections.desktopRestored"
              : "harnessConnections.restored"
          )
        );
        refreshHarnessConnections();
      }
    } catch (error) {
      if (revision.current === current) {
        setMessage(String(error));
        if (action === "test") setReceipt(null);
      }
    } finally {
      if (revision.current === current) {
        setBusy(null);
        request.current = null;
      }
    }
  };
  const handleRefresh = async () => {
    setMessage(null);
    const result = await reload();
    if (result.status === "updated") {
      Message.success({ content: t("harnessConnections.refreshed") });
    } else if (result.status === "failed") {
      Message.error({
        content: t("harnessConnections.refreshFailed", {
          error: result.error,
        }),
      });
    }
  };
  const blocked =
    !view?.installed ||
    !view.config.supported ||
    Boolean(view.configurationIssue) ||
    loading ||
    busy !== null ||
    !choice ||
    Boolean(choice.reason) ||
    !selectedModel ||
    Boolean(view?.config.conflict);
  const currentLabel = (
    <span className="flex items-center gap-1">
      {t("harnessConnections.current")}
      <HintWithInfo
        content={t(
          desktop
            ? "harnessConnections.desktopScope"
            : "harnessConnections.scope"
        )}
        position="right"
      />
    </span>
  );
  const connectionLabel = (
    <span className="flex items-center gap-1">
      {t("harnessConnections.connection")}
      {choice?.endpoint && (
        <HintWithInfo content={choice.endpoint} position="right" />
      )}
    </span>
  );
  const routingLabel = (
    <span className="flex items-center gap-1">
      {t("harnessConnections.routing")}
      <HintWithInfo
        content={
          <div className="flex max-w-[280px] flex-col gap-1">
            <span>
              {t(
                routing === "direct"
                  ? "harnessConnections.directHelp"
                  : "harnessConnections.proxyHelp"
              )}
            </span>
            {routing === "direct" && (
              <span>{t("harnessConnections.credentialsNote")}</span>
            )}
          </div>
        }
        position="right"
      />
    </span>
  );
  const statusMessage =
    message ??
    (!loading && choice?.requiresTest && !receipt
      ? t("harnessConnections.testRequired")
      : null);
  return (
    <SectionContainer
      title={
        desktop
          ? "Claude Desktop"
          : agentName === "codex"
            ? "Codex"
            : "Claude Code CLI"
      }
      dataTestId={`harness-connection-${agentName}`}
    >
      {desktop && (
        <SectionRow showHeader={false}>
          <div className="flex flex-col gap-2">
            <p className={SECTION_DESCRIPTION_CLASSES}>
              {t("harnessConnections.desktopScope")}
            </p>
            {view?.version && (
              <p className={SECTION_VALUE_SMALL_MUTED_CLASSES}>
                {t("harnessConnections.desktopVersion", {
                  version: view.version,
                })}
              </p>
            )}
            <Button
              variant="secondary"
              disabled={loading || busy !== null}
              onClick={() => void copyFromCli()}
            >
              {t("harnessConnections.desktopCopy")}
            </Button>
          </div>
        </SectionRow>
      )}
      {(view?.configurationIssue || view?.config.message) && (
        <SectionRow showHeader={false}>
          <p role="alert" className={SECTION_DESCRIPTION_CLASSES}>
            {view?.configurationIssue ?? view?.config.message}
          </p>
        </SectionRow>
      )}
      <SectionRow label={currentLabel}>
        <span className={SECTION_VALUE_TEXT_CLASSES}>
          {!view
            ? t("harnessConnections.loading")
            : view.config.mode === "default"
              ? t("harnessConnections.original")
              : (view?.choices.find(
                  (item) => item.keyId === view.config.selectedKeyId
                )?.name ?? t("harnessConnections.missingKey"))}
        </span>
      </SectionRow>
      {view && !view.installed && (
        <SectionRow showHeader={false} className="py-2">
          <p role="status" className={SECTION_DESCRIPTION_CLASSES}>
            <span className="text-warning-6">
              {t("harnessConnections.notInstalled")}
            </span>
          </p>
        </SectionRow>
      )}
      {view?.config.conflict && (
        <SectionRow showHeader={false} className="py-2">
          <p role="alert" className={SECTION_DESCRIPTION_CLASSES}>
            <span className="text-warning-6">
              {t("harnessConnections.conflict")}
            </span>
          </p>
        </SectionRow>
      )}
      {error && (
        <SectionRow showHeader={false} className="py-2">
          <p role="alert" className={SECTION_DESCRIPTION_CLASSES}>
            <span className="text-danger-6">{error}</span>
          </p>
        </SectionRow>
      )}
      <SectionRow label={connectionLabel}>
        <ConnectionCards
          choices={(view?.choices ?? []).map((item) =>
            desktop &&
            item.keyId === view?.config.selectedKeyId &&
            view.config.mode === "direct"
              ? {
                  ...item,
                  endpoint: view.desktopOptions?.endpoint ?? item.endpoint,
                }
              : item
          )}
          selected={selectedKey}
          active={
            view?.config.mode !== "default"
              ? (view?.config.selectedKeyId ?? null)
              : null
          }
          disabled={loading || busy !== null}
          onAdd={onAdd}
          onSelect={(value) => {
            setEndpointOverride(null);
            setAuthOverride(null);
            setKeyId(value);
            setModel(null);
            setReceipt(null);
            setMessage(null);
          }}
        />
      </SectionRow>
      {choice?.reason && (
        <SectionRow showHeader={false} className="py-2">
          <p role="alert" className={SECTION_DESCRIPTION_CLASSES}>
            <span className="text-warning-6">{choice.reason}</span>
          </p>
        </SectionRow>
      )}
      {!loading && view?.choices.length === 0 && (
        <SectionRow showHeader={false} className="py-2">
          <p className={SECTION_VALUE_SMALL_MUTED_CLASSES}>
            {t("harnessConnections.empty")}
          </p>
        </SectionRow>
      )}
      {desktop ? (
        <DesktopConnectionFields
          endpoint={endpoint}
          authScheme={authScheme}
          model={selectedModel}
          disabled={loading || busy !== null || !choice}
          onEndpoint={(value) => {
            setEndpointOverride(value);
            setReceipt(null);
            setMessage(null);
          }}
          onAuth={(value) => {
            setAuthOverride(value);
            setReceipt(null);
            setMessage(null);
          }}
          onModel={(value) => {
            setModel(value);
            setReceipt(null);
            setMessage(null);
          }}
        />
      ) : (
        <SectionRow label={t("harnessConnections.model")}>
          <Select
            ariaLabel={t("harnessConnections.model")}
            value={selectedModel || undefined}
            disabled={loading || busy !== null || !choice}
            style={SECTION_CONTROL_STYLE}
            options={(choice?.models ?? []).map((value) => ({
              value,
              label: value,
            }))}
            onChange={(value) => {
              setModel(String(value));
              setReceipt(null);
              setMessage(null);
            }}
          />
        </SectionRow>
      )}
      {!desktop && (
        <SectionRow label={routingLabel}>
          <Button
            variant="secondary"
            onClick={() => setAdvanced(!advanced)}
            aria-expanded={advanced}
          >
            {t("harnessConnections.advanced")}
          </Button>
        </SectionRow>
      )}
      {!desktop && advanced && (
        <SectionRow label={t("harnessConnections.routing")}>
          <Select
            ariaLabel={t("harnessConnections.routing")}
            value={routing}
            disabled={busy !== null}
            style={SECTION_CONTROL_STYLE}
            options={[
              { value: "direct", label: t("harnessConnections.direct") },
              { value: "orgii_managed", label: t("harnessConnections.proxy") },
            ]}
            onChange={(value) =>
              setRouting(value === "direct" ? "direct" : "orgii_managed")
            }
          />
        </SectionRow>
      )}
      <SectionRow showHeader={false} className="py-2">
        <div className={`${SECTION_ACTION_GAP_CLASSES} flex-wrap`}>
          <div className={SECTION_ACTION_GAP_CLASSES}>
            <Button
              variant="secondary"
              disabled={blocked}
              loading={busy === "test"}
              onClick={() => void act("test")}
            >
              {t("harnessConnections.test")}
            </Button>
            <HintWithInfo
              content={
                <div className="flex max-w-[280px] flex-col gap-1">
                  <span>{t("harnessConnections.testHelp")}</span>
                  <span>{t("harnessConnections.untested")}</span>
                </div>
              }
              position="bottom"
            />
          </div>
          {busy === "test" && (
            <Button variant="secondary" onClick={cancel}>
              {t("harnessConnections.cancel")}
            </Button>
          )}
          <Button
            disabled={blocked || (Boolean(choice?.requiresTest) && !receipt)}
            loading={busy === "apply"}
            onClick={() => void act("apply")}
          >
            {t("harnessConnections.apply")}
          </Button>
          <Button
            variant="secondary"
            disabled={
              loading ||
              busy !== null ||
              !view ||
              Boolean(view.configurationIssue) ||
              view.config.mode === "default" ||
              view.config.conflict
            }
            onClick={() => void act("restore")}
          >
            {t("harnessConnections.restore")}
          </Button>
          <Button
            variant="secondary"
            disabled={loading || busy !== null}
            loading={loading}
            onClick={() => void handleRefresh()}
          >
            {t("harnessConnections.refresh")}
          </Button>
        </div>
      </SectionRow>
      {statusMessage && (
        <SectionRow showHeader={false} className="py-2">
          <p
            role="status"
            aria-live="polite"
            className={SECTION_VALUE_SMALL_SECONDARY_CLASSES}
          >
            {statusMessage}
          </p>
        </SectionRow>
      )}
    </SectionContainer>
  );
}
