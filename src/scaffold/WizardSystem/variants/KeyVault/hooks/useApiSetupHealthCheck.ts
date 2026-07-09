import { useEffect } from "react";

import { autoDetectKey } from "@src/api/services/keyValidation";
import { createLogger } from "@src/hooks/logger";

import type { WizardData } from "../types";
import { normalizeDetectedQuotaInfo } from "./keyHelpers";

const log = createLogger("ApiSetup");

interface UseApiSetupHealthCheckOptions {
  data: WizardData;
  onChange: (updates: Partial<WizardData>) => void;
  cursorSessionToken: string;
  isOnLoginPage: boolean;
  isCursor: boolean;
}

export function useApiSetupHealthCheck({
  data,
  onChange,
  cursorSessionToken,
  isOnLoginPage,
  isCursor,
}: UseApiSetupHealthCheckOptions): void {
  useEffect(() => {
    let cancelled = false;

    const fetchQuotaIfNeeded = async () => {
      if (
        cursorSessionToken &&
        !data.quota_info &&
        !isOnLoginPage &&
        isCursor
      ) {
        try {
          const result = await autoDetectKey(data.agent_type);
          if (cancelled) return;
          if (result.success) {
            const keys = result.keys || [];
            const selectedCred = keys.length > 0 ? keys[0] : null;
            const quotaInfo = normalizeDetectedQuotaInfo(
              selectedCred?.quota_info
            );
            if (quotaInfo) {
              onChange({ quota_info: quotaInfo });
            }
          }
        } catch (err) {
          if (!cancelled) {
            log.error("[ApiSetup] Failed to fetch quota:", err);
          }
        }
      }
    };
    fetchQuotaIfNeeded();
    return () => {
      cancelled = true;
    };
  }, [
    cursorSessionToken,
    data.quota_info,
    isOnLoginPage,
    isCursor,
    data.agent_type,
    onChange,
  ]);
}
