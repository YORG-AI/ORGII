import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import {
  BENCHMARK_EVALUATION_MODE,
  BENCHMARK_KIND,
  BENCHMARK_RUN_TYPE,
  type BenchmarkAgentBatchStatus,
  type BenchmarkEvaluationMode,
  type BenchmarkKind,
  type BenchmarkPreflightResult,
  type BenchmarkRunPlan,
  type BenchmarkRunStatus,
  type BenchmarkRunType,
  type BenchmarkTaskDetail,
  type BenchmarkTaskIndexRow,
} from "@src/api/tauri/benchmark";

const BENCHMARK_SOURCE_PATH_STORAGE_KEY = "orgii:benchmarkSourcePath";
const BENCHMARK_WORKING_DIRECTORY_STORAGE_KEY =
  "orgii:benchmarkWorkingDirectory";

export const DEFAULT_BENCHMARK_SOURCE_PATH = "";
export const DEFAULT_BENCHMARK_WORKING_DIRECTORY = "";
export const DEFAULT_SWE_BENCH_TARGET_REPO_PATH = "";

export const BENCHMARK_TASK_LIST_LIMIT = 250;
export const DEFAULT_BENCHMARK_BATCH_CONCURRENCY = 2;

export const benchmarkKindAtom = atom<BenchmarkKind>(
  BENCHMARK_KIND.SWE_BENCH_PRO
);
export const benchmarkSourcePathAtom = atomWithStorage(
  BENCHMARK_SOURCE_PATH_STORAGE_KEY,
  DEFAULT_BENCHMARK_SOURCE_PATH
);
export const benchmarkWorkingDirectoryAtom = atomWithStorage(
  BENCHMARK_WORKING_DIRECTORY_STORAGE_KEY,
  DEFAULT_BENCHMARK_WORKING_DIRECTORY
);
export const benchmarkEvaluationModeAtom = atom<BenchmarkEvaluationMode>(
  BENCHMARK_EVALUATION_MODE.LOCAL_DOCKER
);
export const benchmarkTargetRepoPathAtom = atom(
  DEFAULT_SWE_BENCH_TARGET_REPO_PATH
);
export const benchmarkTasksAtom = atom<BenchmarkTaskIndexRow[]>([]);
export const benchmarkSelectedTaskIdAtom = atom<string | null>(null);
export const benchmarkSelectedTaskAtom = atom<BenchmarkTaskDetail | null>(null);
export const benchmarkTasksLoadingAtom = atom(false);
export const benchmarkTaskDetailLoadingAtom = atom(false);
export const benchmarkErrorAtom = atom<string | null>(null);
export const benchmarkExpandedReposAtom = atom<Record<string, boolean>>({});
export const benchmarkPatchTextAtom = atom("");
export const benchmarkRunPlanAtom = atom<BenchmarkRunPlan | null>(null);
export const benchmarkRunStatusAtom = atom<BenchmarkRunStatus | null>(null);
export const benchmarkPreflightAtom = atom<BenchmarkPreflightResult | null>(
  null
);
export const benchmarkRunLoadingAtom = atom(false);
export const benchmarkRunErrorAtom = atom<string | null>(null);
export const benchmarkRunTypeAtom = atom<BenchmarkRunType>(
  BENCHMARK_RUN_TYPE.SINGLE
);
export const benchmarkBatchSelectedTaskIdsAtom = atom<string[]>([]);
export const benchmarkBatchConcurrencyAtom = atom(
  DEFAULT_BENCHMARK_BATCH_CONCURRENCY
);
export const benchmarkAgentBatchStatusAtom =
  atom<BenchmarkAgentBatchStatus | null>(null);
export const benchmarkAgentBatchLoadingAtom = atom(false);
export const benchmarkAgentBatchErrorAtom = atom<string | null>(null);
export const benchmarkActiveBatchIdAtom = atom<string | null>(null);
export const benchmarkActiveBatchTaskIdAtom = atom<string | null>(null);
