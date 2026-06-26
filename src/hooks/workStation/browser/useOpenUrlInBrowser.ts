/**
 * useOpenUrlInBrowser
 *
 * Single always-mounted listener for the "open-url-in-browser" CustomEvent.
 * Adds the URL as a Browser tab in the background without navigating away
 * from the current page. A toast notification lets the user know a tab was
 * opened; they can switch to Browser (My Station or Agent Station) at will.
 *
 * Mount this hook exactly once, at the app root (inside BrowserProvider).
 * All per-surface ad-hoc listeners should be removed in favour of this hook.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import Message from "@src/components/Message";
import { ROUTES } from "@src/config/routes";
import { useBrowserContext } from "@src/contexts/workstation";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import {
  comparableBrowserUrl,
  normalizeBrowserInput,
} from "@src/util/url/browserUrl";

export function useOpenUrlInBrowser(): void {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const stationMode = useAtomValue(stationModeAtom);
  const setStationMode = useSetAtom(stationModeAtom);
  const setChatPanelMaximized = useSetAtom(chatPanelMaximizedAtom);
  const { sessions, handleAddSession, handleSessionClick } =
    useBrowserContext();

  const sessionsRef = useRef(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const stationModeRef = useRef(stationMode);
  useEffect(() => {
    stationModeRef.current = stationMode;
  }, [stationMode]);

  const setStationModeRef = useRef(setStationMode);
  useEffect(() => {
    setStationModeRef.current = setStationMode;
  }, [setStationMode]);

  const setChatPanelMaximizedRef = useRef(setChatPanelMaximized);
  useEffect(() => {
    setChatPanelMaximizedRef.current = setChatPanelMaximized;
  }, [setChatPanelMaximized]);

  const pathnameRef = useRef(location.pathname);
  useEffect(() => {
    pathnameRef.current = location.pathname;
  }, [location.pathname]);

  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    function handleEvent(event: Event): void {
      const { url, navigate: shouldNavigate } = (
        event as CustomEvent<{ url: string; navigate?: boolean }>
      ).detail;
      if (!url) return;

      const normalized = normalizeBrowserInput(url);
      if (!normalized) return;

      const comparableUrl = comparableBrowserUrl(normalized);
      const existing = sessionsRef.current.find(
        (session) => comparableBrowserUrl(session.url) === comparableUrl
      );

      if (existing) {
        handleSessionClick(existing.id);
      } else {
        handleAddSession(normalized);
      }

      const alreadyOnBrowser =
        stationModeRef.current === "my-station" &&
        pathnameRef.current === ROUTES.workStation.browser.path;

      if (shouldNavigate) {
        setChatPanelMaximizedRef.current(false);
        setStationModeRef.current("my-station");
        navigateRef.current(ROUTES.workStation.browser.path);
        return;
      }

      if (alreadyOnBrowser) {
        // Already on the Browser page — tab switch is enough, no toast needed.
        return;
      }

      // Stay on the current page; show a toast with a "Go to Browser" button.
      Message.info({
        content: normalized,
        title: tRef.current("browser.openedInBrowser"),
        closable: true,
        duration: 6000,
        cancel: {
          label: tRef.current("browser.goToBrowser"),
          closeOnClick: true,
          onClick: () => {
            setChatPanelMaximizedRef.current(false);
            setStationModeRef.current("my-station");
            navigateRef.current(ROUTES.workStation.browser.path);
          },
        },
      });
    }

    window.addEventListener("open-url-in-browser", handleEvent);
    return () => {
      window.removeEventListener("open-url-in-browser", handleEvent);
    };
    // handleAddSession and handleSessionClick are stable useCallback refs from
    // BrowserContext, so this effect only mounts/unmounts once.
  }, [handleAddSession, handleSessionClick]);
}
