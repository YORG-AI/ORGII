/**
 * ProjectSyncStatusWidget
 *
 * Right-segment widget for the Project Manager status bar.
 * Reads the live `projectSyncStatusAtom` (driven by the Rust worker via
 * the `orgii-project-sync-status` Tauri event) and renders one of four
 * mutually exclusive states for the active project:
 *
 *   - synced    — `pending = failed = abandoned = 0`, adapter attached
 *   - pending   — `pending > 0`, no failures
 *   - failed    — `failed > 0`, no abandons (warning tint)
 *   - abandoned — `abandoned > 0` (danger tint)
 *
 * Renders nothing when:
 *   - no `projectSlug` is available (no active work-items tab),
 *   - no map entry exists yet for this slug (no worker event seen — we
 *     deliberately avoid a "synced" default to prevent false positives
 *     on freshly-opened projects with sync attached but no event yet),
 *   - the map entry has `adapter_id == null` (sync not configured).
 *
 * Click writes a `syncDeepLinkAtom` request (Phase 4.8 Track D) so the
 * matching `WorkItemsPage` can switch to the Settings view and select
 * the "sync" section. The existing `onOpenSettings` callback (from
 * `activeStatusBarCallbacksAtom`) is still invoked as a fallback so
 * the Settings view opens even when no consumer of the deep-link atom
 * is currently mounted.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  CloudAlertIcon,
  CloudIcon,
  CloudLoadingIcon,
  CloudUploadIcon,
  HugeiconsIcon,
} from "@src/icons";
import { projectSyncStatusAtom, syncDeepLinkAtom } from "@src/store/sync";
import { activeStatusBarCallbacksAtom } from "@src/store/ui/workStationAtom";
import { truncate } from "@src/util/string/truncate";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import { StatusBarButton, StatusBarLabel } from "./StatusBarBase";

export interface ProjectSyncStatusWidgetProps {
  /** Slug of the active project — used to look up the live event entry. */
  projectSlug: string | undefined;
}

const TOOLTIP_ERROR_LIMIT = 80;

const ProjectSyncStatusWidget: React.FC<ProjectSyncStatusWidgetProps> = memo(
  ({ projectSlug }) => {
    const { t } = useTranslation("projects");
    const liveStatusMap = useAtomValue(projectSyncStatusAtom);
    const { onOpenSettings } = useAtomValue(activeStatusBarCallbacksAtom);
    const setDeepLink = useSetAtom(syncDeepLinkAtom);

    const entry = projectSlug ? liveStatusMap.get(projectSlug) : undefined;

    // Writes the sync deep-link request before delegating to the
    // existing `onOpenSettings` callback. The latter still runs as a
    // fallback so the Settings view opens even when no consumer of
    // `syncDeepLinkAtom` is currently mounted (e.g. the user clicks
    // from a different work-station tab).
    const handleClick = useCallback(() => {
      if (projectSlug) {
        setDeepLink({
          slug: projectSlug,
          section: "sync",
          stamp: Date.now(),
        });
      }
      onOpenSettings?.();
    }, [projectSlug, setDeepLink, onOpenSettings]);

    const view = useMemo(() => {
      if (!projectSlug || !entry || entry.adapter_id === null) return null;

      const lastPullLabel =
        entry.last_pull_at !== null
          ? t("statusBar.sync.lastPullAgo", {
              time: formatRelativeTime(entry.last_pull_at * 1000, "compact"),
            })
          : t("statusBar.sync.lastPullNever");

      if (entry.abandoned_count > 0) {
        return {
          icon: (
            <HugeiconsIcon
              icon={CloudLoadingIcon}
              data-icon="cloud-off"
              size={13}
              className="text-danger-6"
            />
          ),
          label: String(entry.abandoned_count),
          labelClass: "text-danger-6",
          tooltip: t("statusBar.sync.abandoned", {
            count: entry.abandoned_count,
          }),
        };
      }

      if (entry.failed_count > 0) {
        const base = t("statusBar.sync.failed", { count: entry.failed_count });
        const tooltip = entry.last_error
          ? `${base} — ${truncate(entry.last_error, TOOLTIP_ERROR_LIMIT)}`
          : base;
        return {
          icon: (
            <HugeiconsIcon
              icon={CloudAlertIcon}
              data-icon="cloud-alert"
              size={13}
              className="text-warning-6"
            />
          ),
          label: String(entry.failed_count),
          labelClass: "text-warning-6",
          tooltip,
        };
      }

      if (entry.pending_count > 0) {
        return {
          icon: (
            <HugeiconsIcon
              icon={CloudUploadIcon}
              data-icon="cloud-upload"
              size={13}
              className="text-text-1"
            />
          ),
          label: String(entry.pending_count),
          labelClass: "text-text-1",
          tooltip: t("statusBar.sync.pending", {
            count: entry.pending_count,
          }),
        };
      }

      return {
        icon: (
          <HugeiconsIcon
            icon={CloudIcon}
            data-icon="cloud"
            size={13}
            className="text-text-1"
          />
        ),
        label: null as string | null,
        labelClass: "",
        tooltip: `${t("statusBar.sync.synced", {
          adapter: entry.adapter_id,
        })} · ${lastPullLabel}`,
      };
    }, [entry, projectSlug, t]);

    if (!view) return null;

    const fullTooltip = onOpenSettings
      ? `${view.tooltip} — ${t("statusBar.sync.openSettings")}`
      : view.tooltip;

    return (
      <StatusBarButton onClick={handleClick} title={fullTooltip}>
        {view.icon}
        {view.label !== null && (
          <StatusBarLabel numeric className={view.labelClass}>
            {view.label}
          </StatusBarLabel>
        )}
      </StatusBarButton>
    );
  }
);

ProjectSyncStatusWidget.displayName = "ProjectSyncStatusWidget";

export default ProjectSyncStatusWidget;
