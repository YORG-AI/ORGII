import { useSetAtom } from "jotai";
import React, { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import Button from "@src/components/Button";
import {
  decodeJwtSub,
  parseAuthCallbackFragment,
} from "@src/features/Org2Cloud/authCallback";
import { getCloudEndpoint } from "@src/features/Org2Cloud/config";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

export function WebAuthCallbackPage() {
  const { t } = useTranslation("navigation");
  const setAuth = useSetAtom(org2CloudAuthAtom);
  const navigate = useNavigate();
  const result = useMemo(() => {
    const expected = new URL(
      "/auth/callback",
      window.location.origin
    ).toString();
    const callback = parseAuthCallbackFragment(window.location.href, expected);
    if (!callback) {
      return {
        error: t("web.authCallback.missingCredentials"),
      } as const;
    }
    const userId = decodeJwtSub(callback.accessToken);
    if (!userId) {
      return {
        error: t("web.authCallback.missingIdentity"),
      } as const;
    }
    return { callback, userId, error: null } as const;
  }, [t]);

  useEffect(() => {
    if (result.error) return;
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

  if (result.error) {
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
