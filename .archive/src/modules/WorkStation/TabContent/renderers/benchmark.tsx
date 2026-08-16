import { useSetAtom } from "jotai";
import React, { memo, useEffect } from "react";

import { BenchmarkPanel } from "@src/features/BenchmarkPanel";
import {
  benchmarkActiveBatchIdAtom,
  benchmarkActiveBatchTaskIdAtom,
} from "@src/store/benchmark";

import type { UnifiedTabContentProps } from "../types";

const BenchmarkTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab, isActive }) => {
    const setActiveBatchId = useSetAtom(benchmarkActiveBatchIdAtom);
    const setActiveBatchTaskId = useSetAtom(benchmarkActiveBatchTaskIdAtom);
    const batchId =
      typeof tab.data.batchId === "string" ? tab.data.batchId : null;
    const selectedTaskId =
      typeof tab.data.selectedTaskId === "string"
        ? tab.data.selectedTaskId
        : null;

    useEffect(() => {
      setActiveBatchId(batchId);
      setActiveBatchTaskId(selectedTaskId);
    }, [batchId, selectedTaskId, setActiveBatchId, setActiveBatchTaskId]);

    return (
      <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <BenchmarkPanel surface="taskInfo" publishHeader={isActive} />
      </div>
    );
  }
);

BenchmarkTabRenderer.displayName = "BenchmarkTabRenderer";

export default BenchmarkTabRenderer;
