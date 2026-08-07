export interface CursorPosition {
  line: number;
  column: number;
  selectedChars?: number;
  selectedLines?: number;
}

export interface CommitInfo {
  message: string;
  author: string;
  time: string;
  shortSha: string;
}

export interface LspStatus {
  connected: boolean;
  language?: string;
}

export interface EditorStatusBarProps {
  cursor: CursorPosition | null;
  filePath?: string;
  totalLines?: number;
  repoName?: string;
  branchName?: string;
  commitInfo?: CommitInfo | null;
  lspStatus?: LspStatus;
  onRepoClick?: () => void;
  onBranchClick?: () => void;
  onWorktreeClick?: () => void;
  className?: string;
}

export type DiagnosticUiStatus =
  | "active"
  | "initializing"
  | "failed"
  | "unknown";

export type PanelRow =
  | {
      kind: "pair";
      key: string;
      left: string;
      right: string;
      uiStatus: DiagnosticUiStatus;
    }
  | { kind: "empty"; key: string; message: string };
