import { useAtomValue } from "jotai";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router-dom";

import Button from "@src/components/Button";
import { buildOrg2CloudLoginUrl } from "@src/features/Org2Cloud/config";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { OnboardingLayout } from "@src/modules/shared/layouts/OnboardingLayout";
import { ONBOARDING_LOGIN_TOKENS } from "@src/modules/shared/layouts/onboardingTokens";

import { createWebAuthCallbackUrl } from "./webAuthFlowState";

export function WebLoginPage() {
  const { t } = useTranslation("navigation");
  const auth = useAtomValue(org2CloudAuthAtom);
  const [startError, setStartError] = useState<string | null>(null);
  const startSignIn = useCallback(() => {
    try {
      setStartError(null);
      window.location.assign(
        buildOrg2CloudLoginUrl(createWebAuthCallbackUrl())
      );
    } catch {
      setStartError(t("web.authCallback.failed"));
    }
  }, [t]);
  if (auth) return <Navigate to="/sessions" replace />;

  return (
    <main className="h-full bg-bg-2">
      <OnboardingLayout
        variant="contained"
        leftContent={
          <section
            className={`${ONBOARDING_LOGIN_TOKENS.contentStack} ${ONBOARDING_LOGIN_TOKENS.responsiveColumnWidth}`}
            aria-labelledby="web-login-title"
          >
            <div className="flex flex-col items-center text-center">
              <img
                src="/logo.png"
                alt="ORG2"
                className="size-20 rounded-2xl shadow-dropdown-soft"
              />
              <p className="mt-5 mb-0 text-xs font-semibold tracking-wider text-primary-6 uppercase">
                {t("cloud.title")}
              </p>
              <h1
                id="web-login-title"
                className="mt-1 mb-0 text-2xl font-semibold text-text-1"
              >
                {t("web.login.title")}
              </h1>
              <p className="mt-2 mb-0 text-sm leading-relaxed text-text-3">
                {t("web.login.subtitle")}
              </p>
            </div>

            <div className={ONBOARDING_LOGIN_TOKENS.actionStack}>
              <Button
                variant="primary"
                size="large"
                long
                className={`${ONBOARDING_LOGIN_TOKENS.actionButton} w-full`}
                onClick={startSignIn}
              >
                {t("web.login.continue")}
              </Button>
              {startError ? (
                <p
                  className="text-danger-7 m-0 text-center text-xs leading-normal"
                  role="alert"
                >
                  {startError}
                </p>
              ) : null}
              <p className="m-0 text-center text-xs leading-normal text-text-3">
                {t("web.login.hint")}
              </p>
            </div>
          </section>
        }
      />
    </main>
  );
}
