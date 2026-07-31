import { useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import { SETUP_WALKTHROUGH_TEST_MENU_EVENT } from "@src/config/keyboard/setupWalkthroughShortcut";
import { ROUTES } from "@src/config/routes";
import { createDefaultSetupWalkthroughProgress } from "@src/config/settingsSchema/setupWalkthroughProgress";
import { saveSettingsBatchAtom } from "@src/store/settings/settingsAtom";
import { isTauriDesktop } from "@src/util/platform/tauri";

type TestShortcutEvent = Pick<
  KeyboardEvent,
  | "altKey"
  | "code"
  | "ctrlKey"
  | "isComposing"
  | "metaKey"
  | "repeat"
  | "shiftKey"
>;

export {
  SETUP_WALKTHROUGH_TEST_MENU_EVENT,
  SETUP_WALKTHROUGH_TEST_SHORTCUT,
} from "@src/config/keyboard/setupWalkthroughShortcut";

export function isSetupWalkthroughTestShortcut(
  event: TestShortcutEvent,
  platform: string
): boolean {
  const isMac = platform.toUpperCase().includes("MAC");
  const hasPrimaryModifier = isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;

  return (
    !event.isComposing &&
    !event.repeat &&
    hasPrimaryModifier &&
    event.altKey &&
    !event.shiftKey &&
    event.code === "KeyO"
  );
}

export function createSetupWalkthroughTestUpdates() {
  return {
    "general.setupWalkthroughOutcome": "open" as const,
    "general.setupWalkthroughProgress": createDefaultSetupWalkthroughProgress(),
  };
}

interface RunSetupWalkthroughTestEntryOptions {
  persist: (
    updates: ReturnType<typeof createSetupWalkthroughTestUpdates>
  ) => Promise<void>;
  navigate: () => void | Promise<void>;
}

export async function runSetupWalkthroughTestEntry({
  persist,
  navigate,
}: RunSetupWalkthroughTestEntryOptions): Promise<void> {
  await persist(createSetupWalkthroughTestUpdates());
  await navigate();
}

/**
 * Hidden release-build test entry. It resets only setup-owned readiness state;
 * credentials, organization membership, workspaces, and product data remain
 * authoritative in their existing owners.
 */
export function useSetupWalkthroughTestShortcut(): void {
  const { t } = useTranslation("onboarding");
  const saveSettings = useSetAtom(saveSettingsBatchAtom);
  const inFlightRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let unlistenNativeMenu: (() => void) | undefined;

    const triggerEntry = () => {
      if (disposed) return;
      if (inFlightRef.current) return;
      inFlightRef.current = true;

      void runSetupWalkthroughTestEntry({
        persist: saveSettings,
        navigate: async () => {
          // GlobalShortcuts mounts outside RouterProvider. Load the shared
          // router only after a real shortcut fires so this module's pure
          // helpers also remain safe in non-DOM tests.
          const { router } = await import("@src/router");
          await router.navigate(ROUTES.auth.setup.path);
        },
      })
        .catch(() => {
          if (!disposed) Message.error(t("common:status.saveFailed"));
        })
        .finally(() => {
          if (!disposed) inFlightRef.current = false;
        });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isSetupWalkthroughTestShortcut(event, navigator.platform)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      triggerEntry();
    };

    const handleMenuEvent = () => {
      triggerEntry();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener(SETUP_WALKTHROUGH_TEST_MENU_EVENT, handleMenuEvent);

    if (isTauriDesktop()) {
      void import("@tauri-apps/api/event")
        .then(({ listen }) =>
          listen(SETUP_WALKTHROUGH_TEST_MENU_EVENT, handleMenuEvent)
        )
        .then((unlisten) => {
          if (disposed) {
            unlisten();
            return;
          }
          unlistenNativeMenu = unlisten;
        })
        .catch(() => {
          // The DOM shortcut and Windows menu event remain available when the
          // native event bridge is unavailable (for example in browser tests).
        });
    }

    return () => {
      disposed = true;
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener(
        SETUP_WALKTHROUGH_TEST_MENU_EVENT,
        handleMenuEvent
      );
      unlistenNativeMenu?.();
    };
  }, [saveSettings, t]);
}
