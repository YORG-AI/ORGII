/** Tooltip content used by the Key Vault ModelTable. */
import ModelIcon from "@src/components/ModelIcon";

interface ModelTableTooltipContentProps {
  model: string;
}

export default function ModelTableTooltipContent({
  model,
}: ModelTableTooltipContentProps) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <ModelIcon modelName={model} size="small" />
      <span className="truncate text-text-1">{model}</span>
    </span>
  );
}
