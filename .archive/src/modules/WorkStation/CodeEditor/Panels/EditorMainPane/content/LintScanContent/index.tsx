/**
 * LintScanContent — main-pane tab for workspace lint scan configuration.
 *
 * Two-tier wizard-style selection:
 * 1. Language grid (ActionCard multi-select) — pick which languages to scan
 * 2. Auto-resolved tools — derived from selected languages, individually toggleable
 *
 * Language composition bar is loaded on-demand (footer toggle) to avoid
 * blocking the UI with a full repo file-walk on tab mount.
 *
 * Scan is orchestrated by Rust backend for:
 * - Tool deduplication (Python: ruff > pylint > flake8)
 * - ESLint directory chunking
 * - Heavy tool concurrency limiting
 */
import { useAtom, useAtomValue, useStore } from "jotai";
import { Loader2, Play, ScanSearch, Square } from "lucide-react";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import FileTypeIcon from "@src/components/FileTypeIcon";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { createLogger } from "@src/hooks/logger";
import { DETAIL_PANEL_TOKENS } from "@src/modules/shared/layouts/blocks";
import {
  PANEL_HEADER_TOKENS,
  PanelHeader,
  Placeholder,
} from "@src/modules/shared/layouts/blocks";
import {
  FormField,
  SelectionGrid,
  WizardStepLayout,
} from "@src/scaffold/WizardSystem/primitives";
import type { SelectionGridOption } from "@src/scaffold/WizardSystem/primitives";
import type { AvailableTool } from "@src/services/lsp/workspaceScan";
import {
  abortWorkspaceScan,
  isScanningAtom,
  scanProgressAtom,
  scanScopeAtom,
  startWorkspaceScan,
} from "@src/store/workstation/codeEditor/diagnostics";
import type { ScanScope } from "@src/store/workstation/codeEditor/diagnostics";

import LanguageBar from "./LanguageBar";
import ScanProgressSection from "./ScanProgressSection";
import { LANGUAGE_DEFS, SCOPE_OPTIONS, TOOL_ICON_FILE } from "./config";
import { useCachedLintTools, useLanguageComposition } from "./hooks";
import type { LintScanContentProps } from "./types";

const log = createLogger("LintScanContent");

const LintScanContent: React.FC<LintScanContentProps> = memo(({ repoPath }) => {
  const { t } = useTranslation();
  const store = useStore();
  const isScanning = useAtomValue(isScanningAtom);
  const scanProgress = useAtomValue(scanProgressAtom);
  const [scanScope, setScanScope] = useAtom(scanScopeAtom);

  const [availableTools, setAvailableTools] = useState<AvailableTool[]>([]);
  const [selectedLanguages, setSelectedLanguages] = useState<Set<string>>(
    new Set()
  );
  const [excludedTools, setExcludedTools] = useState<Set<string>>(new Set());
  const [showComposition, setShowComposition] = useState(false);

  const lintTools = useCachedLintTools();

  const {
    stats: compositionStats,
    loading: compositionLoading,
    detect: detectComposition,
  } = useLanguageComposition(repoPath);

  const languageToolMap = useMemo(() => {
    const langMap = new Map<string, Set<string>>();
    for (const def of LANGUAGE_DEFS) {
      const toolNames = new Set<string>();
      for (const tool of lintTools) {
        if (
          tool.installed &&
          tool.languages.some((toolLang) =>
            def.toolLanguageKeys.includes(toolLang.toLowerCase())
          )
        ) {
          toolNames.add(tool.id);
        }
      }
      if (toolNames.size > 0) {
        langMap.set(def.language, toolNames);
      }
    }
    return langMap;
  }, [lintTools]);

  const languageGridOptions = useMemo<SelectionGridOption[]>(() => {
    const options: SelectionGridOption[] = [];
    for (const def of LANGUAGE_DEFS) {
      const tools = languageToolMap.get(def.language);
      if (!tools || tools.size === 0) continue;
      options.push({
        key: def.language,
        label: def.language,
        iconElement: (
          <FileTypeIcon
            fileName={def.iconFile}
            size="medium"
            className="shrink-0"
          />
        ),
      });
    }
    options.sort((optA, optB) => optA.label.localeCompare(optB.label));
    return options;
  }, [languageToolMap]);

  const selectedTools = useMemo(() => {
    const tools = new Set<string>();
    for (const lang of selectedLanguages) {
      const langTools = languageToolMap.get(lang);
      if (langTools) {
        for (const toolName of langTools) {
          if (!excludedTools.has(toolName)) {
            tools.add(toolName);
          }
        }
      }
    }
    return tools;
  }, [selectedLanguages, languageToolMap, excludedTools]);

  const toolGridOptions = useMemo<SelectionGridOption[]>(() => {
    const options: SelectionGridOption[] = [];
    const seen = new Set<string>();
    for (const lang of selectedLanguages) {
      const langTools = languageToolMap.get(lang);
      if (!langTools) continue;
      for (const toolId of langTools) {
        if (seen.has(toolId)) continue;
        seen.add(toolId);
        const toolInfo = lintTools.find((lt) => lt.id === toolId);
        options.push({
          key: toolId,
          label: toolInfo?.name ?? toolId,
          iconElement: (
            <FileTypeIcon
              fileName={TOOL_ICON_FILE[toolId] ?? "file.txt"}
              size="medium"
              className="shrink-0"
            />
          ),
        });
      }
    }
    return options;
  }, [selectedLanguages, languageToolMap, lintTools]);

  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;

    const fetchTools = async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const tools = await invoke<AvailableTool[]>("lint_scan_get_tools", {
          workspacePath: repoPath,
        });
        if (cancelled) return;
        setAvailableTools(tools.filter((tool) => tool.installed));
      } catch (err) {
        if (!cancelled) {
          log.warn("[LintScanContent] Failed to fetch tools:", err);
        }
      }
    };

    fetchTools();
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (autoSelectedRef.current || languageToolMap.size === 0) return;
    autoSelectedRef.current = true;
    setSelectedLanguages(new Set(languageToolMap.keys()));
  }, [languageToolMap]);

  const handleLanguageToggle = useCallback(
    (langKey: string) => {
      setSelectedLanguages((prev) => {
        const next = new Set(prev);
        if (next.has(langKey)) {
          next.delete(langKey);
        } else {
          next.add(langKey);
        }
        return next;
      });
      const langTools = languageToolMap.get(langKey);
      if (langTools && langTools.size > 0) {
        setExcludedTools((prev) => {
          const hasExcluded = [...langTools].some((tool) => prev.has(tool));
          if (!hasExcluded) return prev;
          const next = new Set(prev);
          for (const tool of langTools) {
            next.delete(tool);
          }
          return next;
        });
      }
    },
    [languageToolMap]
  );

  const handleToolToggle = useCallback(
    (toolName: string) => {
      setExcludedTools((prev) => {
        const next = new Set(prev);
        if (selectedTools.has(toolName)) {
          next.add(toolName);
        } else {
          next.delete(toolName);
        }
        return next;
      });
    },
    [selectedTools]
  );

  const handleScopeChange = useCallback(
    (value: string) => {
      setScanScope(value as ScanScope);
    },
    [setScanScope]
  );

  const scopeGridOptions = useMemo<SelectionGridOption[]>(
    () =>
      SCOPE_OPTIONS.map((option) => ({
        key: option.value,
        label: t(option.labelKey),
        iconElement: option.icon,
      })),
    [t]
  );

  const handleSelectAllLanguages = useCallback(() => {
    if (selectedLanguages.size === languageGridOptions.length) {
      setSelectedLanguages(new Set());
    } else {
      setSelectedLanguages(new Set(languageGridOptions.map((opt) => opt.key)));
    }
    setExcludedTools(new Set());
  }, [selectedLanguages.size, languageGridOptions]);

  const handleToggleComposition = useCallback(() => {
    setShowComposition((prev) => {
      if (!prev) detectComposition();
      return !prev;
    });
  }, [detectComposition]);

  const handleScan = useCallback(() => {
    if (selectedTools.size === 0) return;
    const availableSet = new Set(availableTools.map((tool) => tool.name));
    const toolsToRun = new Set(
      [...selectedTools].filter((toolName) => availableSet.has(toolName))
    );
    if (toolsToRun.size === 0) return;
    startWorkspaceScan(repoPath, store, scanScope, toolsToRun);
  }, [selectedTools, availableTools, repoPath, store, scanScope]);

  const handleStopScan = useCallback(() => {
    abortWorkspaceScan(store);
  }, [store]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PanelHeader
        icon={ScanSearch}
        title={t("status.lintScan")}
        background="transparent"
        actions={
          isScanning ? (
            <Button
              {...PANEL_HEADER_TOKENS.actionButton}
              icon={
                <Square
                  size={PANEL_HEADER_TOKENS.buttonIconSize}
                  strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
                />
              }
              onClick={handleStopScan}
              title={t("common:actions.stop")}
            />
          ) : undefined
        }
      />

      <div className="min-h-0 flex-1">
        <WizardStepLayout
          currentStep={0}
          totalSteps={0}
          hideStepIndicator
          noPadding
          footerLeft={
            isScanning ? (
              <span className="flex items-center gap-2 text-xs text-text-3">
                <Loader2
                  size={SPINNER_TOKENS.small}
                  className="animate-spin text-primary-6"
                />
                {t("status.scanning")}
              </span>
            ) : (
              <Button size="small" onClick={handleToggleComposition}>
                {showComposition
                  ? t("status.hideStats")
                  : t("status.showStats")}
              </Button>
            )
          }
          actions={
            isScanning ? (
              <Button
                size="small"
                onClick={handleStopScan}
                icon={<Square size={14} />}
              >
                {t("common:actions.stop")}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="small"
                onClick={handleScan}
                disabled={selectedTools.size === 0}
                icon={<Play size={14} />}
              >
                {selectedTools.size > 0
                  ? t("status.scanWithTools", { count: selectedTools.size })
                  : t("status.startScan")}
              </Button>
            )
          }
        >
          <div
            className={`${DETAIL_PANEL_TOKENS.contentPadding} pt-4 ${DETAIL_PANEL_TOKENS.contentPaddingBottom}`}
          >
            {showComposition && (
              <LanguageBar
                stats={compositionStats}
                loading={compositionLoading}
              />
            )}

            <FormField label={t("status.scanScope")} required className="mb-4">
              <SelectionGrid
                options={scopeGridOptions}
                selected={scanScope}
                onSelect={handleScopeChange}
                columnMinWidth={150}
              />
            </FormField>

            <FormField
              label={t("status.languagesMultiSelect")}
              required
              className="mb-4"
              labelSuffix={
                languageGridOptions.length > 0 ? (
                  <Button
                    variant="tertiary"
                    size="mini"
                    onClick={handleSelectAllLanguages}
                  >
                    {selectedLanguages.size === languageGridOptions.length
                      ? t("common:actions.clear")
                      : t("common:actions.selectAll")}
                  </Button>
                ) : undefined
              }
            >
              {languageGridOptions.length === 0 ? (
                <Placeholder
                  variant="empty"
                  title={t("placeholders.noLintToolsInstalled")}
                />
              ) : (
                <SelectionGrid
                  multiSelect
                  options={languageGridOptions}
                  selected={selectedLanguages}
                  onToggle={handleLanguageToggle}
                  columnMinWidth={150}
                />
              )}
            </FormField>

            {toolGridOptions.length > 0 && (
              <FormField
                label={t("status.toolsMultiSelect")}
                required
                className="mb-4"
                labelSuffix={
                  excludedTools.size > 0 ? (
                    <Button
                      variant="tertiary"
                      size="mini"
                      onClick={() => setExcludedTools(new Set())}
                    >
                      {t("common:actions.clear")}
                    </Button>
                  ) : undefined
                }
              >
                <SelectionGrid
                  multiSelect
                  options={toolGridOptions}
                  selected={selectedTools}
                  onToggle={handleToolToggle}
                  columnMinWidth={150}
                />
              </FormField>
            )}

            {isScanning && <ScanProgressSection scanProgress={scanProgress} />}
          </div>
        </WizardStepLayout>
      </div>
    </div>
  );
});

LintScanContent.displayName = "LintScanContent";

export default LintScanContent;
export type { LintScanContentProps } from "./types";
