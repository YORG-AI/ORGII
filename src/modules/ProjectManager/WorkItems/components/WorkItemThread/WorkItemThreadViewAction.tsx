import { ArrowLeft, MessageSquare } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";

export type WorkItemThreadView = "overview" | "discussion";

interface WorkItemThreadViewActionProps {
  activeView: WorkItemThreadView;
  onChange: (view: WorkItemThreadView) => void;
}

/**
 * A drill-in action, not a persistent tab strip. The Work Item is the primary
 * surface; Discussion temporarily replaces its body and exposes a single
 * route back to it.
 */
export const WorkItemThreadViewAction: React.FC<
  WorkItemThreadViewActionProps
> = ({ activeView, onChange }) => {
  const { t } = useTranslation(["projects", "common"]);
  const isDiscussion = activeView === "discussion";

  return (
    <Button
      variant="tertiary"
      appearance="ghost"
      size="mini"
      icon={
        isDiscussion ? (
          <ArrowLeft size={13} aria-hidden />
        ) : (
          <MessageSquare size={13} aria-hidden />
        )
      }
      onClick={() => onChange(isDiscussion ? "overview" : "discussion")}
      data-testid={
        isDiscussion
          ? "work-item-thread-back-overview"
          : "work-item-thread-open-discussion"
      }
    >
      {isDiscussion
        ? t("common:actions.back")
        : t("projects:workItems.activity.discussionTitle")}
    </Button>
  );
};
