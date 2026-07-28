import { rpc } from "@src/api/tauri/rpc";
import type { AvailableAgent } from "@src/api/tauri/rpc/schemas/validation";

let availableAgentsInFlight: Promise<AvailableAgent[]> | null = null;

/**
 * Share concurrent CLI-registry loads across every mounted consumer.
 *
 * Successful values are deliberately not cached here: Rust owns freshness and
 * invalidation using PATH, key, binary fingerprint, and TTL inputs. This layer
 * only removes duplicate IPC while a request is in flight.
 */
export function loadAvailableAgents(): Promise<AvailableAgent[]> {
  if (availableAgentsInFlight) return availableAgentsInFlight;

  const request = rpc.validation.getAvailableAgents();
  availableAgentsInFlight = request;
  void request.then(
    () => {
      if (availableAgentsInFlight === request) availableAgentsInFlight = null;
    },
    () => {
      if (availableAgentsInFlight === request) availableAgentsInFlight = null;
    }
  );
  return request;
}
