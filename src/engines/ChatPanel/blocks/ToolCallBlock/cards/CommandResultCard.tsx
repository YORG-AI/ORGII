import React from "react";

import {
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  ComputerTerminal01Icon,
  HugeiconsIcon,
} from "@src/icons";

import type { CommandResultData } from "../types";
import { ToolResultCardFrame } from "./ToolResultCardFrame";

interface CommandResultCardProps {
  card: CommandResultData;
}

const CommandResultCard: React.FC<CommandResultCardProps> = ({ card }) => {
  const isSuccess = card.exitCode === 0;

  return (
    <ToolResultCardFrame
      padded={false}
      hoverable={false}
      className="overflow-hidden"
    >
      {/* Header row: command + exit status */}
      <div className="flex items-center gap-2 border-b border-fill-4 px-3 py-2">
        <HugeiconsIcon
          icon={ComputerTerminal01Icon}
          data-icon="terminal"
          size={12}
          className="shrink-0 text-text-4"
        />
        <code className="min-w-0 flex-1 truncate text-xs text-text-2">
          {card.command}
        </code>
        <span
          className={`inline-flex shrink-0 items-center gap-1 text-xs ${isSuccess ? "text-success-6" : "text-danger-6"}`}
        >
          {isSuccess ? (
            <HugeiconsIcon
              icon={CheckmarkCircle01Icon}
              data-icon="check-circle-2"
              size={11}
            />
          ) : (
            <HugeiconsIcon
              icon={CancelCircleIcon}
              data-icon="xcircle"
              size={11}
            />
          )}
          {isSuccess ? "0" : String(card.exitCode)}
        </span>
      </div>

      {/* Summary row */}
      <div className="px-3 py-2">
        <p className="chat-block-content text-xs text-text-2">{card.summary}</p>
      </div>

      {/* Artifact rows */}
      {card.artifacts && card.artifacts.length > 0 && (
        <div className="border-t border-fill-4 px-3 py-1.5">
          {card.artifacts.map((artifact) => (
            <div
              key={artifact.label}
              className="flex items-center justify-between py-0.5"
            >
              <span className="truncate text-xs text-text-4">
                {artifact.label}
              </span>
              <span className="ml-4 shrink-0 text-xs text-text-3">
                {artifact.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </ToolResultCardFrame>
  );
};

CommandResultCard.displayName = "CommandResultCard";

export default CommandResultCard;
