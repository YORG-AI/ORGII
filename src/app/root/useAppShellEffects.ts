/**
 * useAppShellEffects
 *
 * Applies global CSS variables and HTML-element class toggles that reflect
 * user appearance settings stored in Jotai atoms. Each effect is independent
 * and cleans up its own DOM mutations on unmount.
 *
 * Managed properties:
 * - Native WebView scale + coordinate scale variables         (uiScaleAtom, 0–200 %)
 * - `--app-font-family`                                    (applicationUiFontAtom)
 * - Chat typography variables                              (chat appearance settings)
 * - `html.fullscreen` class                                (windowFullscreenAtom)
 *
 * This hook must run in AppBootstrap (before first render) so the styles are
 * applied before any child component paints, avoiding a flash of unstyled UI.
 */
import { useAtomValue } from "jotai";
import { useEffect } from "react";

import { getApplicationUiFontStack } from "@src/config/appearance/applicationUiFonts";
import { createLogger } from "@src/hooks/logger";
import {
  chatCodeFontSizeAtom,
  chatFontSizeAtom,
  chatLineHeightAtom,
} from "@src/store/config/configAtom";
import {
  applicationUiFontAtom,
  uiScaleAtom,
  windowFullscreenAtom,
} from "@src/store/ui/uiAtom";
import { isWindows } from "@src/util/platform/tauri";
import { invokeTauri } from "@src/util/platform/tauri/init";
import { resolveNativeFrameScale } from "@src/util/platform/tauri/nativeFrame";

const logger = createLogger("AppShellEffects");

export function useAppShellEffects(): void {
  const uiScale = useAtomValue(uiScaleAtom);
  const applicationUiFont = useAtomValue(applicationUiFontAtom);
  const isFullscreen = useAtomValue(windowFullscreenAtom);
  const chatFontSize = useAtomValue(chatFontSizeAtom);
  const chatCodeFontSize = useAtomValue(chatCodeFontSizeAtom);
  const chatLineHeight = useAtomValue(chatLineHeightAtom);

  useEffect(() => {
    let disposed = false;
    let unlistenScaleChanged: (() => void) | null = null;
    const root = document.documentElement;
    const appRoot = document.getElementById("root");
    const scaleValue = uiScale / 100;
    const currentWindowPromise = import("@tauri-apps/api/window").then(
      ({ getCurrentWindow }) => getCurrentWindow()
    );

    const dispatchScaleApplied = () => {
      requestAnimationFrame(() => {
        if (!disposed) {
          window.dispatchEvent(new CustomEvent("orgii-ui-scale-applied"));
        }
      });
    };

    const applyNativeFrameScale = (nextScale: number) => {
      root.style.setProperty("--native-frame-scale", String(nextScale));
      dispatchScaleApplied();
    };

    const applyMeasuredNativeFrameScale = async () => {
      try {
        const appWindow = await currentWindowPromise;
        if (disposed) return;

        const windowScaleFactor = await appWindow.scaleFactor();
        if (disposed) return;

        // Windows WebView2 can report DOM CSS pixels in a different logical
        // scale than Tauri's window scale. Keep non-Windows on the existing
        // configured scale path until verified on WKWebView/Linux.
        const nextScale = isWindows()
          ? resolveNativeFrameScale(
              window.devicePixelRatio,
              windowScaleFactor,
              scaleValue
            )
          : scaleValue;

        applyNativeFrameScale(nextScale);
      } catch (error) {
        logger.error("failed to measure native frame scale:", error);
      }
    };

    root.style.zoom = "";
    root.style.setProperty("--ui-scale", "1");
    root.style.setProperty("--native-frame-scale", String(scaleValue));
    invokeTauri("set_main_webview_zoom", { scaleFactor: scaleValue }).catch(
      (error) => {
        logger.error("failed to set native WebView zoom:", error);
      }
    );

    if (appRoot) {
      appRoot.style.transform = "";
      appRoot.style.transformOrigin = "";
      appRoot.style.width = "";
      appRoot.style.height = "";
    }

    dispatchScaleApplied();
    void applyMeasuredNativeFrameScale();

    void currentWindowPromise
      .then(async (appWindow) => {
        if (disposed) return;
        const unlisten = await appWindow.onScaleChanged(() => {
          void applyMeasuredNativeFrameScale();
        });
        if (disposed) {
          unlisten();
          return;
        }
        unlistenScaleChanged = unlisten;
      })
      .catch((error) => {
        logger.error(
          "failed to listen for native window scale changes:",
          error
        );
      });

    return () => {
      disposed = true;
      unlistenScaleChanged?.();
      root.style.zoom = "";
      root.style.removeProperty("--ui-scale");
      root.style.removeProperty("--native-frame-scale");
    };
  }, [uiScale]);

  useEffect(() => {
    const root = document.documentElement;
    const stack = getApplicationUiFontStack(applicationUiFont);
    root.style.setProperty("--app-font-family", stack);
    return () => {
      root.style.removeProperty("--app-font-family");
    };
  }, [applicationUiFont]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--chat-font-size", `${chatFontSize}px`);
    root.style.setProperty("--chat-code-font-size", `${chatCodeFontSize}px`);
    root.style.setProperty("--chat-line-height", String(chatLineHeight));

    return () => {
      root.style.removeProperty("--chat-font-size");
      root.style.removeProperty("--chat-code-font-size");
      root.style.removeProperty("--chat-line-height");
    };
  }, [chatCodeFontSize, chatFontSize, chatLineHeight]);

  useEffect(() => {
    const htmlElement = document.documentElement;
    if (isFullscreen) {
      htmlElement.classList.add("fullscreen");
    } else {
      htmlElement.classList.remove("fullscreen");
    }
  }, [isFullscreen]);
}
