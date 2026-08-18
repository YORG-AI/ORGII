import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { ROUTES } from "@src/config/routes";
import {
  HOSTED_LOGIN_ENABLED,
  parseAuthCallback,
} from "@src/config/serviceAuth";
import { identityClient } from "@src/features/Identity/identityClient";
import { replaceIdentitySnapshot } from "@src/features/Identity/identitySnapshotAtom";
import { createLogger } from "@src/hooks/logger";
import { consumeLoginRedirect } from "@src/router/entryFlow";

import { LoginLoadingState } from "./index";

const log = createLogger("AuthCallback");

const AuthCallback: React.FC = () => {
  const { t } = useTranslation("market");
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const isProcessingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const safeTimeout = (fn: () => void, ms: number) => {
      const timer = setTimeout(() => {
        if (!cancelled) fn();
      }, ms);
      timers.push(timer);
    };

    const redirectFromFailedCallback = () => {
      safeTimeout(() => {
        navigate(
          HOSTED_LOGIN_ENABLED
            ? ROUTES.auth.login.path
            : ROUTES.workStation.base.path,
          { replace: true }
        );
      }, 2000);
    };

    const handleCallback = async () => {
      if (isProcessingRef.current) {
        return;
      }

      const search = location.search;

      if (!search) {
        log.error("No query params found in URL");
        setError(t("market.auth.noAuthCode"));
        redirectFromFailedCallback();
        return;
      }

      const result = parseAuthCallback(search);

      if (result.error) {
        log.error("Hosted authorization was rejected");
        setError(t("market.auth.tokenExchangeFailed"));
        redirectFromFailedCallback();
        return;
      }

      if (!result.code) {
        log.error("No authorization code in response");
        setError(t("market.auth.noAuthCode"));
        redirectFromFailedCallback();
        return;
      }

      isProcessingRef.current = true;

      try {
        const snapshot = await identityClient.completeHostedServiceSignIn(
          result.code
        );
        if (cancelled) return;
        replaceIdentitySnapshot(snapshot);

        navigate(consumeLoginRedirect(), { replace: true });
      } catch {
        log.error("Hosted token exchange failed");
        setError(t("market.auth.tokenExchangeFailed"));
        redirectFromFailedCallback();
      }
    };

    handleCallback();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [location.search, navigate, t]);

  return <LoginLoadingState error={error} />;
};

export default AuthCallback;
