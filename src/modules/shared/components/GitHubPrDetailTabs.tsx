import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  FileDiffIcon,
  GitCommitHorizontalIcon,
  HugeiconsIcon,
  ListChecksIcon,
  MessageMultiple01Icon,
} from "@src/icons";
import DetailTabStrip from "@src/modules/shared/layouts/blocks/DetailTabStrip";
import type { PrDetailTab } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";

interface GitHubPrDetailTabsProps {
  activeTab?: PrDetailTab;
  counts?: Partial<Record<PrDetailTab, number | string>>;
  onChange?: (tab: PrDetailTab) => void;
  trailing?: ReactNode;
  variant?: "row" | "header";
}

/** Keep the same labels and geometry during chunk loading and data loading. */
export default function GitHubPrDetailTabs({
  activeTab = "conversation",
  counts,
  onChange,
  trailing,
  variant,
}: GitHubPrDetailTabsProps) {
  const { t } = useTranslation("common");
  const tabs = [
    {
      key: "conversation" as const,
      label: t("git.pr.tabs.conversation", "Conversation"),
      icon: MessageMultiple01Icon,
      iconName: "messages-square",
    },
    {
      key: "commits" as const,
      label: t("git.pr.tabs.commits", "Commits"),
      icon: GitCommitHorizontalIcon,
      iconName: "git-commit-horizontal",
    },
    {
      key: "checks" as const,
      label: t("git.pr.tabs.checks", "Checks"),
      icon: ListChecksIcon,
      iconName: "list-checks",
    },
    {
      key: "changes" as const,
      label: t("git.pr.changes.title", "Files changed"),
      icon: FileDiffIcon,
      iconName: "file-diff",
    },
  ];

  return (
    <DetailTabStrip<PrDetailTab>
      activeTab={activeTab}
      ariaLabel={t("git.pr.summary.label", "Pull request summary")}
      idPrefix="pr-detail"
      tabs={tabs.map((tab) => ({
        ...tab,
        icon: (
          <HugeiconsIcon
            icon={tab.icon}
            data-icon={tab.iconName}
            size={15}
            strokeWidth={1.8}
          />
        ),
        count: counts?.[tab.key],
        countLoading: counts?.[tab.key] === undefined,
        disabled: !onChange,
      }))}
      onChange={(tab) => onChange?.(tab)}
      trailing={trailing}
      variant={variant}
    />
  );
}
