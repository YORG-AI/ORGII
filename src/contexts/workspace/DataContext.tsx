/**
 * Data Context - Data-related state
 * Contains files, diffs, work logs, and other data state
 */
import React, {
  ReactNode,
  createContext,
  useContext,
  useMemo,
  useState,
} from "react";

import { FileContentItem } from "@src/types/editor/fileContent";
import {
  FileEdits,
  GithubIssue,
  WpApiKeyList,
  WpSnapShot,
  WpWebItem,
} from "@src/types/session/steps";

// ============================================
// Data Context Types
// ============================================

export interface DiffItem {
  breadcrumbData: string[];
  oldCode: string;
  newCode: string;
  regeCode?: string;
  SSECode?: string;
  path: string;
  language?: string;
  range: string;
  sessionId: string;
}

export interface WorkStatusItem {
  id: string;
  status: string;
  message?: string;
  timestamp?: string;
}

export interface SessionRoundItem {
  id: string;
  roundNumber: number;
  content: string;
  status?: string;
  createdAt?: string;
}

export interface SummaryItem {
  id: string;
  title: string;
  content: string;
  createdAt?: string;
}

export interface CommitHistoryItem {
  id: string;
  hash: string;
  message: string;
  author?: string;
  date?: string;
}

export interface DataContextType {
  // Diff related
  diffList: DiffItem[];
  setDiffList: React.Dispatch<React.SetStateAction<DiffItem[]>>;
  diffListCache: Record<string, DiffItem[]>;
  setDiffListCache: React.Dispatch<
    React.SetStateAction<Record<string, DiffItem[]>>
  >;
  resultList: string[];
  setResultList: React.Dispatch<React.SetStateAction<string[]>>;

  // File related
  focusFileSnippet: Record<string, Array<string>>;
  setFocusFileSnippet: React.Dispatch<
    React.SetStateAction<Record<string, Array<string>>>
  >;
  contextExamFiles: string[];
  setContextExamFiles: React.Dispatch<React.SetStateAction<string[]>>;
  focusFileContent: FileContentItem[];
  setFocusFileContent: React.Dispatch<React.SetStateAction<FileContentItem[]>>;
  createFocusFileList: string[];
  setCreateFocusFileList: React.Dispatch<React.SetStateAction<string[]>>;
  localContextList: FileContentItem[];
  setLocalContextList: React.Dispatch<React.SetStateAction<FileContentItem[]>>;
  fileEdits: FileEdits;
  setFileEdits: React.Dispatch<React.SetStateAction<FileEdits>>;

  // Work logs
  workStatusList: WorkStatusItem[];
  setWorkStatusList: React.Dispatch<React.SetStateAction<WorkStatusItem[]>>;

  // Plan related
  generatePlan: Record<string, Record<string, string>>;
  setGeneratePlan: React.Dispatch<
    React.SetStateAction<Record<string, Record<string, string>>>
  >;
  finalActions: Record<string, string>;
  setFinalActions: React.Dispatch<React.SetStateAction<Record<string, string>>>;

  // Session Round
  sessionRoundList: SessionRoundItem[];
  setSessionRoundList: React.Dispatch<React.SetStateAction<SessionRoundItem[]>>;
  sessRoundActiveKeys: string[];
  setSessRoundActiveKeys: React.Dispatch<React.SetStateAction<string[]>>;

  // Summary and history
  summaryList: SummaryItem[];
  setSummaryList: React.Dispatch<React.SetStateAction<SummaryItem[]>>;
  commitHistoryList: CommitHistoryItem[];
  setCommitHistoryList: React.Dispatch<
    React.SetStateAction<CommitHistoryItem[]>
  >;

  // Language and regex
  languageList: Record<string, string>;
  setLanguageList: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  regeList: Record<string, string[]>;
  setRegeList: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  regePrepare: boolean;
  setRegePrepare: React.Dispatch<React.SetStateAction<boolean>>;

  // External resources
  webList: WpWebItem[];
  setWebList: React.Dispatch<React.SetStateAction<WpWebItem[]>>;
  keyList: WpApiKeyList;
  setKeyList: React.Dispatch<React.SetStateAction<WpApiKeyList>>;
  gitIssueList: GithubIssue[];
  setGitIssueList: React.Dispatch<React.SetStateAction<GithubIssue[]>>;
  snapShotList: WpSnapShot[];
  setSnapShotList: React.Dispatch<React.SetStateAction<WpSnapShot[]>>;

  // Other
  addFilesNum: number;
  setAddFilesNum: React.Dispatch<React.SetStateAction<number>>;
}

const DataContext = createContext<DataContextType | undefined>(undefined);

export const DataProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [diffList, setDiffList] = useState<DiffItem[]>([]);
  const [diffListCache, setDiffListCache] = useState<
    Record<string, DiffItem[]>
  >({});
  const [resultList, setResultList] = useState<string[]>([]);
  const [focusFileSnippet, setFocusFileSnippet] = useState<
    Record<string, Array<string>>
  >({});
  const [contextExamFiles, setContextExamFiles] = useState<string[]>([]);
  const [focusFileContent, setFocusFileContent] = useState<FileContentItem[]>(
    []
  );
  const [createFocusFileList, setCreateFocusFileList] = useState<string[]>([]);
  const [localContextList, setLocalContextList] = useState<FileContentItem[]>(
    []
  );
  const [fileEdits, setFileEdits] = useState<FileEdits>({
    added: 0,
    deleted: 0,
    modified: 0,
  });
  const [workStatusList, setWorkStatusList] = useState<WorkStatusItem[]>([]);
  const [generatePlan, setGeneratePlan] = useState<
    Record<string, Record<string, string>>
  >({});
  const [finalActions, setFinalActions] = useState<Record<string, string>>({});
  const [sessionRoundList, setSessionRoundList] = useState<SessionRoundItem[]>(
    []
  );
  const [sessRoundActiveKeys, setSessRoundActiveKeys] = useState<string[]>([
    "1",
  ]);
  const [summaryList, setSummaryList] = useState<SummaryItem[]>([]);
  const [commitHistoryList, setCommitHistoryList] = useState<
    CommitHistoryItem[]
  >([]);
  const [languageList, setLanguageList] = useState<Record<string, string>>({});
  const [regeList, setRegeList] = useState<Record<string, string[]>>({});
  const [regePrepare, setRegePrepare] = useState<boolean>(false);
  const [webList, setWebList] = useState<WpWebItem[]>([]);
  const [keyList, setKeyList] = useState<WpApiKeyList>({ cur: [], origin: [] });
  const [gitIssueList, setGitIssueList] = useState<GithubIssue[]>([]);
  const [snapShotList, setSnapShotList] = useState<WpSnapShot[]>([]);
  const [addFilesNum, setAddFilesNum] = useState<number>(0);

  const value = useMemo(
    () => ({
      diffList,
      setDiffList,
      diffListCache,
      setDiffListCache,
      resultList,
      setResultList,
      focusFileSnippet,
      setFocusFileSnippet,
      contextExamFiles,
      setContextExamFiles,
      focusFileContent,
      setFocusFileContent,
      createFocusFileList,
      setCreateFocusFileList,
      localContextList,
      setLocalContextList,
      fileEdits,
      setFileEdits,
      workStatusList,
      setWorkStatusList,
      generatePlan,
      setGeneratePlan,
      finalActions,
      setFinalActions,
      sessionRoundList,
      setSessionRoundList,
      sessRoundActiveKeys,
      setSessRoundActiveKeys,
      summaryList,
      setSummaryList,
      commitHistoryList,
      setCommitHistoryList,
      languageList,
      setLanguageList,
      regeList,
      setRegeList,
      regePrepare,
      setRegePrepare,
      webList,
      setWebList,
      keyList,
      setKeyList,
      gitIssueList,
      setGitIssueList,
      snapShotList,
      setSnapShotList,
      addFilesNum,
      setAddFilesNum,
    }),
    [
      diffList,
      diffListCache,
      resultList,
      focusFileSnippet,
      contextExamFiles,
      focusFileContent,
      createFocusFileList,
      localContextList,
      fileEdits,
      workStatusList,
      generatePlan,
      finalActions,
      sessionRoundList,
      sessRoundActiveKeys,
      summaryList,
      commitHistoryList,
      languageList,
      regeList,
      regePrepare,
      webList,
      keyList,
      gitIssueList,
      snapShotList,
      addFilesNum,
    ]
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
};

export const useDataContext = () => {
  const context = useContext(DataContext);
  if (!context) {
    throw new Error("useDataContext must be used within a DataProvider");
  }
  return context;
};

export { DataContext };
