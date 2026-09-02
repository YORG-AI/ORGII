import type { ToolInfo } from "@src/api/tauri/rpc/schemas/tools";
import Checkbox from "@src/components/Checkbox";
import Radio from "@src/components/Radio";
import type { RadioValue } from "@src/components/Radio";
import { getToolIcon } from "@src/config/toolIcons";

interface ToolDefinitionTypeListProps {
  selectionMode: "single" | "multiple";
  selectedType: string;
  selectedTypesMulti: string[];
  displayToolsSingle: ToolInfo[];
  filteredTools: ToolInfo[];
  onSingleSelect: (toolName: string) => void;
  onMultiToggle: (toolName: string, checked: boolean) => void;
}

export function ToolDefinitionTypeList({
  selectionMode,
  selectedType,
  selectedTypesMulti,
  displayToolsSingle,
  filteredTools,
  onSingleSelect,
  onMultiToggle,
}: ToolDefinitionTypeListProps) {
  if (selectionMode === "single") {
    return (
      <Radio.Group
        value={selectedType}
        onChange={(value: RadioValue) => onSingleSelect(String(value))}
        direction="vertical"
        size="small"
        className="flex flex-col gap-2"
      >
        {displayToolsSingle.map((tool) => (
          <Radio
            key={tool.name}
            value={tool.name}
            className="flex items-center gap-2 py-0.5"
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              {getToolIcon(tool.name, {
                iconId: tool.icon_id,
                size: 13,
              })}
              <span className="text-left text-[13px] break-all text-text-2">
                {tool.name}
              </span>
            </span>
          </Radio>
        ))}
      </Radio.Group>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {filteredTools.map((tool) => (
        <Checkbox
          key={tool.name}
          checked={selectedTypesMulti.includes(tool.name)}
          onCheckedChange={(checked) => onMultiToggle(tool.name, checked)}
          size="small"
          className="flex items-center gap-2 py-0.5"
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            {getToolIcon(tool.name, {
              iconId: tool.icon_id,
              size: 13,
            })}
            <span className="text-left text-[13px] break-all text-text-2">
              {tool.name}
            </span>
          </span>
        </Checkbox>
      ))}
    </div>
  );
}
