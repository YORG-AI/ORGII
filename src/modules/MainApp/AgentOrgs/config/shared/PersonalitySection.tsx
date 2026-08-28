/**
 * Per-agent Personality editor.
 *
 * Edits `AgentDefinition.soul_content` for one specific agent (OS,
 * SDE, Wingman, or any custom agent). The value flows into the
 * prompt's `IdentitySection`
 * (order 10) on the next session for that agent.
 *
 * Drives the same `update(path, value)` interface used by every
 * other section in this directory (OSAgent / SdeAgent / Custom),
 * so the OS legacy-blob pipeline (`extractAgentDefPatch`) and the
 * direct `agentDef.updatePatch` pipeline both receive the edit.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Message from "@src/components/Message";
import { Copy01Icon, HugeiconsIcon, Pen01Icon } from "@src/icons";
import MarkdownEditor from "@src/modules/shared/components/MarkdownEditor";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_PATH_TEXT_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { copyText } from "@src/util/data/clipboard";

interface PersonalitySectionProps {
  config: Record<string, unknown>;
  update: (path: string, value: unknown) => void;
}

const PersonalitySection: React.FC<PersonalitySectionProps> = ({
  config,
  update,
}) => {
  const { t } = useTranslation("settings");
  const value =
    typeof config.soulContent === "string"
      ? (config.soulContent as string)
      : "";
  const [activeTab, setActiveTab] = useState<"edit" | "preview">("preview");
  const [draftValue, setDraftValue] = useState(value);
  const isDirty = draftValue !== value;
  const tokenCount = useMemo(
    () => Math.ceil(draftValue.length / 4),
    [draftValue]
  );

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  const handleEdit = () => {
    setActiveTab("edit");
  };

  const handleCancel = () => {
    setDraftValue(value);
    setActiveTab("preview");
  };

  const handleSave = () => {
    update("soulContent", draftValue);
    setActiveTab("preview");
  };

  const handleCopy = async () => {
    await copyText(draftValue);
    Message.success(t("common:common.copied"));
  };

  const handleTabChange = (tab: string) => {
    if (tab === "edit" || tab === "preview") {
      setActiveTab(tab);
    }
  };

  return (
    <SectionContainer>
      <SectionRow
        label={t("sharedAgentConfig.personality.label")}
        description={t("sharedAgentConfig.personality.description")}
      >
        <div className={SECTION_ACTION_GAP_CLASSES}>
          <span className={SECTION_PATH_TEXT_CLASSES}>
            {t("sharedAgentConfig.personality.tokenCount", {
              count: tokenCount,
            })}
          </span>
          {activeTab !== "edit" && (
            <Button
              icon={
                <HugeiconsIcon icon={Pen01Icon} data-icon="pencil" size={14} />
              }
              iconOnly
              onClick={handleEdit}
              aria-label={t("common:actions.edit")}
              title={t("common:actions.edit")}
              data-testid="agent-orgs-personality-edit-button"
            />
          )}
          <Button
            icon={
              <HugeiconsIcon icon={Copy01Icon} data-icon="copy" size={14} />
            }
            iconOnly
            onClick={handleCopy}
            disabled={!draftValue.trim()}
            aria-label={t("common:actions.copy")}
            title={t("common:actions.copy")}
          />
          {activeTab === "edit" && (
            <>
              <Button
                size="small"
                onClick={handleCancel}
                data-testid="agent-orgs-personality-cancel-button"
              >
                {t("common:actions.cancel")}
              </Button>
              <Button
                size="small"
                variant="primary"
                onClick={handleSave}
                disabled={!isDirty}
                data-testid="agent-orgs-personality-save-button"
              >
                {t("common:actions.save")}
              </Button>
            </>
          )}
        </div>
      </SectionRow>
      <SectionRow showHeader={false} className="!pt-0">
        <MarkdownEditor
          value={draftValue}
          onChange={setDraftValue}
          dataTestId="agent-orgs-personality-editor"
          minHeight={220}
          maxHeight={360}
          emptyLineCount={10}
          showTokenCount={false}
          previewEmptyText={t("sharedAgentConfig.personality.emptyPreview")}
          hideHeader
          activeTab={activeTab}
          onTabChange={handleTabChange}
        />
      </SectionRow>
    </SectionContainer>
  );
};

export default PersonalitySection;
