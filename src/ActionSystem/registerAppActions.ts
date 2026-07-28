/**
 * App-Level Action Registration
 *
 * Registers app-wide actions (navigation, sidebar, spotlight)
 * into the global zodActionRegistry. These are available from the moment
 * the app mounts, unlike WorkStation actions which only register when
 * a WorkStation provider mounts.
 *
 * Called once from the router root layout.
 */
import { collectAppZodActions } from "./collectAppActions";
import { zodActionRegistry } from "./schema/zodRegistry";

let registered = false;
let registeredIds: string[] = [];

/**
 * Register all app-level actions.
 * Idempotent — calling multiple times is safe.
 *
 * @returns Cleanup function to unregister actions
 */
export function registerAppActions(): () => void {
  if (registered) {
    return () => {}; // Already registered, no-op cleanup
  }

  const allActions = collectAppZodActions();

  zodActionRegistry.registerAll(allActions);
  registeredIds = allActions.map((action) => action.meta.id);
  registered = true;

  return () => {
    zodActionRegistry.unregisterAll(registeredIds);
    registeredIds = [];
    registered = false;
  };
}
