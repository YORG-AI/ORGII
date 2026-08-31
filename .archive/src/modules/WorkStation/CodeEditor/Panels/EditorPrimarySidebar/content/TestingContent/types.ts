/**
 * TestingContent Types
 */
import type { TestItem, TestStatus } from "@src/types/testing/types";

export interface TestTreeNode {
  /** Unique identifier */
  path: string;
  /** Display name */
  name: string;
  /** Whether it's a folder (has children) */
  isFolder: boolean;
  /** Whether folder is expanded */
  expanded: boolean;
  /** Original test item data */
  testItem: TestItem;
  /** Test status */
  status?: TestStatus;
  /** Duration in ms */
  duration?: number;
}

export interface FlattenedTestNode {
  node: TestTreeNode;
  depth: number;
}

export interface TestingContentProps {
  repoPath: string;
  isActive?: boolean;
  onFileClick?: (filePath: string) => void;
  showFilter?: boolean;
}

export interface TestTreeRowProps {
  node: TestTreeNode;
  depth: number;
  onRunTest: (testId: string) => void;
  onToggle: (path: string) => void;
  onFileClick?: (filePath: string) => void;
}
