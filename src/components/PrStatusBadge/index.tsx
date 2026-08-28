import type { ReactNode } from "react";
import { memo } from "react";
import { useTranslation } from "react-i18next";

import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  HugeiconsIcon,
} from "@src/icons";
import {
  type PrStatusIconName,
  getPrStatusIconName,
  getPrStatusLabelKey,
  getPrStatusVariant,
} from "@src/shared/pr/prStatus";
import { classNames } from "@src/util/ui/classNames";

export interface PrStatusBadgeProps {
  status: string;
  label?: ReactNode;
  showIcon?: boolean;
  showDot?: boolean;
  size?: "xs" | "sm";
  className?: string;
}

const SIZE_CLASSES = {
  xs: "rounded px-1.5 py-0.5 text-[10px]",
  sm: "rounded-full px-2 py-0.5 text-[11px]",
} as const;

function StatusIcon({ name }: { name: PrStatusIconName }) {
  switch (name) {
    case "merge":
      return (
        <HugeiconsIcon icon={GitMergeIcon} data-icon="git-merge" size={10} />
      );
    case "closed":
      return (
        <HugeiconsIcon
          icon={GitPullRequestClosedIcon}
          data-icon="git-pull-request-closed"
          size={10}
        />
      );
    case "draft":
      return (
        <HugeiconsIcon
          icon={GitPullRequestDraftIcon}
          data-icon="git-pull-request-draft"
          size={10}
        />
      );
    case "pull-request":
    default:
      return (
        <HugeiconsIcon
          icon={GitPullRequestIcon}
          data-icon="git-pull-request"
          size={10}
        />
      );
  }
}

const PrStatusBadge = memo<PrStatusBadgeProps>(
  ({
    status,
    label,
    showIcon = false,
    showDot = false,
    size = "xs",
    className,
  }) => {
    const { t } = useTranslation("common");
    const variant = getPrStatusVariant(status);
    const iconName = getPrStatusIconName(status);
    const badgeLabel =
      label ?? t(getPrStatusLabelKey(status), status || "unknown");

    return (
      <span
        className={classNames(
          "inline-flex shrink-0 items-center gap-1 font-medium capitalize",
          SIZE_CLASSES[size],
          variant.badgeClass,
          className
        )}
      >
        {showIcon && <StatusIcon name={iconName} />}
        {showDot && (
          <span
            className={classNames("h-1.5 w-1.5 rounded-full", variant.dotClass)}
            aria-hidden
          />
        )}
        {badgeLabel}
      </span>
    );
  }
);

PrStatusBadge.displayName = "PrStatusBadge";

export default PrStatusBadge;
