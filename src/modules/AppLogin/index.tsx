import React, { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import { ROUTES } from "@src/config/routes";
import { HOSTED_LOGIN_ENABLED, setAuthSkipped } from "@src/config/serviceAuth";
import {
  clearAuthStateCompletely,
  useServiceAuth,
} from "@src/hooks/auth/useServiceAuth";
import { createLogger } from "@src/hooks/logger";
import { HugeiconsIcon, Login01Icon, Refresh04Icon } from "@src/icons";
import {
  ONBOARDING_LOADING_VIDEO_WIDTH_CLASS,
  OnboardingLayout,
  OnboardingLoadingVideo,
} from "@src/modules/shared/layouts";

const LOGIN_COLUMN_WIDTH_CLASS = ONBOARDING_LOADING_VIDEO_WIDTH_CLASS;
const log = createLogger("LoginPage");

/** Primary CTAs — taller than default `Button` large for login prominence */
const LOGIN_ACTION_BUTTON_CLASS = `pointer-events-auto relative z-10 h-14 ${LOGIN_COLUMN_WIDTH_CLASS} text-base font-medium`;

// ============================================
// Exported Loading State Component
// Used by the OAuth callback route to show loading on login page layout
// ============================================

interface LoginLoadingStateProps {
  error?: string | null;
}

/**
 * Login page loading state - renders the full login page layout with loading animation
 * This is exported so the callback page can render it directly without navigation
 */
export const LoginLoadingState: React.FC<LoginLoadingStateProps> = ({
  error,
}) => {
  const { t } = useTranslation("auth");

  const leftContent = (
    <div
      className={`flex flex-col items-center gap-6 ${LOGIN_COLUMN_WIDTH_CLASS}`}
    >
      {error ? (
        <>
          <OnboardingLoadingVideo />
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="text-lg font-medium text-red-500">
              {t("loading.failed")}
            </div>
            <div className="text-sm text-gray-600">{error}</div>
            <div className="text-xs text-gray-500">
              {t("loading.redirecting")}
            </div>
          </div>
        </>
      ) : (
        <OnboardingLoadingVideo />
      )}
    </div>
  );

  return <OnboardingLayout variant="contained" leftContent={leftContent} />;
};

// ============================================
// Login Form Component (Left Column)
// ============================================
interface LoginFormProps {
  isLoading: boolean;
  sessionExpired: boolean;
  callbackError: string | null;
  onLogin: () => void;
  onSkip: () => void;
}

const LoginForm: React.FC<LoginFormProps> = ({
  isLoading,
  sessionExpired,
  callbackError,
  onLogin,
  onSkip,
}) => {
  const { t } = useTranslation("auth");

  return (
    <>
      <div
        className={`flex flex-col items-center gap-6 ${LOGIN_COLUMN_WIDTH_CLASS}`}
      >
        <OnboardingLoadingVideo />

        <div
          className={`flex flex-col items-center gap-2 ${LOGIN_COLUMN_WIDTH_CLASS}`}
        >
          {sessionExpired && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
              {t("login.sessionExpired")}
            </div>
          )}

          {callbackError && (
            <InlineAlert
              type="danger"
              title={t("common:status.error")}
              className="mb-4"
            >
              {callbackError}
            </InlineAlert>
          )}

          <Button
            variant="primary"
            size="large"
            loading={isLoading}
            onClick={onLogin}
            className={LOGIN_ACTION_BUTTON_CLASS}
          >
            {isLoading ? t("login.signingIn") : t("login.button")}
          </Button>

          <Button
            variant="tertiary"
            size="large"
            onClick={onSkip}
            className={LOGIN_ACTION_BUTTON_CLASS}
            loading={false}
          >
            {t("login.startButton")}
          </Button>

          <p className="m-0 text-center text-xs leading-normal text-text-3">
            <Trans
              i18nKey="login.terms"
              t={t}
              components={{
                1: (
                  <a
                    href="https://github.com/YORG-AI/orgii/blob/main/LICENSE"
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-text-2 underline hover:text-text-1"
                  />
                ),
              }}
            />
          </p>
        </div>
      </div>
    </>
  );
};

// ============================================
// Already Authenticated Form (Left Column)
// Shows options to continue or switch account
// ============================================
interface AuthenticatedFormProps {
  isLoading: boolean;
  onContinue: () => void;
  onSwitchAccount: () => void;
}

const AuthenticatedForm: React.FC<AuthenticatedFormProps> = ({
  isLoading,
  onContinue,
  onSwitchAccount,
}) => {
  const { t } = useTranslation("auth");

  return (
    <>
      <div
        className={`flex flex-col items-center gap-6 ${LOGIN_COLUMN_WIDTH_CLASS}`}
      >
        <OnboardingLoadingVideo />

        <div
          className={`flex flex-col items-center gap-2 ${LOGIN_COLUMN_WIDTH_CLASS}`}
        >
          <Button
            variant="primary"
            size="large"
            loading={isLoading}
            onClick={onContinue}
            className={LOGIN_ACTION_BUTTON_CLASS}
            icon={
              <HugeiconsIcon
                icon={Login01Icon}
                data-icon="log-in"
                className="h-5 w-5"
              />
            }
          >
            {t("common:actions.continue")}
          </Button>

          <Button
            variant="secondary"
            size="large"
            onClick={onSwitchAccount}
            className={LOGIN_ACTION_BUTTON_CLASS}
            icon={
              <HugeiconsIcon
                icon={Refresh04Icon}
                data-icon="refresh-cw"
                className="h-5 w-5"
              />
            }
            loading={false}
            loadingSpinIcon
          >
            {t("login.switchAccountButton")}
          </Button>

          <p className="m-0 text-center text-xs leading-normal text-text-3">
            {t("login.switchAccountHint")}
          </p>
        </div>
      </div>
    </>
  );
};

/**
 * Login Page Component
 *
 * Single-column card via OnboardingLayout (no right pane).
 *
 * When already authenticated, shows options to:
 * - Continue with current account
 * - Switch to a different account
 */
const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation("auth");
  const { isAuthenticated, isLoading, login } = useServiceAuth();

  // State for displaying auth errors
  const [callbackError, setCallbackError] = useState<string | null>(null);
  // Track if user is actively switching accounts (hide account options during switch)
  const [isSwitchingAccount, setIsSwitchingAccount] = useState(false);

  // Get the redirect location (where user was trying to go before login)
  const locationState = location.state as {
    from?: { pathname: string };
    sessionExpired?: boolean;
  } | null;
  const from = locationState?.from?.pathname;
  const redirectPath = from || ROUTES.workStation.base.path;

  // Check if user was redirected due to session expiration
  const sessionExpired = locationState?.sessionExpired === true;

  // Derive showAccountOptions from auth state (no effect needed)
  const showAccountOptions =
    isAuthenticated && !isLoading && !isSwitchingAccount;

  useEffect(() => {
    if (!HOSTED_LOGIN_ENABLED) {
      navigate(redirectPath, { replace: true });
    }
  }, [navigate, redirectPath]);

  // Disable Command+N (new window) on login page
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for Command+N (Mac) or Ctrl+N (Windows/Linux)
      if ((event.metaKey || event.ctrlKey) && event.key === "n") {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);

  const handleLogin = async () => {
    // Clear any previous error
    setCallbackError(null);
    // Store intended redirect URL
    sessionStorage.setItem("login_redirect", redirectPath);
    try {
      await login();
    } catch (err) {
      log.error("[LoginPage] login() error:", err);
      setCallbackError(
        err instanceof Error ? err.message : t("loading.failed")
      );
    }
  };

  // Continue without signing in (BYOK-only mode). The flag persists in
  // localStorage and is honored by AuthGuard / AuthRedirect; it is cleared
  // on successful sign-in or sign-out so the user can change their mind.
  const handleSkip = () => {
    setAuthSkipped(true);
    navigate(redirectPath, { replace: true });
  };

  // Continue with existing account
  const handleContinue = () => {
    navigate(redirectPath, { replace: true });
  };

  // Switch to a different account
  const handleSwitchAccount = async () => {
    // Set switching flag to hide account options
    setIsSwitchingAccount(true);
    // Clear existing tokens completely before initiating new login
    clearAuthStateCompletely();
    // Small delay to ensure state is cleared before login redirect
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Initiate fresh login flow
    handleLogin();
  };

  if (!HOSTED_LOGIN_ENABLED) {
    return <LoginLoadingState />;
  }

  // Show authenticated options if user has a valid session
  if (showAccountOptions && isAuthenticated) {
    return (
      <OnboardingLayout
        variant="contained"
        leftContent={
          <AuthenticatedForm
            isLoading={isLoading}
            onContinue={handleContinue}
            onSwitchAccount={handleSwitchAccount}
          />
        }
      />
    );
  }

  return (
    <OnboardingLayout
      variant="contained"
      leftContent={
        <LoginForm
          isLoading={isLoading}
          sessionExpired={sessionExpired}
          callbackError={callbackError}
          onLogin={handleLogin}
          onSkip={handleSkip}
        />
      }
    />
  );
};

export default LoginPage;
