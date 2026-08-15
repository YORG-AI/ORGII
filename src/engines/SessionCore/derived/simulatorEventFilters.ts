import type {
  SimulatorEventFilterValue,
  SimulatorEventPreview,
} from "../core/types";

export {
  SIMULATOR_EVENT_FILTER_VALUES,
  getFallbackSimulatorEventFilterCategory,
} from "../core/simulatorEventFilterCategory";

export type { SimulatorEventFilterValue };

export function isSimulatorEventVisibleForFilters(
  preview: SimulatorEventPreview,
  selectedFilters: readonly SimulatorEventFilterValue[]
): boolean {
  if (selectedFilters.length === 0) return true;
  return selectedFilters.includes(preview.filterCategory);
}
