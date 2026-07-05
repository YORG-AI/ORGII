import { useSetAtom } from "jotai";
import { ExternalLink } from "lucide-react";
import React, { useCallback, useEffect, useMemo } from "react";

import {
  type CliLaunchArgsValidationResult,
  type CliLaunchSurface,
  getCliAgentCommandLabel,
  getCliAgentDefaultLaunchArgs,
  getCliAgentDocsUrl,
  validateCliLaunchArgs,
} from "@src/features/SessionCreator/cliAgentLaunchConfig";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";
import { requestNewBrowserSessionAtom } from "@src/store/workstation/workstationTabBarAtoms";

export interface CliLaunchArgumentsControlProps {
  advancedConfig: AdvancedConfig;
  onAdvancedConfigChange: (config: AdvancedConfig) => void;
  surface: CliLaunchSurface;
  value?: string;
  commandLabel?: string;
  onValueChange?: (value: string) => void;
  onValidationChange?: (result: CliLaunchArgsValidationResult) => void;
  className?: string;
}

const CliLaunchArgumentsControl: React.FC<CliLaunchArgumentsControlProps> = ({
  advancedConfig,
  onAdvancedConfigChange,
  surface,
  value,
  commandLabel,
  onValueChange,
  onValidationChange,
  className = "",
}) => {
  const requestNewBrowserSession = useSetAtom(requestNewBrowserSessionAtom);
  const cliAgentType = advancedConfig.cliAgentType;
  const docsUrl = getCliAgentDocsUrl(cliAgentType);
  const launchArgsValue = useMemo(
    () =>
      value ??
      (cliAgentType
        ? (advancedConfig.launchArgs ??
          getCliAgentDefaultLaunchArgs(cliAgentType, surface))
        : ""),
    [advancedConfig.launchArgs, cliAgentType, surface, value]
  );
  const resolvedCommandLabel =
    commandLabel ?? getCliAgentCommandLabel(cliAgentType, surface);
  const validation = useMemo(
    () => validateCliLaunchArgs(cliAgentType, surface, launchArgsValue),
    [cliAgentType, launchArgsValue, surface]
  );

  useEffect(() => {
    onValidationChange?.(validation);
  }, [onValidationChange, validation]);

  const handleLaunchArgsChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const nextValue = event.target.value;
      if (onValueChange) {
        onValueChange(nextValue);
        return;
      }
      onAdvancedConfigChange({
        ...advancedConfig,
        launchArgs: nextValue,
      });
    },
    [advancedConfig, onAdvancedConfigChange, onValueChange]
  );

  const handleOpenDocs = useCallback(() => {
    if (!docsUrl) return;
    requestNewBrowserSession({ url: docsUrl });
  }, [docsUrl, requestNewBrowserSession]);

  if (!cliAgentType) return null;

  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      {resolvedCommandLabel && (
        <div className="flex items-center gap-1 px-1 text-[11px] leading-4 text-text-3">
          <span className="shrink-0 font-medium">Command</span>
          <code className="min-w-0 truncate rounded bg-fill-1 px-1.5 py-0.5 font-mono text-[11px] text-text-2">
            {resolvedCommandLabel}
          </code>
        </div>
      )}
      <div className="flex items-center gap-1 px-1">
        <span className="shrink-0 text-[11px] font-medium text-text-3">
          Arguments
        </span>
        <input
          value={launchArgsValue}
          onChange={handleLaunchArgsChange}
          placeholder="CLI launch arguments"
          className={`h-7 min-w-0 flex-1 rounded-md border bg-fill-1 px-2 text-[12px] text-text-1 outline-none placeholder:text-text-4 focus:border-primary-5 ${
            validation.valid ? "border-border-2" : "border-danger-5"
          }`}
        />
        {docsUrl && (
          <button
            type="button"
            onClick={handleOpenDocs}
            title="Open CLI docs"
            aria-label="Open CLI docs"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
          >
            <ExternalLink size={13} strokeWidth={1.75} />
          </button>
        )}
      </div>
      {!validation.valid && validation.message && (
        <div className="px-1 text-[11px] leading-4 text-danger-6">
          {validation.message}
        </div>
      )}
    </div>
  );
};

export default CliLaunchArgumentsControl;
