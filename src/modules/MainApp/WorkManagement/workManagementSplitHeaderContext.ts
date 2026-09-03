import { createContext, useContext } from "react";
import type { ReactNode } from "react";

export interface WorkManagementSplitHeaderContextValue {
  /** Icon-only dataset switch for a compact, split list header. */
  splitDatasetControl: ReactNode;
  /** Readable dataset switch for a full-width surface header. */
  surfaceDatasetControl?: ReactNode;
}

const DEFAULT_WORK_MANAGEMENT_SPLIT_HEADER_CONTEXT: WorkManagementSplitHeaderContextValue =
  {
    splitDatasetControl: null,
    surfaceDatasetControl: null,
  };

export const WorkManagementSplitHeaderContext =
  createContext<WorkManagementSplitHeaderContextValue>(
    DEFAULT_WORK_MANAGEMENT_SPLIT_HEADER_CONTEXT
  );

export function useWorkManagementSplitHeader(): WorkManagementSplitHeaderContextValue {
  return useContext(WorkManagementSplitHeaderContext);
}
