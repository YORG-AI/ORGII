/**
 * Admin control state for the org's "Background upload" policy.
 *
 * The server still exposes the 0013 policy through the legacy
 * `cloud_set_org_offline_sync` RPC and `offlineSyncEnabled` roster field.
 * Product code names the behavior by its single current purpose: allowing
 * eligible own-session uploads without requiring the org to be active.
 */
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { ensureFreshSession } from "@src/features/Org2Cloud/org2CloudClient";
import { isFetchTransportError } from "@src/features/Org2Cloud/org2CloudFetchRetry";
import {
  isOrgBackgroundUploadEnabled,
  org2CloudOrgsAtom,
  useRefetchOrg2CloudOrgs,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { setOrgBackgroundUpload } from "@src/features/Org2Cloud/org2CloudSyncClient";

import type { SelectValue } from "./cloudOrgPanelTypes";

export const ORG_BACKGROUND_UPLOAD_ON_VALUE = "on";
export const ORG_BACKGROUND_UPLOAD_OFF_VALUE = "off";

export interface OrgBackgroundUploadState {
  /** Select value: `"on"` or `"off"`. */
  value: string;
  enabled: boolean;
  saving: boolean;
  error: string | null;
  handleChange: (value: SelectValue) => Promise<void>;
}

export function useOrgBackgroundUpload(
  orgId: string
): OrgBackgroundUploadState {
  const { t } = useTranslation("navigation");
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const orgs = useAtomValue(org2CloudOrgsAtom);
  const refetchOrgs = useRefetchOrg2CloudOrgs();

  const [override, setOverride] = useState<{
    orgId: string;
    enabled: boolean;
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
  const enabled =
    override?.orgId === orgId
      ? override.enabled
      : org
        ? isOrgBackgroundUploadEnabled(org)
        : false;

  const handleChange = useCallback(
    async (raw: SelectValue): Promise<void> => {
      const next = String(raw) === ORG_BACKGROUND_UPLOAD_ON_VALUE;
      if (saving) return;
      setError(null);
      setSaving(true);
      try {
        const current = authRef.current;
        if (!current) throw new Error(t("cloud.orgPanel.loadError"));
        const fresh = await ensureFreshSession(current);
        if (!fresh) throw new Error(t("cloud.orgPanel.loadError"));
        commitRefreshedAuth(setAuth, current, fresh);
        await setOrgBackgroundUpload(fresh.accessToken, orgId, next);
        setOverride({ orgId, enabled: next });
        // Converge the shared org record so the session push engine and every
        // other consumer see the policy change without reopening the panel.
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
    [orgId, refetchOrgs, saving, setAuth, t]
  );

  return {
    value: enabled
      ? ORG_BACKGROUND_UPLOAD_ON_VALUE
      : ORG_BACKGROUND_UPLOAD_OFF_VALUE,
    enabled,
    saving,
    error,
    handleChange,
  };
}
