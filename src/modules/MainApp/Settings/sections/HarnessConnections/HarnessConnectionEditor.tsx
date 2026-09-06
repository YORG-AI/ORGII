import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import type { ConnectionHarness } from "@src/api/tauri/rpc/schemas/agentOrgs";
import Button from "@src/components/Button";
import Select from "@src/components/Select";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import {
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
  const [busy, setBusy] = useState<"test" | "apply" | "restore" | null>(null);
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
  }, [selectedKey, selectedModel, choice?.endpoint]);

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
          receipt,
          expectedHashes: Object.fromEntries(
            (view?.config.targetFiles ?? []).map((target) => [
              target.id,
              target.currentHash ?? null,
            ])
          ),
        });
        if (revision.current !== current) return;
        setMessage(t("harnessConnections.applied"));
        refreshHarnessConnections();
      } else {
        await rpc.agentOrgs.managedConfig.restoreDefault({
          agentName,
          force: false,
        });
        if (revision.current !== current) return;
        setMessage(t("harnessConnections.restored"));
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
  const blocked =
    !view?.installed ||
    loading ||
    busy !== null ||
    !choice ||
    Boolean(choice.reason) ||
    !selectedModel ||
    Boolean(view?.config.conflict);
  return (
    <SectionContainer title={agentName === "codex" ? "Codex" : "Claude Code"}>
      <SectionRow
        label={t("harnessConnections.current")}
        description={t("harnessConnections.scope")}
      >
        <span>
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
        <p role="status" className="text-warning-6">
          {t("harnessConnections.notInstalled")}
        </p>
      )}
      {view?.config.conflict && (
        <p role="alert" className="text-warning-6">
          {t("harnessConnections.conflict")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-danger-6">
          {error}
        </p>
      )}
      <SectionRow label={t("harnessConnections.connection")}>
        <Select
          aria-label={t("harnessConnections.connection")}
          value={selectedKey || undefined}
          disabled={loading || busy !== null}
          placeholder={t("harnessConnections.choose")}
          options={(view?.choices ?? []).map((choice) => ({
            value: choice.keyId,
            label: choice.name,
          }))}
          onChange={(value) => {
            setKeyId(String(value));
            setModel(null);
            setReceipt(null);
            setMessage(null);
          }}
        />
        <Button variant="secondary" onClick={onAdd} disabled={busy !== null}>
          {t("harnessConnections.add")}
        </Button>
      </SectionRow>
      {choice?.reason && (
        <p role="alert" className="text-warning-6">
          {choice.reason}
        </p>
      )}
      {!loading && view?.choices.length === 0 && (
        <p className="text-text-3">{t("harnessConnections.empty")}</p>
      )}
      <SectionRow label={t("harnessConnections.model")}>
        <Select
          aria-label={t("harnessConnections.model")}
          value={selectedModel || undefined}
          disabled={loading || busy !== null || !choice}
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
      {choice?.endpoint && (
        <p className="break-all text-text-3">{choice.endpoint}</p>
      )}
      <SectionRow
        label={t("harnessConnections.routing")}
        description={t(
          routing === "direct"
            ? "harnessConnections.directHelp"
            : "harnessConnections.proxyHelp"
        )}
      >
        <Button
          variant="secondary"
          onClick={() => setAdvanced(!advanced)}
          aria-expanded={advanced}
        >
          {t("harnessConnections.advanced")}
        </Button>
      </SectionRow>
      {advanced && (
        <SectionRow label={t("harnessConnections.routing")}>
          <Select
            aria-label={t("harnessConnections.routing")}
            value={routing}
            disabled={busy !== null}
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
      <p className="text-text-3">{t("harnessConnections.testHelp")}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={blocked}
          loading={busy === "test"}
          onClick={() => void act("test")}
        >
          {t("harnessConnections.test")}
        </Button>
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
            view.config.mode === "default" ||
            view.config.conflict
          }
          onClick={() => void act("restore")}
        >
          {t("harnessConnections.restore")}
        </Button>
        <Button
          variant="secondary"
          disabled={busy !== null}
          onClick={() => void reload()}
        >
          {t("harnessConnections.refresh")}
        </Button>
      </div>
      <p role="status" aria-live="polite" className="text-text-2">
        {message ??
          (loading
            ? t("harnessConnections.loading")
            : choice?.requiresTest && !receipt
              ? t("harnessConnections.testRequired")
              : t("harnessConnections.untested"))}
      </p>
      <p className="text-text-3">{t("harnessConnections.credentialsNote")}</p>
    </SectionContainer>
  );
}
