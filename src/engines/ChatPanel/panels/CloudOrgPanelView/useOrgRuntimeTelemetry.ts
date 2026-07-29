/**
 * Admin control state for the org's "Team runtime sharing" setting
 * (`cloud_set_org_runtime_telemetry`).
 *
 * The current value reads from the org record's `runtimeTelemetry`
 * (`list_my_orgs`, via `org2CloudOrgsAtom`) through the shape-safe accessor in
 * `teamRuntimeData`; a successful save keeps the server-clamped response as an
 * override until the refetched roster catches up.
 */
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { setOrgRuntimeTelemetry } from "@src/features/Org2Cloud/memberRuntime/memberRuntimeClient";
import type { OrgRuntimeTelemetry } from "@src/features/Org2Cloud/memberRuntime/types";
import { RUNTIME_TELEMETRY_DEFAULT_INTERVAL_MINUTES } from "@src/features/Org2Cloud/memberRuntime/types";
import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { ensureFreshSession } from "@src/features/Org2Cloud/org2CloudClient";
import { isFetchTransportError } from "@src/features/Org2Cloud/org2CloudFetchRetry";
import {
  org2CloudOrgsAtom,
  useRefetchOrg2CloudOrgs,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import {
  parseTelemetryOption,
  readOrgRuntimeTelemetry,
  telemetrySelectValue,
} from "@src/modules/shared/dataSource/teamRuntimeData";

import type { SelectValue } from "./cloudOrgPanelTypes";

export interface OrgRuntimeTelemetryState {
  /** Select value: `"off"` or an interval preset in minutes as a string. */
  value: string;
  saving: boolean;
  error: string | null;
  handleChange: (value: SelectValue) => Promise<void>;
}

export function useOrgRuntimeTelemetry(
  orgId: string
): OrgRuntimeTelemetryState {
  const { t } = useTranslation("navigation");
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const orgs = useAtomValue(org2CloudOrgsAtom);
  const refetchOrgs = useRefetchOrg2CloudOrgs();

  const [override, setOverride] = useState<{
    orgId: string;
    telemetry: OrgRuntimeTelemetry;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Latest auth via ref (panel idiom): token-refresh writes must not
  // invalidate the change handler.
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  useEffect(() => {
    setError(null);
  }, [orgId]);

  const org = orgs.find((candidate) => candidate.orgId === orgId) ?? null;
  const effective =
    override?.orgId === orgId
      ? override.telemetry
      : readOrgRuntimeTelemetry(org);
  const value = telemetrySelectValue(effective);

  const handleChange = useCallback(
    async (raw: SelectValue): Promise<void> => {
      const next = String(raw);
      if (saving) return;
      setError(null);
      setSaving(true);
      try {
        const current = authRef.current;
        if (!current) throw new Error(t("cloud.orgPanel.loadError"));
        const fresh = await ensureFreshSession(current);
        if (!fresh) throw new Error(t("cloud.orgPanel.loadError"));
        commitRefreshedAuth(setAuth, current, fresh);
        const parsed = parseTelemetryOption(next);
        const result = await setOrgRuntimeTelemetry(
          fresh.accessToken,
          orgId,
          parsed.enabled,
          // Turning off keeps the last interval so re-enabling restores it.
          parsed.intervalMinutes ??
            effective?.intervalMinutes ??
            RUNTIME_TELEMETRY_DEFAULT_INTERVAL_MINUTES
        );
        // The server response carries the authoritative (clamped) value.
        setOverride({ orgId, telemetry: result });
        // Converge the shared org record so other consumers (the Team panel's
        // disabled gate) see the change without reopening the panel.
        void refetchOrgs();
      } catch (err) {
        setError(
          isFetchTransportError(err)
            ? t("cloud.orgManagement.errors.network")
            : err instanceof Error
              ? err.message
              : String(err)
        );
      } finally {
        setSaving(false);
      }
    },
    [effective, orgId, refetchOrgs, saving, setAuth, t]
  );

  return { value, saving, error, handleChange };
}
