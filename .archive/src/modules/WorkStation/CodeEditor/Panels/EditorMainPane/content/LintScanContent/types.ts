import type { ReactNode } from "react";

import type { ScanScope } from "@src/store/workstation/codeEditor/diagnostics";

export interface LintScanContentProps {
  repoPath: string;
}

export interface LanguageStat {
  language: string;
  extensions: string[];
  fileCount: number;
  color: string;
  iconFile: string;
}

export interface LanguageDef {
  language: string;
  extensions: string[];
  color: string;
  iconFile: string;
  /** Keys matching LintToolInfo.languages from the backend */
  toolLanguageKeys: string[];
}

export interface ScopeOption {
  value: ScanScope;
  labelKey: string;
  icon?: ReactNode;
}
