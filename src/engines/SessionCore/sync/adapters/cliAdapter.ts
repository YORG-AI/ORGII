/**
 * CLI session adapter composition.
 *
 * The focused modules preserve the adapter's original responsibilities:
 * history replay, live event normalization, lifecycle coordination, and
 * message transport.
 */
import type { SessionAdapter } from "../types";
import { loadCliHistory, postLoadCliSession } from "./cli/cliHistory";
import { sendCliMessage, stopCliSession } from "./cli/cliTransport";
import { createCliEventHandler } from "./cli/createCliEventHandler";

export const cliAdapter: SessionAdapter = {
  category: "cli",
  loadHistory: loadCliHistory,
  postLoad: postLoadCliSession,
  createEventHandler: createCliEventHandler,
  sendMessage: sendCliMessage,
  stopSession: stopCliSession,
};
