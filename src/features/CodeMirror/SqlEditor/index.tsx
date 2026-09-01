/**
 * SqlQueryEditor Component
 *
 * SQL query editor with CodeMirror 6 and syntax highlighting.
 * Features:
 * - SQL syntax highlighting via @codemirror/lang-sql
 * - Table/column autocomplete
 * - Format SQL button
 * - Execute with Ctrl+Enter
 * - Query history dropdown
 */
import { SQLite, sql } from "@codemirror/lang-sql";
import { EditorView, keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import React, { memo, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TableInfo } from "@src/engines/DatabaseCore";
import { createLogger } from "@src/hooks/logger";
import {
  HugeiconsIcon,
  PlayIcon,
  TextAlignLeftIcon,
  WorkHistoryIcon,
} from "@src/icons";

import {
  BASIC_SETUP_SQL_CONFIG,
  codeMirrorCspNonceExtension,
  createCodeMirrorTheme,
  editorHistoryKeymapExtension,
  getCodeMirrorTheme,
} from "../config";
import "./index.scss";

const log = createLogger("SqlEditor");

// ============================================
// Types
// ============================================

interface SqlQueryEditorProps {
  /** Default SQL query */
  defaultValue?: string;
  /** Callback when query is executed */
  onExecute: (sql: string) => void;
  /** Tables for autocomplete */
  tables?: TableInfo[];
  /** Loading state (query executing) */
  loading?: boolean;
  /** Query history items */
  history?: Array<{ sql: string; timestamp: number }>;
  /** Callback when history item is selected */
  onHistorySelect?: (sql: string) => void;
}

// ============================================
// Component
// ============================================

export const SqlQueryEditor: React.FC<SqlQueryEditorProps> = memo(
  ({
    defaultValue = "",
    onExecute,
    tables = [],
    loading = false,
    history = [],
    onHistorySelect,
  }) => {
    const { t } = useTranslation("common");
    const [value, setValue] = useState(defaultValue);
    const [showHistory, setShowHistory] = useState(false);
    const historyRef = useRef<HTMLDivElement>(null);

    // Build autocomplete schema from tables
    const schema = useMemo(() => {
      const tableSchema: Record<string, string[]> = {};
      tables.forEach((table) => {
        // For now, just add table names without columns
        // Column autocomplete would require fetching schema for each table
        tableSchema[table.name] = [];
      });
      return tableSchema;
    }, [tables]);

    // Handle execute
    const handleExecute = useCallback(() => {
      if (value.trim() && !loading) {
        onExecute(value.trim());
      }
    }, [value, loading, onExecute]);

    // Handle format. `sql-formatter` (~280 KB) is loaded on first use so the
    // SQL editor chunk does not carry it for users who never press Format.
    const handleFormat = useCallback(() => {
      const source = value;
      void import(/* webpackChunkName: "sql-formatter" */ "sql-formatter")
        .then(({ format }) =>
          format(source, {
            language: "sqlite",
            tabWidth: 2,
            keywordCase: "upper",
          })
        )
        .then((formatted) => {
          // Formatting is lazy-loaded on first use. Only apply its result if
          // the editor still contains the source captured for this request;
          // edits and history selections made while the chunk loads win.
          setValue((current) => (current === source ? formatted : current));
        })
        .catch(() => {
          // If formatting fails, keep original
          log.warn("SQL formatting failed");
        });
    }, [value]);

    // Handle history selection
    const handleHistoryClick = useCallback(
      (sqlQuery: string) => {
        setValue(sqlQuery);
        setShowHistory(false);
        onHistorySelect?.(sqlQuery);
      },
      [setValue, onHistorySelect]
    );

    // Build extensions
    const extensions = useMemo(() => {
      const exts = [
        codeMirrorCspNonceExtension,
        editorHistoryKeymapExtension(),
        // SQL language with SQLite dialect and table autocomplete
        sql({
          dialect: SQLite,
          schema,
          upperCaseKeywords: true,
        }),
        // Custom theme
        createCodeMirrorTheme(),
        // Execute on Ctrl+Enter
        keymap.of([
          {
            key: "Ctrl-Enter",
            mac: "Cmd-Enter",
            run: () => {
              handleExecute();
              return true;
            },
          },
        ]),
        // Line wrapping for long queries
        EditorView.lineWrapping,
      ];
      return exts;
    }, [schema, handleExecute]);

    const theme = getCodeMirrorTheme();

    return (
      <div className="sql-query-editor">
        {/* Toolbar */}
        <div className="sql-query-editor__toolbar">
          <div className="sql-query-editor__toolbar-left">
            {/* Format button */}
            <button
              onClick={handleFormat}
              title={t("tooltips.formatSql")}
              className="sql-query-editor__btn"
            >
              <HugeiconsIcon
                icon={TextAlignLeftIcon}
                data-icon="align-left"
                size={14}
                strokeWidth={1.75}
              />
              <span>{t("sqlEditor.format")}</span>
            </button>

            {/* History dropdown */}
            {history.length > 0 && (
              <div className="sql-query-editor__history-container">
                <button
                  onClick={() => setShowHistory(!showHistory)}
                  title={t("tooltips.queryHistory")}
                  className="sql-query-editor__btn"
                >
                  <HugeiconsIcon
                    icon={WorkHistoryIcon}
                    data-icon="history"
                    size={14}
                    strokeWidth={1.75}
                  />
                  <span>{t("labels.history")}</span>
                </button>

                {showHistory && (
                  <div
                    ref={historyRef}
                    className="sql-query-editor__history-dropdown"
                  >
                    {history.slice(0, 10).map((item, index) => (
                      <button
                        key={index}
                        onClick={() => handleHistoryClick(item.sql)}
                        className="sql-query-editor__history-item"
                      >
                        <span className="sql-query-editor__history-sql">
                          {item.sql.slice(0, 60)}
                          {item.sql.length > 60 ? "..." : ""}
                        </span>
                        <span className="sql-query-editor__history-time">
                          {new Date(item.timestamp).toLocaleTimeString()}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="sql-query-editor__toolbar-right">
            {/* Execute button */}
            <button
              onClick={handleExecute}
              disabled={loading || !value.trim()}
              title={t("tooltips.executeQuery")}
              className="sql-query-editor__btn sql-query-editor__btn--primary"
            >
              <HugeiconsIcon
                icon={PlayIcon}
                data-icon="play"
                size={14}
                strokeWidth={1.75}
              />
              <span>{loading ? t("status.running") : t("actions.run")}</span>
            </button>
          </div>
        </div>

        {/* Editor */}
        <div className="sql-query-editor__editor">
          <CodeMirror
            value={value}
            onChange={setValue}
            height="100%"
            theme={theme}
            extensions={extensions}
            placeholder={t("sqlEditor.placeholder")}
            basicSetup={BASIC_SETUP_SQL_CONFIG}
          />
        </div>

        {/* Keyboard hint */}
        <div className="absolute bottom-2 right-3 flex items-center gap-1 text-xs text-text-4">
          <span>{t("sqlEditor.press")}</span>
          <kbd className="rounded bg-fill-2 px-1.5 py-0.5">⌘</kbd>
          <kbd className="rounded bg-fill-2 px-1.5 py-0.5">↵</kbd>
          <span>{t("sqlEditor.toRun")}</span>
        </div>
      </div>
    );
  }
);

SqlQueryEditor.displayName = "SqlQueryEditor";

// Re-export QueryResults for consumers who import from SqlEditor
export { QueryResults } from "./QueryResults";
export type { QueryResultsProps } from "./QueryResults";

export default SqlQueryEditor;
