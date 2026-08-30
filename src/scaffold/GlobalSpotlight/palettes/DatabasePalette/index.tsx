/**
 * DatabasePalette Component
 *
 * Simple spotlight for adding database connections.
 * Uses useSelectorKernel + SpotlightShell/PaletteBody for unified UI composition.
 */
import { homeDir } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { createLogger } from "@src/hooks/logger";
import {
  DatabaseIcon,
  File02Icon,
  FolderSearchIcon,
  Link01Icon,
} from "@src/icons";

import type { BasePaletteProps } from "../../shared";
import { PaletteBody, SpotlightShell } from "../../shell";
import type { SpotlightItem } from "../../types";
import { useSelectorKernel } from "../core";

const log = createLogger("DatabasePalette");

// ============ TYPES ============

export interface DatabasePaletteProps extends BasePaletteProps {
  onScanPath: (path: string) => Promise<void>;
}

type Mode = "select" | "path";

// ============ COMPONENT ============

export const DatabasePalette: React.FC<DatabasePaletteProps> = ({
  isOpen,
  onClose,
  onScanPath,
}) => {
  const { t } = useTranslation("common");

  // ============ STATE ============
  const [mode, setMode] = useState<Mode>("select");
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ============ RESET HANDLER ============
  const handleReset = useCallback(() => {
    setMode("select");
    setQuery("");
    setError(null);
    setIsLoading(false);
  }, []);

  // ============ HANDLERS ============
  const handlePick = useCallback(
    async (pickType: "folder" | "file") => {
      setIsLoading(true);
      setError(null);
      try {
        const selected = await open({
          multiple: false,
          directory: pickType === "folder",
          filters:
            pickType === "file"
              ? [
                  {
                    name: t("database.spotlight.pickerSqliteName"),
                    extensions: ["sqlite", "sqlite3", "db"],
                  },
                  {
                    name: t("database.spotlight.pickerAllFiles"),
                    extensions: ["*"],
                  },
                ]
              : undefined,
          title:
            pickType === "folder"
              ? t("database.spotlight.pickerFolderTitle")
              : t("database.spotlight.pickerFileTitle"),
        });

        if (selected && typeof selected === "string") {
          await onScanPath(selected);
          onClose();
        } else {
          setIsLoading(false);
        }
      } catch (err) {
        setError(t("database.spotlight.pickerError"));
        setIsLoading(false);
        log.error("Failed to pick:", err);
      }
    },
    [onScanPath, onClose, t]
  );

  const handlePathSubmit = useCallback(async () => {
    const path = query.trim();
    if (!path) return;

    setIsLoading(true);
    setError(null);

    try {
      let expandedPath = path;
      if (path.startsWith("~")) {
        const home = await homeDir();
        expandedPath = path.replace("~", home.replace(/\/$/, ""));
      }
      await onScanPath(expandedPath);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setIsLoading(false);
    }
  }, [query, onScanPath, onClose]);

  // ============ ITEMS ============
  const handleEnterPathMode = useCallback(() => {
    setMode("path");
    setQuery("");
  }, []);

  const items = useMemo((): SpotlightItem[] => {
    if (mode === "path") return [];

    return [
      {
        id: "scan-folder",
        label: t("database.spotlight.scanFolder"),
        desc: t("database.spotlight.scanFolderDesc"),
        icon: FolderSearchIcon,
        type: "action" as const,
        action: () => handlePick("folder"),
      },
      {
        id: "open-file",
        label: t("database.spotlight.openFile"),
        desc: t("database.spotlight.openFileDesc"),
        icon: File02Icon,
        type: "action" as const,
        action: () => handlePick("file"),
      },
      {
        id: "enter-path",
        label: t("database.spotlight.enterPath"),
        desc: t("database.spotlight.enterPathDesc"),
        icon: Link01Icon,
        type: "action" as const,
        action: handleEnterPathMode,
      },
    ];
  }, [mode, handlePick, handleEnterPathMode, t]);

  // ============ KERNEL ============
  // Path-mode keyboard handling runs first; in "select" mode we fall through
  // to the kernel default. External setter clears any error as the user
  // edits the query.
  const kernel = useSelectorKernel({
    isOpen,
    onClose,
    items,
    onReset: handleReset,
    externalSearchQuery: query,
    externalSetSearchQuery: (value) => {
      setQuery(value);
      setError(null);
    },
    externalHandleKeyDown: (event, internalHandleKeyDown) => {
      if (mode === "path") {
        if (event.key === "Enter" && query.trim()) {
          event.preventDefault();
          handlePathSubmit();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setMode("select");
          setQuery("");
          return;
        }
        if (event.key === "Backspace" && query === "") {
          event.preventDefault();
          setMode("select");
          return;
        }
        return;
      }
      internalHandleKeyDown(event);
    },
  });

  // ============ RENDER ============
  const placeholder =
    mode === "path"
      ? t("database.spotlight.placeholderPath")
      : t("database.spotlight.placeholderSelect");

  const errorDisplay = error ? (
    <div className="mx-3 my-2 rounded bg-danger-6/10 px-3 py-2 text-xs text-danger-6">
      {error}
    </div>
  ) : null;

  return (
    <SpotlightShell isOpen={isOpen} onClose={onClose}>
      <PaletteBody
        kernel={kernel}
        items={items}
        placeholder={placeholder}
        inputVariant="simple"
        inputIcon={DatabaseIcon}
        isLoading={isLoading}
        containerHeight={180}
        hintSlot={errorDisplay}
        contentOverride={mode === "path" ? <></> : undefined}
      />
    </SpotlightShell>
  );
};
