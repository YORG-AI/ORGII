/**
 * Simulator App Registry
 *
 * Hosts the registry (which maps AppType -> lazy-loaded WorkStation components)
 * and the renderer hook. Pure framework types/hooks remain in
 * engines/Simulator/apps/core/.
 */

export {
  getAppForEvent,
  getSimulatorAppConfig,
  hasSimulatorApp,
} from "./registry";

export { useSimulatorAppRenderer } from "./useSimulatorAppRenderer";
