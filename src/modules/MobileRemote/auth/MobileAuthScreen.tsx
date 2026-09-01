import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import { Placeholder } from "@src/components/Placeholder";
import { HugeiconsIcon, Login02Icon } from "@src/icons";

import { MobileShell } from "../components/MobileShell";
import type { MobileAuthState } from "./mobileAuthState";

export interface MobileAuthScreenProps {
  state: MobileAuthState;
  onSignIn: () => void;
  onRetry: () => void;
}

export function MobileAuthScreen({
  state,
  onSignIn,
  onRetry,
}: MobileAuthScreenProps) {
  const { t } = useTranslation("mobileRemote");
  const loading =
    state.phase === "checking" ||
    state.phase === "redirecting" ||
    state.phase === "exchanging";
  const loadingTitle =
    state.phase === "redirecting"
      ? t("auth.redirecting")
      : state.phase === "exchanging"
        ? t("auth.exchanging")
        : t("auth.checking");

  return (
    <MobileShell>
      <main className="flex min-h-0 flex-1 flex-col px-5 py-6">
        <div className="flex items-center gap-2 text-lg font-semibold text-text-1">
          <span aria-hidden="true" className="text-primary-6">
            ●
          </span>
          ORG2
        </div>
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-5">
          {loading ? (
            <div aria-live="polite" data-testid="mobile-auth-loading">
              <Placeholder
                variant="loading"
                placement="sidebar"
                title={loadingTitle}
                subtitle={t("auth.wait")}
              />
            </div>
          ) : (
            <>
              <div className="space-y-2 text-center">
                <h1 className="text-xl font-semibold text-text-1">
                  {t("auth.title")}
                </h1>
                <p className="text-sm leading-5 text-text-2">
                  {t("auth.subtitle")}
                </p>
              </div>
              {state.phase === "error" ? (
                <InlineAlert
                  type="danger"
                  role="alert"
                  title={t("auth.errorTitle")}
                  action={
                    state.retryable
                      ? { label: t("auth.retry"), onClick: onRetry }
                      : undefined
                  }
                >
                  {state.message}
                </InlineAlert>
              ) : null}
              <Button
                htmlType="button"
                variant="primary"
                long
                centerLabel
                icon={<HugeiconsIcon icon={Login02Icon} size={18} />}
                onClick={onSignIn}
              >
                {t("auth.signIn")}
              </Button>
            </>
          )}
        </div>
      </main>
    </MobileShell>
  );
}

MobileAuthScreen.displayName = "MobileAuthScreen";
