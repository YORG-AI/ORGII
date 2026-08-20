import { useAtom, useAtomValue } from "jotai";
import { LogOut } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import Button from "@src/components/Button";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { org2CloudOrgsAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import {
  type NavigationMenuItem,
  NavigationSidebar,
  SidebarBottomBar,
  SidebarMenuSearchInput,
  SidebarOrgSelector,
} from "@src/scaffold/NavigationSidebar";

import { useWebSessions } from "../features/sessions/WebSessionsContext";
import { webSessionPath } from "../features/sessions/webSessionLocation";
import {
  resolveWebCloudSessionMenuItemId,
  useWebCloudSessionsSection,
} from "./useWebCloudSessionsSection";

export function WebSessionSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation("navigation");
  const { t: tCommon } = useTranslation("common");
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const orgs = useAtomValue(org2CloudOrgsAtom);
  const { sessions, status, error, refresh } = useWebSessions();
  const [search, setSearch] = useState("");

  const orgOptions = useMemo(() => {
    if (orgs.length > 0) {
      return orgs.map((org) => ({ value: org.orgId, label: org.name }));
    }
    return Array.from(
      new Map(sessions.map((session) => [session.orgId, session.orgName]))
    ).map(([orgId, orgName]) => ({ value: orgId, label: orgName }));
  }, [orgs, sessions]);

  const selectedSession = useMemo(
    () =>
      sessions.find((session) =>
        location.pathname.startsWith(webSessionPath(session))
      ),
    [location.pathname, sessions]
  );
  const requestedOrgId = new URLSearchParams(location.search).get("org");
  const selectedOrgId =
    selectedSession?.orgId ||
    (requestedOrgId &&
    orgOptions.some((option) => option.value === requestedOrgId)
      ? requestedOrgId
      : String(orgOptions[0]?.value ?? ""));

  const {
    cloudMenuItems,
    handleMenuItemClick,
    resolveSessionPath,
    resetTeamPagination,
  } = useWebCloudSessionsSection({
    orgId: selectedOrgId || null,
    sessions,
    rosterStatus: status,
    refresh,
  });

  useEffect(() => {
    resetTeamPagination();
  }, [resetTeamPagination, selectedOrgId]);

  const selectedKey = resolveWebCloudSessionMenuItemId(selectedSession);

  const handleSidebarMenuItemClick = useCallback(
    (_key: string, item: NavigationMenuItem) => {
      if (handleMenuItemClick(item)) return;
      const path = resolveSessionPath(item);
      if (!path) return;
      navigate(path);
      onNavigate?.();
    },
    [handleMenuItemClick, navigate, onNavigate, resolveSessionPath]
  );

  const displayName =
    auth?.profile?.displayName || auth?.profile?.primaryEmail || "Cloud user";
  const searchPlaceholder = tCommon("common.searchPlaceholder", "Search...");
  const noSearchResultsTitle = t("sidebar.empty.noSearchResults");

  const handleOrgChange = useCallback(
    (orgId: string) => {
      if (selectedSession?.orgId !== orgId) {
        navigate(`/sessions?org=${encodeURIComponent(orgId)}`);
      }
    },
    [navigate, selectedSession?.orgId]
  );

  const sidebarOrgSelector =
    orgOptions.length > 0 ? (
      <SidebarOrgSelector
        value={selectedOrgId}
        options={orgOptions}
        cloudSignedInIdentity={displayName}
        onChange={handleOrgChange}
      />
    ) : null;

  const orgSelectorChrome = sidebarOrgSelector ? (
    <div className="flex shrink-0 flex-col gap-1 px-3 pt-1">
      {sidebarOrgSelector}
      {error ? (
        <div className="rounded-md border border-warning-3 bg-warning-1 px-2 py-1.5 text-xs text-text-2">
          {error}
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <NavigationSidebar
      items={[]}
      activeKey="sessions"
      onChange={() => undefined}
      menuItems={cloudMenuItems}
      selectedKey={selectedKey}
      onMenuItemClick={handleSidebarMenuItemClick}
      preListContent={orgSelectorChrome}
      search={{
        value: search,
        onChange: setSearch,
        placeholder: searchPlaceholder,
        noResultsTitle: noSearchResultsTitle,
        showInput: false,
      }}
      isLoading={status === "loading" && sessions.length === 0}
      solidSurface
      includeTrafficLightSpace={false}
      showCollapseButton={false}
      collapsibleSections
      listTopPadding
      bottomContent={
        <SidebarBottomBar
          leftContent={
            <SidebarMenuSearchInput
              value={search}
              onChange={setSearch}
              placeholder={searchPlaceholder}
              compact
            />
          }
          rightActions={
            <Button
              size="mini"
              appearance="ghost"
              iconOnly
              icon={<LogOut size={14} />}
              title={t("web.sidebar.signOut", { name: displayName })}
              aria-label={t("cloud.signOut")}
              onClick={() => setAuth(null)}
            />
          }
        />
      }
    />
  );
}
