import { z } from "zod/v4";

/**
 * Rust `()` crosses the Tauri boundary as JSON `null`.
 *
 * Keep that wire detail in one schema so fire-and-forget commands do not
 * report a false validation error after the backend action already succeeded.
 */
export const TauriUnitSchema = z.null().transform(() => undefined);
