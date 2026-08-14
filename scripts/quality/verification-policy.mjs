import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

export const repoRoot = resolve(import.meta.dirname, "..", "..");
export const verificationCacheDir = join(
  repoRoot,
  ".orgii",
  "verification-cache"
);
export const typecheckCachePath = join(verificationCacheDir, "typecheck.json");
export const typecheckLockPath = join(verificationCacheDir, "typecheck.lock");

export const MAX_AUTODETECTED_FILES = 80;

const LINTABLE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;
const TEST_RELATED_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;
const VITEST_TEST_FILE = /(?:^|\/).+\.test\.ts$/i;
const TYPECHECK_RELEVANT_EXTENSION = /\.(?:[cm]?[jt]sx?|json|ya?ml)$/i;

function runGit(args, cwd = repoRoot) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fromNullSeparated(output) {
  return output.split("\0").filter(Boolean);
}

function toRepoRelativePath(path, cwd = repoRoot) {
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const relativePath = relative(cwd, absolutePath);

  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Verification path is outside the repository: ${path}`);
  }

  return relativePath.split(sep).join("/");
}

export function normalizeRequestedFiles(paths, cwd = repoRoot) {
  return [
    ...new Set(paths.map((path) => toRepoRelativePath(path, cwd))),
  ].sort();
}

export function exceedsAutodetectedFileLimit(paths) {
  return paths.length > MAX_AUTODETECTED_FILES;
}

export function listWorkspaceChanges(cwd = repoRoot) {
  const tracked = fromNullSeparated(
    runGit(
      ["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB", "HEAD", "--"],
      cwd
    )
  );
  const untracked = fromNullSeparated(
    runGit(["ls-files", "--others", "--exclude-standard", "-z"], cwd)
  );

  return normalizeRequestedFiles([...tracked, ...untracked], cwd);
}

export function existingFiles(paths, cwd = repoRoot) {
  return paths.filter((path) => {
    const absolutePath = join(cwd, path);
    return existsSync(absolutePath) && statSync(absolutePath).isFile();
  });
}

export function lintableFiles(paths) {
  return paths.filter(
    (path) => LINTABLE_EXTENSION.test(path) && path.startsWith("src/")
  );
}

export function testRelatedFiles(paths) {
  return paths.filter(
    (path) => TEST_RELATED_EXTENSION.test(path) && path.startsWith("src/")
  );
}

export function vitestTestFiles(paths) {
  return paths.filter(
    (path) => path.startsWith("src/") && VITEST_TEST_FILE.test(path)
  );
}

export function isTypecheckRelevant(path) {
  if (
    path === "package.json" ||
    path === "pnpm-lock.yaml" ||
    path.startsWith("tsconfig")
  ) {
    return true;
  }

  return (
    TYPECHECK_RELEVANT_EXTENSION.test(path) &&
    (path.startsWith("src/") || path.startsWith("packages/"))
  );
}

export function buildVerificationFingerprint({
  head,
  files,
  nodeVersion,
  platform,
  typescriptVersion,
}) {
  const hash = createHash("sha256");
  hash.update("orgii-typecheck-v1\0");
  hash.update(`${head}\0${nodeVersion}\0${platform}\0${typescriptVersion}\0`);

  for (const file of [...files].sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    hash.update(`${file.path}\0`);
    hash.update(file.content === null ? "<deleted>" : file.content);
    hash.update("\0");
  }

  return hash.digest("hex");
}

function readTypescriptVersion(cwd = repoRoot) {
  try {
    const packageJson = JSON.parse(
      readFileSync(
        join(cwd, "node_modules", "typescript", "package.json"),
        "utf8"
      )
    );
    return String(packageJson.version ?? "unknown");
  } catch {
    return "unknown";
  }
}

export function createTypecheckFingerprint(cwd = repoRoot) {
  const head = runGit(["rev-parse", "HEAD"], cwd).trim();
  const files = listWorkspaceChanges(cwd)
    .filter(isTypecheckRelevant)
    .map((path) => {
      const absolutePath = join(cwd, path);
      return {
        path,
        content:
          existsSync(absolutePath) && statSync(absolutePath).isFile()
            ? readFileSync(absolutePath)
            : null,
      };
    });

  return buildVerificationFingerprint({
    head,
    files,
    nodeVersion: process.version,
    platform: `${process.platform}-${process.arch}`,
    typescriptVersion: readTypescriptVersion(cwd),
  });
}

export function readSuccessfulTypecheck(path = typecheckCachePath) {
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (
      record?.schemaVersion !== 1 ||
      typeof record.fingerprint !== "string" ||
      typeof record.completedAt !== "string"
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

export function isSuccessfulTypecheckCached(
  fingerprint,
  path = typecheckCachePath
) {
  return readSuccessfulTypecheck(path)?.fingerprint === fingerprint;
}

export function writeSuccessfulTypecheck(
  fingerprint,
  path = typecheckCachePath
) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        fingerprint,
        completedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  renameSync(temporaryPath, path);
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function acquireTypecheckLock(path = typecheckLockPath) {
  mkdirSync(dirname(path), { recursive: true });

  function tryCreateLock() {
    let descriptor;
    try {
      descriptor = openSync(path, "wx");
      writeFileSync(
        descriptor,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        })
      );
      closeSync(descriptor);
      descriptor = undefined;
      return () => {
        try {
          unlinkSync(path);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error?.code === "EEXIST") return undefined;
      try {
        unlinkSync(path);
      } catch (cleanupError) {
        if (cleanupError?.code !== "ENOENT") throw cleanupError;
      }
      throw error;
    }
  }

  const initialLock = tryCreateLock();
  if (initialLock) return initialLock;

  try {
    const lock = JSON.parse(readFileSync(path, "utf8"));
    if (isProcessAlive(lock?.pid)) return null;
  } catch {
    // An unreadable lock cannot prove that a verification process is active.
  }

  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return tryCreateLock() ?? null;
}
