import { BookOpen } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import Switch from "@src/components/Switch";
import type { PolicyInfo } from "@src/hooks/policies";
import {
  CollapsibleSection,
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  PanelFooter,
  PanelHeader,
} from "@src/modules/shared/layouts/blocks";

import { DetailHeaderClose } from "../../shared/DetailHeaderClose";

interface MarkdownRuleDetailViewProps {
  rule: PolicyInfo;
  content: string;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (enabled: boolean) => void;
  onBack: () => void;
}

const MarkdownRuleDetailView: React.FC<MarkdownRuleDetailViewProps> = ({
  rule,
  content,
  onEdit,
  onDelete,
  onToggle,
  onBack,
}) => {
  const { t } = useTranslation("integrations");

  return (
    <DetailPanelContainer>
      <PanelHeader
        iconElement={<BookOpen size={14} className="text-primary-6" />}
        breadcrumb={{
          parent: t("agentOrgs.ruleKinds.rule"),
          current: rule.name,
        }}
        actions={<DetailHeaderClose onClick={onBack} />}
      />
      <div className={DETAIL_PANEL_TOKENS.scrollContent}>
        <div className={DETAIL_PANEL_TOKENS.contentWidthWithPadding}>
          <CollapsibleSection title={t("agentOrgs.sections.quickActions")}>
            <div className={DETAIL_PANEL_TOKENS.contentStack}>
              <div className="flex items-center justify-between rounded-lg bg-fill-2 px-4 py-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[13px] font-medium text-text-1">
                    {t("agentOrgs.enabled")}
                  </span>
                  <span className="text-[12px] text-text-3">
                    {t("agentOrgs.enabledDesc")}
                  </span>
                </div>
                <Switch checked={rule.enabled} onCheckedChange={onToggle} />
              </div>
            </div>
          </CollapsibleSection>

          <CollapsibleSection title={t("agentOrgs.markdownContent")}>
            <div className="rounded-lg bg-fill-2 p-4">
              <pre className="max-h-[500px] overflow-y-auto whitespace-pre-wrap text-[13px] leading-relaxed text-text-2 scrollbar-hide">
                {content || t("agentOrgs.noMarkdownContent")}
              </pre>
            </div>
          </CollapsibleSection>
        </div>
      </div>
      <PanelFooter
        primaryAction={{
          label: t("common:actions.edit"),
          onClick: onEdit,
        }}
        secondaryActions={[
          {
            label: t("common:actions.delete"),
            onClick: onDelete,
            variant: "danger",
            appearance: "outline",
          },
        ]}
      />
    </DetailPanelContainer>
  );
};

export default MarkdownRuleDetailView;
