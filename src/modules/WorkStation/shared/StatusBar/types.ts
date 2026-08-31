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

export interface EditorStatusBarProps {
  cursor: CursorPosition | null;
  filePath?: string;
  totalLines?: number;
  commitInfo?: CommitInfo | null;
  onRepoClick?: () => void;
  onBranchClick?: () => void;
  onWorktreeClick?: () => void;
  className?: string;
}
