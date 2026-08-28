import { formatInvokeError } from "@src/util/formatInvokeError";

/**
 * Normalise an arbitrary thrown value into a real `Error` so session-event
 * consumers get a uniform `error` field regardless of rejection shape.
 */
export function normalizeSessionEventsError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === "string") return new Error(err);

  const extracted = formatInvokeError(err);
  if (extracted !== "") return new Error(extracted);

  try {
    return new Error(JSON.stringify(err));
  } catch {
    return new Error("unknown error");
  }
}
