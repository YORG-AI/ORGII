/**
 * Orchestrates the cookie-import flow: discover sources → preview one (which
 * may trigger the OS keychain prompt) → import the chosen sites.
 *
 * Keeps the modal presentational. All backend calls funnel through here so the
 * modal only renders state and dispatches intents.
 *
 * The host mounts the modal only while it is open, so this hook starts fresh
 * on every open: sources load on mount and no state needs resetting.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type CookieImportPreview,
  type CookieImportResult,
  type CookieImportSource,
  importBrowserCookies,
  isCookieImportError,
  listCookieImportSources,
  openFullDiskAccessSettings as openFullDiskAccessSettingsPane,
  previewCookieImport,
} from "@src/api/tauri/browserCookies";
import Message from "@src/components/Message";
import { createLogger } from "@src/hooks/logger";

import {
  initialSelectedDomains,
  setAllDomains as setAllDomainsHelper,
  toggleDomain as toggleDomainHelper,
} from "./importCookiesSelection";

const logger = createLogger("ImportCookies");

/** A declined keychain prompt gets its own, retry-oriented message. */
function failureMessageKey(error: unknown, fallbackKey: string): string {
  return isCookieImportError(error) && error.code === "keychain_denied"
    ? "browserCookieImport.errors.keychainDenied"
    : fallbackKey;
}

/** Which screen of the flow is showing. */
export type ImportStage = "sources" | "preview" | "done";

export interface ImportCookiesController {
  stage: ImportStage;
  sourcesLoading: boolean;
  sources: CookieImportSource[];
  /** A source the user picked that cannot be read yet (e.g. Safari without
   *  Full Disk Access); the picker explains what to do. */
  unavailableSource: CookieImportSource | null;
  activeSource: CookieImportSource | null;
  previewLoading: boolean;
  preview: CookieImportPreview | null;
  selectedDomains: ReadonlySet<string>;
  importing: boolean;
  result: CookieImportResult | null;
  selectSource: (sourceId: string) => void;
  /** Re-scan sources, e.g. after the user granted Full Disk Access. */
  refreshSources: () => void;
  openFullDiskAccessSettings: () => void;
  toggleDomain: (domain: string) => void;
  setAllDomains: (selected: boolean) => void;
  runImport: () => void;
  backToSources: () => void;
}

export function useImportCookiesController(
  onImported?: (result: CookieImportResult) => void
): ImportCookiesController {
  const { t } = useTranslation();

  const [stage, setStage] = useState<ImportStage>("sources");
  const [sources, setSources] = useState<CookieImportSource[]>([]);
  // Starts true: the source scan begins on mount (see the effect below).
  const [sourcesLoading, setSourcesLoading] = useState(true);
  // Bumped by refreshSources to re-run the scan.
  const [scanGeneration, setScanGeneration] = useState(0);
  const [unavailableSource, setUnavailableSource] =
    useState<CookieImportSource | null>(null);
  const [activeSource, setActiveSource] = useState<CookieImportSource | null>(
    null
  );
  const [preview, setPreview] = useState<CookieImportPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [selectedDomains, setSelectedDomains] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<CookieImportResult | null>(null);

  // Guards against a slow preview/import resolving after the modal closed or the
  // user moved on to a different source.
  const requestRef = useRef(0);

  // Discover sources on mount and on every refresh. State updates happen only
  // in the async continuations, never synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    listCookieImportSources()
      .then((found) => {
        if (!cancelled) setSources(found);
      })
      .catch((error: unknown) => {
        logger.error("failed to list cookie sources:", error);
        if (!cancelled) {
          setSources([]);
          Message.error(t("browserCookieImport.errors.listFailed"));
        }
      })
      .finally(() => {
        if (!cancelled) setSourcesLoading(false);
      });
    return () => {
      cancelled = true;
      requestRef.current += 1;
    };
  }, [t, scanGeneration]);

  const refreshSources = useCallback(() => {
    setUnavailableSource(null);
    setSourcesLoading(true);
    setScanGeneration((generation) => generation + 1);
  }, []);

  const openFullDiskAccessSettings = useCallback(() => {
    openFullDiskAccessSettingsPane().catch((error: unknown) => {
      logger.error("failed to open Full Disk Access settings:", error);
      Message.error(t("browserCookieImport.errors.openSettingsFailed"));
    });
  }, [t]);

  const selectSource = useCallback(
    (sourceId: string) => {
      const source = sources.find((candidate) => candidate.id === sourceId);
      if (!source) return;
      if (source.unavailableReason) {
        // Stay on the picker and explain how to unblock it.
        setUnavailableSource(source);
        return;
      }
      const token = ++requestRef.current;
      setUnavailableSource(null);
      setActiveSource(source);
      setStage("preview");
      setPreview(null);
      setPreviewLoading(true);

      previewCookieImport(sourceId)
        .then((loaded) => {
          if (requestRef.current !== token) return;
          setPreview(loaded);
          setSelectedDomains(initialSelectedDomains(loaded));
        })
        .catch((error: unknown) => {
          logger.error("failed to preview cookie source:", error);
          if (requestRef.current !== token) return;
          // Back to the picker with the row still clickable: a declined
          // keychain prompt or a blocked store must be retryable, not final.
          setActiveSource(null);
          setStage("sources");
          if (isCookieImportError(error) && error.code === "full_disk_access") {
            setUnavailableSource(source);
            return;
          }
          Message.error(
            t(
              failureMessageKey(
                error,
                "browserCookieImport.errors.previewFailed"
              )
            )
          );
        })
        .finally(() => {
          if (requestRef.current === token) setPreviewLoading(false);
        });
    },
    [sources, t]
  );

  const toggleDomain = useCallback((domain: string) => {
    setSelectedDomains((current) => toggleDomainHelper(current, domain));
  }, []);

  const setAllDomains = useCallback(
    (selected: boolean) => {
      setSelectedDomains(setAllDomainsHelper(preview?.sites ?? [], selected));
    },
    [preview]
  );

  const backToSources = useCallback(() => {
    requestRef.current += 1;
    setActiveSource(null);
    setPreview(null);
    setSelectedDomains(new Set());
    setStage("sources");
  }, []);

  const runImport = useCallback(() => {
    if (!activeSource || selectedDomains.size === 0) return;
    const token = ++requestRef.current;
    const domains = [...selectedDomains];
    setImporting(true);

    importBrowserCookies(activeSource.id, domains)
      .then((imported) => {
        if (requestRef.current !== token) return;
        setResult(imported);
        setStage("done");
        Message.success(
          t("browserCookieImport.imported", {
            count: imported.importedCookies,
          })
        );
        onImported?.(imported);
      })
      .catch((error: unknown) => {
        logger.error("failed to import cookies:", error);
        if (requestRef.current !== token) return;
        // Stay on the checklist so Import can simply be pressed again.
        Message.error(
          t(failureMessageKey(error, "browserCookieImport.errors.importFailed"))
        );
      })
      .finally(() => {
        if (requestRef.current === token) setImporting(false);
      });
  }, [activeSource, selectedDomains, t, onImported]);

  return {
    stage,
    sourcesLoading,
    sources,
    unavailableSource,
    activeSource,
    previewLoading,
    preview,
    selectedDomains,
    importing,
    result,
    selectSource,
    refreshSources,
    openFullDiskAccessSettings,
    toggleDomain,
    setAllDomains,
    runImport,
    backToSources,
  };
}
