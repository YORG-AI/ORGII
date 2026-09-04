import Button from "@/src/components/Button";
import Modal from "@/src/scaffold/ModalSystem";
import { cancel, onUrl, start } from "@fabianlars/tauri-plugin-oauth";
import { openPath } from "@tauri-apps/plugin-opener";
import { useAtom, useAtomValue } from "jotai";
import { useState } from "react";

import {
  completeLogin,
  getCurrentUserInfo,
  getLoginUrl,
} from "@src/api/http/auth/login";
import { SERVICE_AUTH_STORAGE_KEYS } from "@src/config/serviceAuth";
import { createLogger } from "@src/hooks/logger";
import { HugeiconsIcon, SparklesIcon } from "@src/icons";
import { loginModalFixAtom, loginModalVisibleAtom } from "@src/store";
import { userAtom } from "@src/store/user";
import type { IUserInfo } from "@src/types/core/user";
import { isTauriDesktop } from "@src/util/platform/tauri";

const log = createLogger("Login");

// OAuth callback template for Tauri desktop
const callbackTemplate = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Open+Sans&display=swap" rel="stylesheet">
  <title>My Notes</title>
  <style>
    body {
      font-family: 'Open Sans', sans-serif;
      margin: auto;
      max-width: 640px;
      text-align: center;
    }
  </style>
</head>
<body>
  <h2>You can now open the app</h2>
</body>
</html>
`;

async function stopOAuthServer() {
  try {
    await cancel(54031);
  } catch (error) {
    log.error("Error stopping OAuth server:", error);
  }
}

function completeOAuthSignIn(
  payload: string,
  setUser: (user: IUserInfo) => void,
  setVisible: (visible: boolean) => void
) {
  const url = new URL(payload);
  let code;
  try {
    code = new URLSearchParams(url.search).get("code");
  } catch (error) {
    log.error("Error parsing URL for code:", error);
    code = null;
  }
  if (!code) {
    log.error("No code found in URL");
    return;
  }

  // Check if login is already in progress to prevent duplicate requests
  const loginInProgress = sessionStorage.getItem("login_in_progress");
  if (loginInProgress) {
    return;
  }

  // Mark login as in progress
  sessionStorage.setItem("login_in_progress", "true");
  completeLogin({ code })
    .then(async (res) => {
      if (res && res?.status !== 200) {
        setUser(res.data.user);
        // Legacy Authing SSO path (not used in OSS BYOK mode). When it does
        // run, write the issued id_token into the same hosted_access_token
        // slot that headers.ts/getOrRefreshHostedToken read so we don't keep
        // a parallel `id_token` localStorage key around.
        localStorage.setItem(
          SERVICE_AUTH_STORAGE_KEYS.accessToken,
          res.data.id_token
        );
        localStorage.setItem("user_id", res.data.user.uuid);
        // Notify localStorage listeners of the auth update
        window.dispatchEvent(new Event("localStorageChange"));

        try {
          const userInfoRes = await getCurrentUserInfo();
          if (userInfoRes && userInfoRes.status === 0) {
            setUser(userInfoRes.data.user_public);
          }
        } catch (err) {
          log.error("Failed to get current user info:", err);
        }

        // Close the modal after all user info is updated
        setTimeout(() => {
          setVisible(false);
        }, 300);
      }
    })
    .catch((err) => {
      log.error(err);
    })
    .finally(() => {
      // Clear login in progress flag
      sessionStorage.removeItem("login_in_progress");
      // Ensure modal stays closed after login attempt
      setTimeout(() => {}, 500);
    });
}

const openOAuthSignIn = async (loginUrl: string) => {
  try {
    await openPath(loginUrl);
  } catch (error) {
    throw new Error("Failed to open path: " + error);
  }
};

async function startOAuthFlow(
  login_url: string,
  setUser: (user: IUserInfo) => void,
  setVisible: (visible: boolean) => void
) {
  try {
    // Try to stop any existing OAuth server on this port before starting a new one
    try {
      await cancel(54031);
    } catch (error) {
      // It's okay if nothing was running
    }

    await start({
      ports: [54031],
      response: callbackTemplate,
    });
    // Set up listeners for OAuth results
    await onUrl((url) => {
      completeOAuthSignIn(url, setUser, setVisible);
      stopOAuthServer();
    });

    openOAuthSignIn(login_url);
  } catch (error) {
    log.error("Error starting OAuth server:", error);
  }
}

const LoginModal = () => {
  const [visible, setVisible] = useAtom(loginModalVisibleAtom);
  const loginModalFix = useAtomValue(loginModalFixAtom);
  const [_user, setUser] = useAtom(userAtom);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  return (
    <Modal
      visible={visible}
      okText="ok"
      footer={null}
      cancelText="Cancel"
      onOk={() => setVisible(false)}
      onCancel={loginModalFix ? () => {} : () => setVisible(false)}
      maskClosable={!loginModalFix}
      escToExit={!loginModalFix}
      className="login__modal h-[500px] w-[400px] rounded-xl bg-bg-2"
    >
      <div className="flex h-full w-full flex-col items-center justify-center">
        <HugeiconsIcon
          icon={SparklesIcon}
          data-icon="sparkles"
          size={24}
          strokeWidth={1.75}
          className="text-primary-6"
        />
        <p className="mt-4 mb-6 font-medium text-text-1">
          Unlock the power of Atlas XP
        </p>
        <Button
          variant="primary"
          className="h-8 w-[320px]"
          loading={isLoading}
          onClick={async () => {
            try {
              setIsLoading(true);
              const res = await getLoginUrl();
              if (!res) return;

              if (isTauriDesktop()) {
                await startOAuthFlow(res.data.url, setUser, setVisible);
              } else {
                window.location.assign(res.data.url);
                // Close modal since we're redirecting
                setVisible(false);
              }
            } catch (error) {
              log.error("Login error:", error);
            } finally {
              setIsLoading(false);
            }
          }}
        >
          Login in / Sign Up
        </Button>
        <p className="mt-4 text-center text-sm text-text-2">
          By clicking any of the above buttons, you agree to the
          <a
            href="https://www.example.com/terms"
            target="_blank"
            className="text-primary-6 hover:underline"
            rel="noreferrer"
          >
            &nbsp;ATLAS AI TOS&nbsp;
          </a>{" "}
          and
          <a
            href="https://www.example.com/privacy"
            target="_blank"
            className="text-primary-6 hover:underline"
            rel="noreferrer"
          >
            &nbsp;Privacy Policy
          </a>
          .
        </p>
      </div>
    </Modal>
  );
};
export default LoginModal;
