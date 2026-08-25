/**
 * Team Sessions "who posted this" member-filter dropdown
 * (`cloudSessionsSection.tsx`): the portal-rendered option list (everyone /
 * directly shared with me / each roster member, with online dot + "viewing"
 * subtitle) plus the "show hidden" reveal row, and the state/handlers that
 * back it (escape-to-close, filter selection, hidden-row count).
 */
import type { TFunction } from "i18next";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useCallback, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";

import DropdownItem from "@src/components/Dropdown/DropdownItem";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { HIDDEN_REMOTE_SESSIONS_STORAGE_KEY } from "@src/features/Org2Cloud/cloudHiddenRemoteSessions";
import {
  type CloudSessionFilter,
  buildCloudSessionMemberFilterOptions,
} from "@src/features/Org2Cloud/cloudSessionFilter";
import type { CloudOrgMember } from "@src/features/Org2Cloud/org2CloudClient";
import type { Org2CloudPresenceEntry } from "@src/features/Org2Cloud/org2CloudPresenceAtom";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import type { MemberFilterMenuState } from "./cloudSessionsSection.types";

interface UseCloudMemberFilterDropdownParams {
  orgId: string | null;
  filter: CloudSessionFilter;
  memberMenu: MemberFilterMenuState | null;
  setMemberMenu: Dispatch<SetStateAction<MemberFilterMenuState | null>>;
  rows: readonly RemoteTeammateSessionMetadata[];
  rosterMembers: CloudOrgMember[] | null;
  hiddenRemoteSessionIds: ReadonlySet<string>;
  setHiddenRemoteSessionIds: Dispatch<SetStateAction<Set<string>>>;
  presenceMap: Record<string, Record<string, Org2CloudPresenceEntry>>;
  onFilterChange: (filter: CloudSessionFilter) => void;
  t: TFunction;
}

export function useCloudMemberFilterDropdown({
  orgId,
  filter,
  memberMenu,
  setMemberMenu,
  rows,
  rosterMembers,
  hiddenRemoteSessionIds,
  setHiddenRemoteSessionIds,
  presenceMap,
  onFilterChange,
  t,
}: UseCloudMemberFilterDropdownParams): ReactNode {
  // Everyone + the active roster. Current rows are only a loading/legacy
  // fallback; a teammate does not need to publish a Session before they can
  // be selected as a filter.
  const memberOptions = useMemo(() => {
    return buildCloudSessionMemberFilterOptions(rows, rosterMembers);
  }, [rosterMembers, rows]);

  const closeMemberMenu = useCallback(
    () => setMemberMenu(null),
    [setMemberMenu]
  );
  // Escape dismisses the member-filter panel. Document-level because the
  // panel's rows are DropdownItem divs (not focus targets) — keyboard users
  // must be able to bail without picking an option.
  useEffect(() => {
    if (!memberMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setMemberMenu(null);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [memberMenu, setMemberMenu]);
  const handleFilterSelect = useCallback(
    (nextFilter: CloudSessionFilter) => {
      onFilterChange(nextFilter);
      setMemberMenu(null);
    },
    [onFilterChange, setMemberMenu]
  );

  // Rows the viewer hid via the row menu; this dropdown entry is the only way back.
  const hiddenCountForOrg = useMemo(() => {
    if (!orgId) return 0;
    let count = 0;
    for (const key of hiddenRemoteSessionIds) {
      if (key.startsWith(`${orgId}|`)) count += 1;
    }
    return count;
  }, [hiddenRemoteSessionIds, orgId]);
  const handleShowHidden = useCallback(() => {
    if (!orgId) return;
    setHiddenRemoteSessionIds((current) => {
      const next = new Set(
        [...current].filter((key) => !key.startsWith(`${orgId}|`))
      );
      localStorage.setItem(
        HIDDEN_REMOTE_SESSIONS_STORAGE_KEY,
        JSON.stringify([...next])
      );
      return next;
    });
    setMemberMenu(null);
  }, [orgId, setHiddenRemoteSessionIds, setMemberMenu]);

  // Same DropdownMenu look as SessionFilterButton, but anchored to the
  // section header's action button (rendered by NavigationSidebar), so the
  // panel is positioned from the click target instead of a local triggerRef.
  const cloudMemberFilterDropdown = memberMenu
    ? createPortal(
        <>
          <div
            className="fixed inset-0"
            style={{ zIndex: DROPDOWN_PANEL.zIndex - 1 }}
            onMouseDown={closeMemberMenu}
          />
          <div
            className={`${DROPDOWN_CLASSES.panelAnimated} ${DROPDOWN_WIDTHS.sidebarMenuClass} fixed`}
            style={{ top: memberMenu.top, left: memberMenu.left }}
            data-testid="sidebar-cloud-member-filter"
            // Keyboard focus may be parked in another pane (chat composer /
            // terminal), where the document-level Escape listener never
            // fires. Own the focus while open and handle Escape locally too.
            tabIndex={-1}
            ref={(node) => node?.focus({ preventScroll: true })}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                closeMemberMenu();
              }
            }}
          >
            <div
              className={DROPDOWN_CLASSES.itemsColumnPadded}
              role="listbox"
              aria-label={t("cloud.sidebar.sessionFilter")}
            >
              <div className={DROPDOWN_CLASSES.sectionLabel}>
                {t("cloud.sidebar.sessionFilter")}
              </div>
              {[
                {
                  key: "everyone",
                  filter: { kind: "all" } as CloudSessionFilter,
                  displayName: t("cloud.sidebar.everyone"),
                  userId: null as string | null,
                },
                {
                  key: "directly-shared-with-me",
                  filter: {
                    kind: "directlySharedWithMe",
                  } as CloudSessionFilter,
                  displayName: t("cloud.sidebar.directlySharedWithMe"),
                  userId: null as string | null,
                },
                ...memberOptions.map((option) => ({
                  key: `member-${option.userId}`,
                  filter: {
                    kind: "member",
                    ownerUserId: option.userId,
                  } as CloudSessionFilter,
                  ...option,
                })),
              ].map((option) => {
                const active =
                  option.filter.kind === filter.kind &&
                  (option.filter.kind !== "member" ||
                    (filter.kind === "member" &&
                      option.filter.ownerUserId === filter.ownerUserId));
                const presenceEntry = option.userId
                  ? (orgId ? presenceMap[orgId] : undefined)?.[option.userId]
                  : undefined;
                const viewingRow = presenceEntry?.viewingSessionId
                  ? rows.find(
                      (row) =>
                        row.sourceSessionId === presenceEntry.viewingSessionId
                    )
                  : undefined;
                const viewingTitle = viewingRow
                  ? viewingRow.title.replace(/^(?:⑂\s*)+/u, "")
                  : undefined;
                return (
                  // DropdownItem carries the option semantics itself
                  // (role="option" + aria-selected + selected check).
                  <DropdownItem
                    key={option.key}
                    dataTestId={`sidebar-cloud-filter-${option.key}`}
                    selected={active}
                    onClick={() => handleFilterSelect(option.filter)}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="flex min-w-0 items-center gap-1.5">
                        {presenceEntry && (
                          <span
                            data-testid="member-online-dot"
                            className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-success-6"
                          />
                        )}
                        <span className="min-w-0 truncate">
                          {option.displayName}
                        </span>
                      </span>
                      {viewingTitle && (
                        <span className="min-w-0 truncate pl-3 text-[10px] text-text-3">
                          {t("cloud.sidebar.memberViewing", {
                            title: viewingTitle,
                          })}
                        </span>
                      )}
                    </span>
                  </DropdownItem>
                );
              })}
              {hiddenCountForOrg > 0 && (
                <>
                  <div className={DROPDOWN_CLASSES.menuSeparatorInset} />
                  <DropdownItem onClick={handleShowHidden}>
                    <span className="min-w-0 truncate">
                      {t("cloud.sidebar.showHidden", {
                        count: hiddenCountForOrg,
                      })}
                    </span>
                  </DropdownItem>
                </>
              )}
            </div>
          </div>
        </>,
        document.body
      )
    : null;

  return cloudMemberFilterDropdown;
}
