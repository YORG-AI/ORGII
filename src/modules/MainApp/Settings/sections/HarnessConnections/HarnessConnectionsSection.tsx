import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import { saveKey } from "@src/api/services/keyValidation";
import type { SaveKeyRequest } from "@src/api/types/keys";
import Button from "@src/components/Button";
import Message from "@src/components/Message";
import InlineCredentialImport from "@src/modules/MainApp/Integrations/KeyVault/CliClients/CredentialImport/InlineCredentialImport";
import { KeyVaultWizard } from "@src/scaffold/WizardSystem/variants/KeyVault";

import HarnessConnectionEditor from "./HarnessConnectionEditor";
import { refreshHarnessConnections } from "./useHarnessConnection";

export default function HarnessConnectionsSection() {
  const { t } = useTranslation("settings");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const submit = async (data: SaveKeyRequest) => {
    setSaving(true);
    try {
      await saveKey(data);
      setAdding(false);
      refreshHarnessConnections();
    } catch (error) {
      Message.error({ content: String(error) });
    } finally {
      setSaving(false);
    }
  };
  if (adding)
    return (
      <KeyVaultWizard
        initialAgentType="custom_api"
        primaryProvidersOnly={false}
        title={t("harnessConnections.add")}
        loading={saving}
        onSubmit={(data) => void submit(data)}
        onCancel={() => setAdding(false)}
      />
    );
  return (
    <div
      className="flex flex-col gap-4"
      data-testid="harness-connections-settings"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-text-3">{t("harnessConnections.description")}</p>
        <Button
          variant="secondary"
          onClick={() => setImporting(!importing)}
          aria-expanded={importing}
        >
          {t("harnessConnections.import")}
        </Button>
      </div>
      {importing && (
        <InlineCredentialImport
          sourceKind="cc_switch"
          forceExpanded
          onCompleted={() => setImporting(false)}
          onAfterImport={refreshHarnessConnections}
        />
      )}
      <HarnessConnectionEditor
        agentName="claude_code"
        onAdd={() => setAdding(true)}
      />
      <HarnessConnectionEditor
        agentName="codex"
        onAdd={() => setAdding(true)}
      />
    </div>
  );
}
