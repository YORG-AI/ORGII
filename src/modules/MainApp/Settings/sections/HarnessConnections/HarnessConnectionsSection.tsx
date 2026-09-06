import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import { saveKey } from "@src/api/services/keyValidation";
import type { ConnectionHarness } from "@src/api/tauri/rpc/schemas/agentOrgs";
import type { SaveKeyRequest } from "@src/api/types/keys";
import Message from "@src/components/Message";
import SegmentedTextPill from "@src/components/SegmentedTextPill";
import InlineCredentialImport from "@src/modules/MainApp/Integrations/KeyVault/CliClients/CredentialImport/InlineCredentialImport";
import { KeyVaultWizard } from "@src/scaffold/WizardSystem/variants/KeyVault";

import HarnessConnectionEditor from "./HarnessConnectionEditor";
import { refreshHarnessConnections } from "./useHarnessConnection";

export default function HarnessConnectionsSection() {
  const { t } = useTranslation("settings");
  const [target, setTarget] = useState<ConnectionHarness>("claude_code");
  const [adding, setAdding] = useState(false);
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
      <div className="overflow-x-auto">
        <SegmentedTextPill<ConnectionHarness>
          ariaLabel={t("harnessConnections.appSelector")}
          value={target}
          onChange={setTarget}
          options={[
            { value: "claude_code", label: "Claude Code CLI" },
            { value: "claude_desktop", label: "Claude Desktop" },
            { value: "codex", label: "Codex" },
          ]}
        />
      </div>
      <InlineCredentialImport onAfterImport={refreshHarnessConnections} />
      <HarnessConnectionEditor
        key={target}
        agentName={target}
        onAdd={() => setAdding(true)}
      />
    </div>
  );
}
