import { useSetAtom } from "jotai";
import React, { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import Button from "@src/components/Button";
import { Placeholder } from "@src/components/Placeholder";
import {
  decodeJwtSub,
  parseAuthCallbackFragment,
} from "@src/features/Org2Cloud/authCallback";
import { getCloudEndpoint } from "@src/features/Org2Cloud/config";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";

import {
  consumeWebAuthCallbackState,
  validateWebAuthCallbackState,
} from "./webAuthFlowState";

export function WebAuthCallbackPage() {
  const { t } = useTranslation("navigation");
  const setAuth = useSetAtom(org2CloudAuthAtom);
  const navigate = useNavigate();
  const committedRef = useRef(false);
  const result = useMemo(() => {
    const validatedState = validateWebAuthCallbackState(window.location.href);
    const callback = validatedState
      ? parseAuthCallbackFragment(
          window.location.href,
          validatedState.expectedCallbackUrl
        )
      : null;
    if (!callback) {
      return {
        ok: false,
        error: t("web.authCallback.missingCredentials"),
      } as const;
    }
    const userId = decodeJwtSub(callback.accessToken);
    if (!userId) {
      return {
        ok: false,
        error: t("web.authCallback.missingIdentity"),
      } as const;
    }
    return {
      ok: true,
      callback,
      userId,
      state: validatedState!.state,
    } as const;
  }, [t]);

  useEffect(() => {
    if (!result.ok || committedRef.current) return;
    if (!consumeWebAuthCallbackState(result.state)) {
      navigate("/login", { replace: true });
      return;
    }
    committedRef.current = true;
    const endpoint = getCloudEndpoint();
    window.history.replaceState(null, "", "/auth/callback");
    setAuth({
      kind: "org2_cloud",
      supabaseUrl: endpoint.supabaseUrl,
      supabaseAnonKey: endpoint.anonKey,
      userId: result.userId,
      accessToken: result.callback.accessToken,
      refreshToken: result.callback.refreshToken,
      expiresAt: result.callback.expiresAt,
    });
    navigate("/sessions", { replace: true });
  }, [navigate, result, setAuth]);

  if (!result.ok) {
    return (
      <main className="flex h-full items-center justify-center bg-bg-2 p-6">
        <div className="w-full max-w-md">
          <Placeholder
            variant="error"
            title={t("web.authCallback.failed")}
            subtitle={result.error}
            action={{
              label: t("web.authCallback.tryAgain"),
              onClick: () => navigate("/login", { replace: true }),
            }}
          />
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-full items-center justify-center bg-bg-2">
      <Button loading appearance="ghost">
        {t("web.authCallback.completing")}
      </Button>
    </main>
  );
}
