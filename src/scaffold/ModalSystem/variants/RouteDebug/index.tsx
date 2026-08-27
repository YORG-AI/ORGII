import { useAtomValue } from "jotai";
import React, { useEffect } from "react";
import { useLocation, useMatches, useParams } from "react-router-dom";

import Message from "@src/components/Message";
import { routeDebugModalOpenAtom } from "@src/store";
import { devModeEnabledAtom } from "@src/store/platform/devModeAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

function buildRouteText(
  pathname: string,
  search: string,
  params: Record<string, string | undefined>,
  matches: ReturnType<typeof useMatches>
): string {
  const parts: string[] = [];

  parts.push(pathname + search);

  const paramEntries = Object.entries(params).filter(
    ([, v]) => v !== undefined
  );
  if (paramEntries.length > 0) {
    parts.push(
      `params: ${paramEntries.map(([k, v]) => `${k}=${v}`).join(", ")}`
    );
  }

  if (matches.length > 0) {
    const routeIds = matches.map((m) => m.id).join(" › ");
    parts.push(`routes: ${routeIds}`);
  }

  return parts.join("\n");
}

/**
 * Invisible component — subscribes to routeDebugModalOpenAtom and fires a
 * Message toast showing current route info. Only active when dev mode is on.
 */
export const RouteDebugModal: React.FC = () => {
  const open = useAtomValue(routeDebugModalOpenAtom);
  const devMode = useAtomValue(devModeEnabledAtom);
  const location = useLocation();
  const params = useParams();
  const matches = useMatches();

  useEffect(() => {
    if (!open || !devMode) return;

    const text = buildRouteText(
      location.pathname,
      location.search,
      params,
      matches
    );

    Message.info({
      id: "route-debug",
      content: text,
      duration: 5000,
      closable: true,
    });

    // Reset the atom so the next Cmd+0 re-triggers
    getInstrumentedStore().set(routeDebugModalOpenAtom, false);
  }, [open, devMode, location.pathname, location.search, params, matches]);

  return null;
};

export default RouteDebugModal;
