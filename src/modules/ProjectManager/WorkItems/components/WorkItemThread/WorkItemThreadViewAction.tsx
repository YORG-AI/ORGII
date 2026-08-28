import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { ArrowLeft02Icon, HugeiconsIcon, Message01Icon } from "@src/icons";

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
          <HugeiconsIcon
            icon={ArrowLeft02Icon}
            data-icon="arrow-left"
            size={13}
            aria-hidden
          />
        ) : (
          <HugeiconsIcon
            icon={Message01Icon}
            data-icon="message-square"
            size={13}
            aria-hidden
          />
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
