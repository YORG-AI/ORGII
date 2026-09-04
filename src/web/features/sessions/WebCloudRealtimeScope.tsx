import { useAtomValue, useSetAtom } from "jotai";
import { useLayoutEffect } from "react";
import { useLocation } from "react-router-dom";

import {
  org2CloudOrgsAtom,
  sidebarActiveCloudOrgIdAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { useOrg2CloudRealtime } from "@src/features/Org2Cloud/useOrg2CloudRealtime";

function decodedPathSegment(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Resolve the one cloud organization represented by the current Web route. */
export function resolveWebActiveCloudOrgId({
  pathname,
  search,
  availableOrgIds,
}: {
  pathname: string;
  search: string;
  availableOrgIds: readonly string[];
}): string | null {
  const available = new Set(availableOrgIds);
  const routeOrgId = decodedPathSegment(
    pathname.match(/^\/sessions\/([^/]+)\/[^/]+(?:\/replay)?\/?$/)?.[1]
  );
  if (routeOrgId && available.has(routeOrgId)) return routeOrgId;

  const requestedOrgId = new URLSearchParams(search).get("org");
  if (requestedOrgId && available.has(requestedOrgId)) return requestedOrgId;
  return availableOrgIds[0] ?? null;
}

/**
 * Singleton owner for the Web app's active-org projection and Realtime lease.
 * It lives inside the auth-keyed sessions provider, so sign-out tears both
 * down together.
 */
export function WebCloudRealtimeScope() {
  const location = useLocation();
  const orgs = useAtomValue(org2CloudOrgsAtom);
  const setActiveOrgId = useSetAtom(sidebarActiveCloudOrgIdAtom);
  const activeOrgId = resolveWebActiveCloudOrgId({
    pathname: location.pathname,
    search: location.search,
    availableOrgIds: orgs.map((org) => org.orgId),
  });

  useLayoutEffect(() => {
    setActiveOrgId(activeOrgId);
  }, [activeOrgId, setActiveOrgId]);

  useLayoutEffect(
    () => () => {
      setActiveOrgId(null);
    },
    [setActiveOrgId]
  );

  useOrg2CloudRealtime();
  return null;
}
