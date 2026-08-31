import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { collectProcessTable } from "./process-snapshot.mjs";

const ACTIVE_SCHEMA_VERSION = 1;

export class ActiveSessionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ActiveSessionError";
  }
}

export function resolveDiagnosticPaths(repoRoot, options = {}) {
  // Retain the existing state path so the rename cannot split recording ownership.
  const stateRoot = path.resolve(
    options.stateRoot ?? path.join(repoRoot, ".orgii", "diagnostics")
  );
  const outputRoot = path.resolve(
    options.outputRoot ?? path.join(stateRoot, "sessions")
  );
  return {
    stateRoot,
    outputRoot,
    activePath: path.join(stateRoot, "active-session.json"),
  };
}

export function createSessionId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

export async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

function assertActiveState(value) {
  if (
    !value ||
    value.schemaVersion !== ACTIVE_SCHEMA_VERSION ||
    typeof value.sessionId !== "string" ||
    !Number.isInteger(value.recorder?.pid) ||
    typeof value.recorder?.startToken !== "string" ||
    !Number.isInteger(value.rootProcess?.pid) ||
    typeof value.rootProcess?.startToken !== "string" ||
    !path.isAbsolute(value.sessionDir)
  ) {
    throw new ActiveSessionError(
      "Active session state is corrupt; refusing to proceed"
    );
  }
  return value;
}

export async function readActiveState(activePath) {
  try {
    return assertActiveState(JSON.parse(await readFile(activePath, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    if (error instanceof ActiveSessionError) throw error;
    throw new ActiveSessionError(
      `Cannot read active session: ${error.message}`
    );
  }
}

export function processInstanceIsLive(rows, identity) {
  return rows.some(
    (row) => row.pid === identity.pid && row.startToken === identity.startToken
  );
}

export async function inspectActiveState(activePath) {
  const active = await readActiveState(activePath);
  if (!active) return { state: "idle" };
  const rows = await collectProcessTable();
  const recorderLive = processInstanceIsLive(rows, active.recorder);
  const rootLive = processInstanceIsLive(rows, active.rootProcess);
  return {
    state: recorderLive ? "recording" : "stale",
    recorderLive,
    rootLive,
    active,
  };
}

export async function claimActiveSession(paths, active) {
  await mkdir(paths.stateRoot, { recursive: true });
  await mkdir(paths.outputRoot, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(
        paths.activePath,
        `${JSON.stringify(active, null, 2)}\n`,
        {
          encoding: "utf8",
          flag: "wx",
        }
      );
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const inspection = await inspectActiveState(paths.activePath);
      if (inspection.state === "recording") {
        throw new ActiveSessionError(
          `Session ${inspection.active.sessionId} is already recording (recorder PID ${inspection.active.recorder.pid})`
        );
      }
      const stalePath = path.join(
        paths.stateRoot,
        `stale-active-${Date.now()}-${randomUUID().slice(0, 8)}.json`
      );
      try {
        await rename(paths.activePath, stalePath);
      } catch (renameError) {
        if (renameError.code !== "ENOENT") throw renameError;
      }
    }
  }
  throw new ActiveSessionError(
    "Cannot claim diagnostic recording ownership; please retry"
  );
}

export async function removeActiveStateIfOwned(activePath, sessionId) {
  const active = await readActiveState(activePath);
  if (active?.sessionId !== sessionId) return false;
  await rm(activePath, { force: true });
  return true;
}

export async function requireLiveActiveSession(activePath) {
  const inspection = await inspectActiveState(activePath);
  if (inspection.state === "idle") {
    throw new ActiveSessionError("No diagnostic recording session is active");
  }
  if (inspection.state === "stale") {
    throw new ActiveSessionError(
      `The recorder for session ${inspection.active.sessionId} has exited; run record again`
    );
  }
  return inspection.active;
}

export async function addMarker(activePath, label) {
  const active = await requireLiveActiveSession(activePath);
  const marker = {
    schemaVersion: 1,
    id: randomUUID(),
    sessionId: active.sessionId,
    capturedAt: new Date().toISOString(),
    label,
  };
  const markersDir = path.join(active.sessionDir, "markers");
  await mkdir(markersDir, { recursive: true });
  await writeJsonAtomic(
    path.join(
      markersDir,
      `${marker.capturedAt.replace(/[:.]/g, "-")}-${marker.id}.json`
    ),
    marker
  );
  return { active, marker };
}

export async function requestStop(activePath) {
  const active = await requireLiveActiveSession(activePath);
  const request = {
    schemaVersion: 1,
    sessionId: active.sessionId,
    requestedAt: new Date().toISOString(),
    requesterPid: process.pid,
  };
  await writeJsonAtomic(
    path.join(active.sessionDir, "stop-request.json"),
    request
  );
  return { active, request };
}

export async function readStopRequest(sessionDir, sessionId) {
  try {
    const request = JSON.parse(
      await readFile(path.join(sessionDir, "stop-request.json"), "utf8")
    );
    return request?.sessionId === sessionId ? request : undefined;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function appendJsonLine(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, "a");
  try {
    await handle.write(`${JSON.stringify(value)}\n`, undefined, "utf8");
  } finally {
    await handle.close();
  }
}

export async function resolveReportSessionDir(paths, requestedPath) {
  if (requestedPath) {
    const resolved = path.resolve(requestedPath);
    const info = await stat(resolved);
    if (!info.isDirectory())
      throw new Error(`Not a session directory: ${resolved}`);
    return resolved;
  }
  let entries;
  try {
    entries = await readdir(paths.outputRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error("No diagnostic sessions are available to report");
    throw error;
  }
  const directories = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const directory = path.join(paths.outputRoot, entry.name);
        return { directory, modifiedAt: (await stat(directory)).mtimeMs };
      })
  );
  directories.sort((left, right) => right.modifiedAt - left.modifiedAt);
  if (!directories[0])
    throw new Error("No diagnostic sessions are available to report");
  return directories[0].directory;
}
