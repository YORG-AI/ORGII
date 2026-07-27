/**
 * ShellAdapter — handles `run_shell`. Resolves the `run` / `kill`
 * lifecycle labels from the Rust registry and hands the pre-translated
 * strings to `ShellBlock`.
 *
 * Shell commands that are really code searches — pure grep/rg pipelines like
 * `grep -rn "foo" src | head -20` — render via `SearchBlock` instead, so the
 * chat stream shows them with the same treatment as native grep tool events
 * (matches the explore-panel routing in the workstation replay IDE).
 *
 * `await_output` is a separate chat_block (`TitleOnly`) and never reaches
 * this adapter; it's rendered by `TitleOnlyAdapter` directly.
 */
import { useAtomValue } from "jotai";
import React from "react";

import {
  statusToLifecycle,
  useLifecycleLabels,
} from "@src/engines/SessionCore/rendering/registry";
import type { UniversalEventProps } from "@src/engines/SessionCore/rendering/types/universalProps";
import { tuiModeAtom } from "@src/store/session/tuiModeAtom";
import { parseShellSearchCommand } from "@src/util/terminal/searchCommandParser";
import { getToolDisplayLabelFromRegistry } from "@src/util/ui/rendering/registryToolLabel";

import SearchBlock from "../../blocks/SearchBlock";
import { ShellBlock } from "../../blocks/ShellBlock";

function extractCommand(props: UniversalEventProps): string {
  if (typeof props.args?.command === "string") return props.args.command;
  if (typeof props.result?.command === "string") return props.result.command;
  return "";
}

export const ShellAdapter: React.FC<UniversalEventProps> = (props) => {
  const action = (props.args?.action as string) || undefined;
  const runLabels = useLifecycleLabels("run_shell", action ?? "run");
  const killLabels = useLifecycleLabels("run_shell", "kill");
  const searchLabels = useLifecycleLabels("code_search", "grep");
  const state = statusToLifecycle(props.status);

  const toolName = props.eventType || props.functionName;
  const tuiMode = useAtomValue(tuiModeAtom(props.sessionId ?? ""));

  const searchCommand = parseShellSearchCommand(extractCommand(props));
  if (searchCommand) {
    const isLoading =
      props.status === "running" && props.showActiveEventPainting === true;
    const title =
      searchLabels[state] ||
      getToolDisplayLabelFromRegistry("code_search", "grep");
    return (
      <div
        data-tool-call-event-id={props.eventId}
        data-tool-call-name={toolName}
      >
        <SearchBlock
          pattern={searchCommand.pattern}
          isLoading={isLoading}
          eventId={props.eventId}
          action="grep"
          title={title}
          toolUsage={props.toolUsage}
        />
      </div>
    );
  }

  return (
    <div data-tool-call-event-id={props.eventId} data-tool-call-name={toolName}>
      <ShellBlock
        {...props}
        title={runLabels[state]}
        killTitle={killLabels[state]}
        failedLabel={runLabels.failed}
        tuiRendering={tuiMode}
      />
    </div>
  );
};

ShellAdapter.displayName = "ShellAdapter";

export default ShellAdapter;
