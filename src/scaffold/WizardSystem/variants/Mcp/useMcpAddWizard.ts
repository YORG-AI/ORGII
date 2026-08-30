/**
 * State and handlers for McpAddWizard.
 * Extracted to keep the component under the UI line limit.
 */
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import type { McpConfigScope } from "@src/api/tauri/rpc/schemas/mcp";
import {
  ComputerTerminal01Icon,
  FlashIcon,
  type IconSvgElement,
  InternetIcon,
} from "@src/icons";
import type {
  McpServerConfig,
  McpTestResult,
} from "@src/modules/MainApp/AgentOrgs/config/mcp/useMcpServers";

import { type KvRow, kvRowsFromRecord, kvRowsToRecord } from "./KvTableEditor";

// ============================================================================
// Shared constants
// ============================================================================

export type McpTransportType = McpServerConfig["type"];

export const EMPTY_CONFIG: McpServerConfig = {
  type: "stdio",
  command: "",
  args: [],
  disabled: false,
  timeout: 30,
};

// ============================================================================
// Shell-style argument parsing (shared with wizard)
// ============================================================================

/**
 * Tokenize a shell-style argument string into an array of args.
 * Supports single quotes, double quotes, and backslash escapes (outside quotes
 * and inside double quotes). Mirrors how POSIX shells split `argv[1..]`.
 *
 * Examples:
 *   parseArgs(`-y @scope/pkg`)              → ["-y", "@scope/pkg"]
 *   parseArgs(`--root "/Users/me/My Docs"`) → ["--root", "/Users/me/My Docs"]
 *   parseArgs(`--name 'foo bar'`)           → ["--name", "foo bar"]
 */
export function parseArgs(input: string): string[] {
  const result: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let pending = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (!inSingle && !inDouble && ch === "\\" && i + 1 < input.length) {
      current += input[++i];
      pending = true;
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      pending = true;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      pending = true;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (pending || current.length > 0) {
        result.push(current);
        current = "";
        pending = false;
      }
      continue;
    }
    current += ch;
    pending = true;
  }
  if (pending || current.length > 0) result.push(current);
  return result;
}

/**
 * Re-quote an arg list back into a single line. Args containing whitespace or
 * shell metacharacters are wrapped in double quotes (with embedded `"` escaped).
 * Inverse of {@link parseArgs} for round-tripping the textarea value.
 */
export function formatArgs(args: readonly string[]): string {
  return args
    .map((arg) => {
      if (arg === "") return '""';
      if (/[\s"'\\]/.test(arg)) {
        return `"${arg.replace(/(["\\])/g, "\\$1")}"`;
      }
      return arg;
    })
    .join(" ");
}

// ============================================================================
// Hook
// ============================================================================

export interface UseMcpAddWizardOptions {
  onSave: (
    name: string,
    config: McpServerConfig,
    scope: McpConfigScope
  ) => Promise<void>;
  onTest: (name: string, config: McpServerConfig) => Promise<McpTestResult>;
  onCancel: () => void;
  editName?: string;
  editConfig?: McpServerConfig;
  initialScope?: McpConfigScope;
}

export interface UseMcpAddWizardReturn {
  serverName: string;
  setServerName: (name: string) => void;
  config: McpServerConfig;
  setConfig: Dispatch<SetStateAction<McpServerConfig>>;
  transportType: McpTransportType;
  setTransportType: (type: McpTransportType) => void;
  scope: McpConfigScope;
  setScope: (scope: McpConfigScope) => void;
  nameError: string | null;
  envRows: KvRow[];
  setEnvRows: Dispatch<SetStateAction<KvRow[]>>;
  headerRows: KvRow[];
  setHeaderRows: Dispatch<SetStateAction<KvRow[]>>;
  testResult: McpTestResult | null;
  testing: boolean;
  saving: boolean;
  error: string | null;
  canSave: string | 0 | null | false;
  transportOptions: Array<{
    key: McpTransportType;
    label: string;
    icon: IconSvgElement;
  }>;
  wizardTitle: string;
  updateEnvRow: (id: string, field: "key" | "value", val: string) => void;
  removeEnvRow: (id: string) => void;
  addEnvRow: () => void;
  updateHeaderRow: (id: string, field: "key" | "value", val: string) => void;
  removeHeaderRow: (id: string) => void;
  addHeaderRow: () => void;
  handleTest: () => Promise<void>;
  handleSave: () => Promise<void>;
}

export function useMcpAddWizard({
  onSave,
  onTest,
  onCancel,
  editName,
  editConfig,
  initialScope,
}: UseMcpAddWizardOptions): UseMcpAddWizardReturn {
  const { t } = useTranslation("integrations");

  const [serverName, setServerName] = useState(editName ?? "");
  const [config, setConfig] = useState<McpServerConfig>(
    editConfig ?? { ...EMPTY_CONFIG }
  );
  const [transportType, setTransportType] = useState<McpTransportType>(
    editConfig?.type ?? "stdio"
  );
  const [scope, setScope] = useState<McpConfigScope>(initialScope ?? "global");
  const [nameError, setNameError] = useState<string | null>(null);

  const [envRows, setEnvRows] = useState<KvRow[]>(() => {
    const rows = kvRowsFromRecord(editConfig?.env ?? {});
    return rows.length > 0
      ? rows
      : [{ id: crypto.randomUUID(), key: "", value: "" }];
  });
  const [headerRows, setHeaderRows] = useState<KvRow[]>(() => {
    const rows = kvRowsFromRecord(editConfig?.headers ?? {});
    return rows.length > 0
      ? rows
      : [{ id: crypto.randomUUID(), key: "", value: "" }];
  });

  const [testResult, setTestResult] = useState<McpTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const transportOptions = useMemo(
    () => [
      {
        key: "stdio" as const,
        label: t("mcp.transportStdio"),
        icon: ComputerTerminal01Icon,
      },
      {
        key: "sse" as const,
        label: t("mcp.transportSse"),
        icon: FlashIcon,
      },
      {
        key: "streamableHttp" as const,
        label: t("mcp.transportHttp"),
        icon: InternetIcon,
      },
    ],
    [t]
  );

  const canSave =
    serverName.trim() &&
    (transportType === "stdio"
      ? (config.command ?? "").trim()
      : (config.url ?? "").trim());

  const updateEnvRow = useCallback(
    (id: string, field: "key" | "value", val: string) => {
      setEnvRows((prev) => {
        const next = prev.map((row) =>
          row.id === id ? { ...row, [field]: val } : row
        );
        setConfig((cfg) => ({
          ...cfg,
          env:
            Object.keys(kvRowsToRecord(next)).length > 0
              ? kvRowsToRecord(next)
              : undefined,
        }));
        return next;
      });
    },
    []
  );

  const removeEnvRow = useCallback((id: string) => {
    setEnvRows((prev) => {
      const next = prev.filter((row) => row.id !== id);
      setConfig((cfg) => ({
        ...cfg,
        env:
          Object.keys(kvRowsToRecord(next)).length > 0
            ? kvRowsToRecord(next)
            : undefined,
      }));
      return next;
    });
  }, []);

  const addEnvRow = useCallback(() => {
    setEnvRows((prev) => [
      ...prev,
      { id: crypto.randomUUID(), key: "", value: "" },
    ]);
  }, []);

  const updateHeaderRow = useCallback(
    (id: string, field: "key" | "value", val: string) => {
      setHeaderRows((prev) => {
        const next = prev.map((row) =>
          row.id === id ? { ...row, [field]: val } : row
        );
        setConfig((cfg) => ({
          ...cfg,
          headers:
            Object.keys(kvRowsToRecord(next)).length > 0
              ? kvRowsToRecord(next)
              : undefined,
        }));
        return next;
      });
    },
    []
  );

  const removeHeaderRow = useCallback((id: string) => {
    setHeaderRows((prev) => {
      const next = prev.filter((row) => row.id !== id);
      setConfig((cfg) => ({
        ...cfg,
        headers:
          Object.keys(kvRowsToRecord(next)).length > 0
            ? kvRowsToRecord(next)
            : undefined,
      }));
      return next;
    });
  }, []);

  const addHeaderRow = useCallback(() => {
    setHeaderRows((prev) => [
      ...prev,
      { id: crypto.randomUUID(), key: "", value: "" },
    ]);
  }, []);

  const handleTest = useCallback(async () => {
    if (!serverName.trim()) {
      setNameError(t("mcp.nameRequired"));
      return;
    }
    setNameError(null);
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const result = await onTest(serverName, config);
      setTestResult(result);
    } catch (err) {
      setTestResult({
        success: false,
        toolCount: 0,
        tools: [],
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }, [serverName, config, onTest, t]);

  const handleSave = useCallback(async () => {
    if (!serverName.trim()) {
      setNameError(t("mcp.nameRequired"));
      return;
    }
    setNameError(null);
    setSaving(true);
    setError(null);
    try {
      await onSave(serverName, config, scope);
      onCancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [serverName, config, scope, onSave, onCancel, t]);

  const wizardTitle = editName ? t("mcp.editServer") : t("mcp.addServer");

  return {
    serverName,
    setServerName,
    config,
    setConfig,
    transportType,
    setTransportType,
    scope,
    setScope,
    nameError,
    envRows,
    setEnvRows,
    headerRows,
    setHeaderRows,
    testResult,
    testing,
    saving,
    error,
    canSave,
    transportOptions,
    wizardTitle,
    updateEnvRow,
    removeEnvRow,
    addEnvRow,
    updateHeaderRow,
    removeHeaderRow,
    addHeaderRow,
    handleTest,
    handleSave,
  };
}
