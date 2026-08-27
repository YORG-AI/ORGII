import { Copy, FolderOpen, Pencil } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import type { AvailableAgent } from "@src/api/tauri/rpc/schemas/validation";
import Button from "@src/components/Button";
import Message from "@src/components/Message";
import { CodeMirrorEditor } from "@src/features/CodeMirror/Editor";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_PATH_TEXT_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { copyText } from "@src/util/data/clipboard";

type CliConfigFile = AvailableAgent["configFiles"][number];

const FORMAT_EXTENSION: Record<CliConfigFile["format"], string> = {
  json: "json",
  jsonc: "jsonc",
  toml: "toml",
  yaml: "yaml",
  text: "txt",
};

interface CliRawConfigFileEditorProps {
  agentName: string;
  configFile: CliConfigFile;
  sectionTitle?: string;
  onSaved?: () => void;
}

const CliRawConfigFileEditor: React.FC<CliRawConfigFileEditorProps> = ({
  agentName,
  configFile,
  sectionTitle,
  onSaved,
}) => {
  const { t } = useTranslation("integrations");

  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [savedValue, setSavedValue] = useState("");
  const [configPath, setConfigPath] = useState(configFile.path);
  const [activeTab, setActiveTab] = useState<"edit" | "preview">("preview");
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const input = { agentName, fileId: configFile.id };
    async function load() {
      const path = await rpc.agentOrgs.cliConfigFiles.getPath(input);
      if (cancelled) return;
      setConfigPath(path);

      const raw = await rpc.agentOrgs.cliConfigFiles.readRaw(input);
      if (cancelled) return;
      setValue(raw);
      setSavedValue(raw);
      setActiveTab("preview");
      setLoading(false);
    }

    load().catch((err: unknown) => {
      if (!cancelled) {
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [agentName, configFile.id]);

  const hasChanges = value !== savedValue;
  const tokenCount = useMemo(() => Math.ceil(value.length / 4), [value]);

  const handleChange = useCallback((nextValue: string) => {
    setValue(nextValue);
    setErrorMessage(null);
    setSaveStatus("idle");
  }, []);

  const handleEdit = useCallback(() => {
    setActiveTab("edit");
  }, []);

  const handleSave = useCallback(async () => {
    setSaveStatus("saving");
    setErrorMessage(null);
    try {
      await rpc.agentOrgs.cliConfigFiles.writeRaw({
        agentName,
        fileId: configFile.id,
        content: value,
      });
      setSavedValue(value);
      setSaveStatus("saved");
      setActiveTab("preview");
      onSaved?.();
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setSaveStatus("error");
    }
  }, [agentName, configFile.id, value, onSaved]);

  const handleReset = useCallback(() => {
    setValue(savedValue);
    setActiveTab("preview");
    setErrorMessage(null);
    setSaveStatus("idle");
  }, [savedValue]);

  const handleCopy = useCallback(async () => {
    await copyText(value);
    Message.success(t("common:common.copied"));
  }, [t, value]);

  const handleRevealConfig = useCallback(() => {
    void rpc.agentOrgs.cliConfigFiles
      .reveal({ agentName, fileId: configFile.id })
      .catch((err: unknown) => {
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setSaveStatus("error");
      });
  }, [agentName, configFile.id]);

  if (loading) return null;

  const filePath = `${configFile.id}.${FORMAT_EXTENSION[configFile.format]}`;

  return (
    <SectionContainer title={sectionTitle}>
      <SectionRow
        label={configFile.label}
        description={configPath}
        labelAlign="start"
      >
        <div className={SECTION_ACTION_GAP_CLASSES}>
          <span className={SECTION_PATH_TEXT_CLASSES}>
            {t("agentOrgs.cliAgentDetail.tokenCount", {
              count: tokenCount,
            })}
          </span>
          {configFile.secretBearing && (
            <span className="text-xs text-warning-6">
              {t("agentOrgs.cliAgentDetail.secretBearingConfig")}
            </span>
          )}
          {saveStatus === "saved" && (
            <span className="text-xs text-success-6">
              {t("common:status.saved", "Saved")}
            </span>
          )}
          {errorMessage && (
            <span className="max-w-[240px] truncate text-xs text-danger-6">
              {errorMessage}
            </span>
          )}
          {activeTab !== "edit" && (
            <Button
              icon={<Pencil size={14} />}
              iconOnly
              onClick={handleEdit}
              aria-label={t("common:actions.edit")}
              title={t("common:actions.edit")}
              data-testid="agent-orgs-cli-config-edit-button"
            />
          )}
          <Button
            icon={<Copy size={14} />}
            iconOnly
            onClick={handleCopy}
            disabled={!value.trim()}
            aria-label={t("common:actions.copy")}
            title={t("common:actions.copy")}
          />
          <Button
            icon={<FolderOpen size={14} />}
            iconOnly
            onClick={handleRevealConfig}
            aria-label={t("agentOrgs.cliAgentDetail.revealConfigFile")}
            title={t("agentOrgs.cliAgentDetail.revealConfigFile")}
          />
          {activeTab === "edit" && (
            <>
              <Button
                size="default"
                onClick={handleReset}
                data-testid="agent-orgs-cli-config-cancel-button"
              >
                {t("common:actions.cancel")}
              </Button>
              <Button
                size="default"
                variant="primary"
                onClick={handleSave}
                disabled={!hasChanges || saveStatus === "saving"}
                data-testid="agent-orgs-cli-config-save-button"
              >
                {saveStatus === "saving"
                  ? `${t("common:actions.save")}...`
                  : t("common:actions.save")}
              </Button>
            </>
          )}
        </div>
      </SectionRow>
      <SectionRow showHeader={false} className="!pt-0">
        <div
          className="h-[360px] overflow-hidden rounded-lg border border-border-2"
          data-testid="agent-orgs-cli-config-editor"
        >
          <CodeMirrorEditor
            value={value}
            onChange={handleChange}
            filePath={filePath}
            height="100%"
            readOnly={activeTab !== "edit"}
            enableMinimap={false}
            enableDirtyDiff={false}
            registerWithService={false}
          />
        </div>
      </SectionRow>
    </SectionContainer>
  );
};

export default CliRawConfigFileEditor;
