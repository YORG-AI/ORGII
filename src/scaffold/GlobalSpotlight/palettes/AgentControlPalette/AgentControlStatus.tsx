import React from "react";

import Markdown from "@src/components/MarkDown";
import { HugeiconsIcon, type IconSvgElement } from "@src/icons";

export interface AgentControlStatusProps {
  icon: IconSvgElement;
  label: string;
  detail: string;
  spinning?: boolean;
  isMarkdown?: boolean;
}

export const AgentControlStatus: React.FC<AgentControlStatusProps> = ({
  icon,
  label,
  detail,
  spinning = false,
  isMarkdown = false,
}) => {
  return (
    <div className="border-t border-border-2/50 px-4 py-3 text-[12px] text-text-2">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-1.5 text-text-1">
          <HugeiconsIcon
            icon={icon}
            size={12}
            strokeWidth={1.8}
            className={spinning ? "animate-spin" : undefined}
          />
          <span className="font-medium">{label}</span>
        </div>
        {isMarkdown ? (
          <div className="ade-status-markdown max-h-[320px] overflow-y-auto leading-5">
            <Markdown
              textContent={detail}
              useChatCodeBlock={false}
              enableFileNavigation={false}
              skipPreprocess={true}
            />
          </div>
        ) : (
          <div className="whitespace-normal break-words leading-5">
            {detail}
          </div>
        )}
      </div>
    </div>
  );
};
