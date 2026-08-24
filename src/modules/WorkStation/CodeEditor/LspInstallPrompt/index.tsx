/**
 * LspInstallPrompt Component
 *
 * Bottom-right notification that appears when an LSP server is not installed.
 * Notification layout:
 * - Info icon + message
 * - Source label at bottom-left
 * - Action buttons at bottom-right (text buttons + primary button)
 * - Close (X) button at top-right
 *
 * Code Editor–only UI: mounted from AppShell only when the Code Editor app
 * mode is selected (anchored bottom-right). Switching to
 * browser/database/chat/other tools unmounts it.
 *
 * Reads from lspInstallPromptAtom (set by the linter extension when LSP
 * permanently fails with an installHint).
 */
import { invoke } from "@tauri-apps/api/core";
import { useAtomValue } from "jotai";
import { HelpCircle, X } from "lucide-react";
import { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { IconButton } from "@src/components/IconButton";
import { createLogger } from "@src/hooks/logger";
import { HEADER_ICON_SIZE } from "@src/modules/WorkStation/shared/tokens";
import { lspClientManager } from "@src/services/lsp/LspClientManager";
import { TerminalService } from "@src/services/terminal";
import {
  dismissLspInstallPrompt,
  lspInstallPromptAtom,
  triggerLspRetry,
} from "@src/store/workstation/codeEditor/diagnostics";

const log = createLogger("LspInstallPrompt");

/** Result from lsp_get_install_command Tauri command */
interface InstallCommandResult {
  command: string;
  packageManagerFound: boolean;
  error: string | null;
}

export const LspInstallPrompt = memo(() => {
  const prompt = useAtomValue(lspInstallPromptAtom);
  const { t } = useTranslation();
  const [installing, setInstalling] = useState(false);

  const handleInstall = useCallback(async () => {
    if (!prompt) return;
    setInstalling(true);

    try {
      // Get the install command from the Rust backend
      const result = await invoke<InstallCommandResult>(
        "lsp_get_install_command",
        { language: prompt.language }
      );

      if (!result.command) {
        log.warn(
          "[LspInstallPrompt] No install command available:",
          result.error
        );
        setInstalling(false);
        return;
      }

      // Execute the install command in the integrated terminal
      await TerminalService.execute(result.command);

      // Drop the cached "installed?" bit so the post-install retry
      // re-queries `lsp_check_installed` instead of reusing the stale
      // pre-install snapshot. Otherwise the install hint would still
      // appear right after a successful install.
      lspClientManager.invalidateInstallHint(prompt.language);

      // Dismiss prompt and trigger LSP retry after a short delay
      // (gives the terminal time to run the command). `triggerLspRetry`
      // also clears the Rust broken-cooldown via `lsp_revive_all`.
      dismissLspInstallPrompt();
      setTimeout(() => {
        triggerLspRetry();
      }, 3000);
    } catch (error: unknown) {
      log.error("[LspInstallPrompt] Install failed:", error);
      setInstalling(false);
    }
  }, [prompt]);

  const handleDismiss = useCallback(() => {
    dismissLspInstallPrompt();
  }, []);

  if (!prompt) return null;

  return (
    <div className="absolute bottom-4 right-4 z-[1100] w-[350px]">
      <div className="flex flex-col rounded-[12px] bg-fill-2 shadow-[0_4px_16px_rgba(0,0,0,0.3)]">
        {/* Header row: icon + message + close button */}
        <div className="flex items-start gap-2.5 px-3 pb-0 pt-3">
          <HelpCircle size={14} className="mt-[2px] shrink-0 text-primary-6" />
          <p className="min-w-0 flex-1 text-[13px] leading-[1.4] text-text-1">
            {t("lsp.installPrompt", { language: prompt.language })}
          </p>
          <IconButton
            type="button"
            size="sm"
            variant="default"
            className="shrink-0"
            onClick={handleDismiss}
            aria-label={t("actions.close")}
            title={t("actions.close")}
          >
            <X size={HEADER_ICON_SIZE.sm} />
          </IconButton>
        </div>

        {/* Footer row: source label + action buttons */}
        <div className="flex items-center justify-between px-3 pb-2 pt-2.5">
          <span className="text-xs text-text-3">
            Source: {t("terminology.languageServer")}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="tertiary"
              size="mini"
              onClick={handleDismiss}
              disabled={installing}
            >
              {t("tooltips.dismiss")}
            </Button>
            <Button
              variant="primary"
              size="mini"
              onClick={handleInstall}
              disabled={installing}
              loading={installing}
            >
              {installing ? t("lsp.installing") : t("actions.install")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
});

LspInstallPrompt.displayName = "LspInstallPrompt";

export default LspInstallPrompt;
