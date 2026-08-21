import { useEffect, useRef } from "react";

const OAUTH_BROWSER_MOUNT_DELAY_MS = 100;

/**
 * Starts one OAuth attempt after its browser surface is mounted.
 *
 * A native webview can close independently of the React surface. That must not
 * create a new PKCE attempt automatically: retries are an explicit user action.
 */
export function useOAuthBrowserAutoStart(
  showBrowser: boolean,
  startLogin: () => Promise<void>
): void {
  const startLoginRef = useRef(startLogin);
  const startedForCurrentOpenRef = useRef(false);

  useEffect(() => {
    startLoginRef.current = startLogin;
  }, [startLogin]);

  useEffect(() => {
    if (!showBrowser) {
      startedForCurrentOpenRef.current = false;
      return;
    }
    if (startedForCurrentOpenRef.current) return;

    const timer = window.setTimeout(() => {
      if (startedForCurrentOpenRef.current) return;
      startedForCurrentOpenRef.current = true;
      void startLoginRef.current();
    }, OAUTH_BROWSER_MOUNT_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [showBrowser]);
}
