/**
 * GitOperationHistoryContent Component
 *
 * Displays local git operation history (commit, push, pull, etc.)
 * including failed operations. Data comes from gitOperationHistoryAtom
 * which is populated by backend WebSocket events.
 */
import { useAtomValue } from "jotai";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import { Placeholder } from "@src/components/Placeholder";
import {
  AlertCircleIcon,
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  HugeiconsIcon,
  type IconSvgElement,
  Refresh04Icon,
} from "@src/icons";
import {
  type GitOperation,
  gitOperationHistoryAtom,
} from "@src/store/git/gitOperationAtom";

// ============================================
// Constants
// ============================================

const ICON_SIZE = 14;
const ICON_STROKE = 1.75;

const TIME_THRESHOLDS = {
  MINUTE: 60,
  HOUR: 3600,
  DAY: 86400,
} as const;

const OPERATION_ICONS: Record<string, IconSvgElement> = {
  commit: GitCommitHorizontalIcon,
  push: ArrowUpFromLineIcon,
  pull: ArrowDownToLineIcon,
  fetch: Refresh04Icon,
  merge: GitMergeIcon,
  rebase: GitPullRequestIcon,
  checkout: Refresh04Icon,
};

// ============================================
// Helpers
// ============================================

function formatTimestamp(timestamp: number): string {
  const now = Date.now();
  const diffSeconds = Math.floor((now - timestamp * 1000) / 1000);

  if (diffSeconds < TIME_THRESHOLDS.MINUTE) return "just now";
  if (diffSeconds < TIME_THRESHOLDS.HOUR) {
    const mins = Math.floor(diffSeconds / 60);
    return mins === 1 ? "1 min ago" : `${mins} mins ago`;
  }
  if (diffSeconds < TIME_THRESHOLDS.DAY) {
    const hrs = Math.floor(diffSeconds / TIME_THRESHOLDS.HOUR);
    return hrs === 1 ? "1 hr ago" : `${hrs} hrs ago`;
  }

  const date = new Date(timestamp * 1000);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ============================================
// Row Component
// ============================================

interface OperationRowProps {
  entry: GitOperation;
}

const OperationRow: React.FC<OperationRowProps> = memo(({ entry }) => {
  const OperationIconComponent =
    OPERATION_ICONS[entry.operation] ?? AlertCircleIcon;

  return (
    <div className="group flex items-start gap-2 rounded px-2 py-1.5 transition-colors hover:bg-fill-3">
      {/* Status + Operation icon */}
      <div className="mt-0.5 flex-shrink-0">
        {entry.success ? (
          <AnyIcon
            icon={OperationIconComponent}
            size={ICON_SIZE}
            strokeWidth={ICON_STROKE}
            className="text-text-2"
          />
        ) : (
          <HugeiconsIcon
            icon={CancelCircleIcon}
            data-icon="xcircle"
            size={ICON_SIZE}
            strokeWidth={ICON_STROKE}
            className="text-danger-text"
          />
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium capitalize text-text-1">
            {entry.operation}
          </span>
          {entry.success ? (
            <HugeiconsIcon
              icon={CheckmarkCircle01Icon}
              data-icon="check-circle-2"
              size={11}
              className="text-success-text flex-shrink-0"
            />
          ) : (
            <span className="text-danger-text text-[10px] font-medium">
              FAILED
            </span>
          )}
        </div>

        {/* Summary */}
        <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-text-3">
          {entry.summary}
        </p>

        {/* Details on failure */}
        {!entry.success && entry.details && (
          <p className="text-danger-text/70 mt-0.5 line-clamp-2 text-[11px] leading-relaxed">
            {entry.details}
          </p>
        )}
      </div>

      {/* Timestamp */}
      <span className="flex-shrink-0 text-[10px] text-text-3">
        {formatTimestamp(entry.timestamp)}
      </span>
    </div>
  );
});

OperationRow.displayName = "OperationRow";

// ============================================
// Main Component
// ============================================

interface GitOperationHistoryContentProps {
  repoId: string;
}

export const GitOperationHistoryContent: React.FC<GitOperationHistoryContentProps> =
  memo(({ repoId }) => {
    const { t } = useTranslation();
    const allOperations = useAtomValue(gitOperationHistoryAtom);

    const operations = useMemo(
      () => allOperations.filter((op) => op.repoId === repoId),
      [allOperations, repoId]
    );

    if (operations.length === 0) {
      return (
        <Placeholder
          variant="empty"
          title={t("placeholders.noOperationHistory")}
          subtitle={t("placeholders.noOperationHistorySubtitle")}
        />
      );
    }

    return (
      <div className="scrollbar-overlay flex h-full flex-col overflow-y-auto">
        <div className="flex flex-col py-1">
          {operations.map((entry) => (
            <OperationRow key={entry.id} entry={entry} />
          ))}
        </div>
      </div>
    );
  });

GitOperationHistoryContent.displayName = "GitOperationHistoryContent";

export default GitOperationHistoryContent;
