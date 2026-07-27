/**
 * Builds one `NavigationMenuItem` row for a Team Sessions fork thread
 * (`cloudSessionsSection.tsx`): icon/title/relative-time, the unresolved
 * comments badge, live-viewer chips, and the row's hover actions (Fork,
 * overflow menu with copy-id/remove). Split out because it is the single
 * largest piece of that section's row-construction logic.
 */
import {
  MenuItem,
  PredefinedMenuItem,
  Menu as TauriMenu,
} from "@tauri-apps/api/menu";
import type { TFunction } from "i18next";
import { GitFork, MoreHorizontal } from "lucide-react";
import { useCallback } from "react";

import Message from "@src/components/Message";
import { resolveAgentIcon } from "@src/config/agentIcons";
import { buildCloudRemoteItemId } from "@src/features/Org2Cloud/cloudRemoteItemId";
import { buildCloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";
import {
  type CloudSessionThreadRow,
  isCloudThreadRowDisabled,
} from "@src/features/Org2Cloud/cloudSessionThreads";
import type { Org2CloudPresenceEntry } from "@src/features/Org2Cloud/org2CloudPresenceAtom";
import { viewersForSession } from "@src/features/Org2Cloud/org2CloudPresenceAtom";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { copyText } from "@src/util/data/clipboard";
import { resolveSessionDisplayMetadata } from "@src/util/session/sessionDisplayMetadata";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

interface UseCloudSessionRowItemBuilderParams {
  presenceMap: Record<string, Record<string, Org2CloudPresenceEntry>>;
  selfUserId: string | null;
  t: TFunction;
  tCommon: TFunction;
  runFork: (row: RemoteTeammateSessionMetadata) => void;
  hideRemoteSession: (row: RemoteTeammateSessionMetadata) => void;
}

export type BuildCloudSessionRowItem = (
  threadRow: CloudSessionThreadRow,
  asParentOf?: NavigationMenuItem[]
) => NavigationMenuItem;

export function useCloudSessionRowItemBuilder({
  presenceMap,
  selfUserId,
  t,
  tCommon,
  runFork,
  hideRemoteSession,
}: UseCloudSessionRowItemBuilderParams): BuildCloudSessionRowItem {
  const buildRowItem = useCallback(
    (threadRow: CloudSessionThreadRow, asParentOf?: NavigationMenuItem[]) => {
      const { row, bareSessionId } = threadRow;
      const isFork = Boolean(row.forkedFrom);
      const disabled = isCloudThreadRowDisabled(threadRow);
      const itemId = buildCloudRemoteItemId(row.orgId, row.id);
      const relativeTime = row.lastActivityAt
        ? formatRelativeTime(row.lastActivityAt, "nano")
        : "";
      const display = resolveSessionDisplayMetadata({
        kind: "remote",
        session: row,
      });
      const sessionIcon =
        isFork && !display.externalSource && !display.agentType
          ? GitFork
          : resolveAgentIcon(display.agentIconId);
      // Unresolved session-comment threads (0014 listing counters): a small
      // count chip in the trailing accessory slot. On LEAF rows the slot
      // fades on hover to reveal the Replay/Fork actions (platform
      // pattern); thread-root parent rows keep it visible.
      // Suppress the unresolved-comment badge on rows the viewer cannot open:
      // a disabled teammate metadata_only row (eventsEpoch === undefined) has
      // no reachable notes surface — clicking is a no-op — so advertising a
      // count the viewer can neither read nor resolve is a pure dead end.
      const unresolvedComments = disabled
        ? 0
        : (row.unresolvedCommentCount ?? 0);
      const commentsBadge =
        unresolvedComments > 0 ? (
          <span
            data-testid="session-comments-badge"
            aria-label={t("cloud.comments.unresolvedBadge", {
              count: unresolvedComments,
            })}
            className="inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary-6 px-1 text-[9px] font-medium leading-none text-white"
          >
            {unresolvedComments}
          </span>
        ) : undefined;
      // Live viewers: other org members currently viewing this session.
      const viewers = viewersForSession(
        presenceMap,
        row.orgId,
        bareSessionId,
        selfUserId
      );
      const overflowViewers = viewers.slice(3);
      const viewerChips =
        viewers.length > 0 ? (
          <span className="inline-flex items-center -space-x-1">
            {viewers.slice(0, 3).map((viewer) => (
              <span
                key={viewer.userId}
                data-testid="session-viewer-chip"
                aria-label={t("cloud.sidebar.viewerTooltip", {
                  name: viewer.displayName,
                })}
                title={t("cloud.sidebar.viewerTooltip", {
                  name: viewer.displayName,
                })}
                className="inline-flex size-3.5 items-center justify-center rounded-full bg-success-6 text-[8px] font-semibold leading-none text-white ring-1 ring-bg-1"
              >
                {(viewer.displayName || "?").slice(0, 1).toUpperCase()}
              </span>
            ))}
            {overflowViewers.length > 0 && (
              <span
                data-testid="session-viewer-overflow"
                title={`${t("cloud.sidebar.viewerOverflow", {
                  count: overflowViewers.length,
                })}\n${overflowViewers
                  .map((viewer) => viewer.displayName)
                  .join(", ")}`}
                className="inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-fill-3 px-0.5 text-[8px] font-semibold leading-none text-text-2 ring-1 ring-bg-1"
              >
                +{overflowViewers.length}
              </span>
            )}
          </span>
        ) : undefined;
      const trailingElement =
        viewerChips || commentsBadge ? (
          <span className="inline-flex items-center gap-1">
            {viewerChips}
            {commentsBadge}
          </span>
        ) : undefined;
      // Strip fork glyph(s) baked into pushed titles; the GitFork icon carries provenance.
      const displayTitle = row.title.replace(/^(?:⑂\s*)+/u, "");
      const item: NavigationMenuItem = {
        id: itemId,
        key: itemId,
        label: displayTitle,
        searchText: `${displayTitle} ${row.ownerDisplayName}`,
        dataTestId: `sidebar-cloud-session-item-${bareSessionId}`,
        // Prefer the source/agent brand used by regular sessions. Cloud
        // scope is context, not the session's icon identity.
        icon: sessionIcon,
        shortcut: relativeTime,
        trailingElement,
        disabled,
        children: asParentOf,
        // A thread root is a real session, not just a group header: keep it
        // openable after a fork adds child rows (the chevron toggles the
        // thread). Only meaningful when it actually has children.
        navigableParent: asParentOf !== undefined && !disabled,
      };
      if (!disabled) {
        item.showMoreActions = true;
      }
      if (!disabled) {
        // Remote rows open/replay on plain click. Hover adds Fork plus the
        // standard overflow menu, whether this row is a leaf or thread root.
        item.rowActions = [
          {
            icon: GitFork,
            label: t("cloud.orgPanel.fork"),
            onClick: () => runFork(row),
          },
          {
            icon: MoreHorizontal,
            label: tCommon("actions.more"),
            onClick: () => {
              void Promise.all([
                MenuItem.new({
                  text: t("cloud.sidebar.copyId"),
                  action: () => {
                    void copyText(buildCloudSessionReference(row))
                      .then(() => {
                        Message.success(tCommon("actions.copied", "Copied"));
                      })
                      .catch(() => {
                        Message.error(
                          tCommon("actions.copyFailed", "Copy failed")
                        );
                      });
                  },
                }),
                PredefinedMenuItem.new({ item: "Separator" }),
                MenuItem.new({
                  text: tCommon("actions.remove", "Remove"),
                  action: () => hideRemoteSession(row),
                }),
              ]).then(async ([copyItem, menuSeparator, removeItem]) => {
                const menu = await TauriMenu.new({
                  items: [copyItem, menuSeparator, removeItem],
                });
                await menu.popup();
              });
            },
          },
        ];
      }
      return item;
    },
    [hideRemoteSession, presenceMap, runFork, selfUserId, t, tCommon]
  );

  return buildRowItem;
}
