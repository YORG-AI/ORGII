/** Visual tokens owned by the Key Vault ModelTable implementation. */
import type { TagProps } from "@src/components/Tag";

export type GroupRowEra = "current" | "older";

export const MODEL_TABLE_INPUT_VALUE_TOKEN =
  "inline-flex h-[28px] shrink-0 items-center gap-1.5 rounded-full border border-border-2 bg-fill-1 px-2.5 text-[12px] font-semibold text-text-2";

export const MODEL_TABLE_INPUT_VALUE_INTERACTIVE_TOKEN = `${MODEL_TABLE_INPUT_VALUE_TOKEN} cursor-pointer hover:bg-fill-2`;

/** Tag color for generation-era labels on group rows */
export const GROUP_ROW_ERA_TAG_COLOR: Record<
  GroupRowEra,
  NonNullable<TagProps["color"]>
> = {
  current: "success",
  older: "warning",
};
