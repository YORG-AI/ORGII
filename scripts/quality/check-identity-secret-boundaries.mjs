#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..");
const sourceRoots = [join(repoRoot, "src"), join(repoRoot, "src-tauri", "src")];
const skippedDirectories = new Set(["node_modules", "target", "build", "dist"]);
const sourceExtension = /\.(?:rs|ts|tsx|js|jsx|mjs|cjs)$/;

const legacySecretOwners = new Set();
const legacySharedStoreOwners = new Set([
  "src/api/http/auth/sharedAuthStorage.ts",
  "src-tauri/src/identity/migration.rs",
]);

const violations = [];

function listSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (skippedDirectories.has(entry)) continue;
    const absolutePath = join(directory, entry);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(absolutePath));
    } else if (stat.isFile() && sourceExtension.test(entry)) {
      files.push(absolutePath);
    }
  }
  return files;
}

function isProductionSource(relativePath) {
  return !(
    /(?:^|\/)__tests__(?:\/|$)/.test(relativePath) ||
    /(?:\.test|\.spec)\.[^.]+$/.test(relativePath) ||
    relativePath.includes("/e2e/")
  );
}

for (const absolutePath of sourceRoots.flatMap(listSourceFiles)) {
  const relativePath = relative(repoRoot, absolutePath);
  if (!isProductionSource(relativePath)) continue;
  const source = readFileSync(absolutePath, "utf8");

  for (const [label, pattern] of [
    ["fixed-port legacy login", /\b54031\b/],
    ["dead login modal state", /loginModal(?:Visible|Fix)Atom/],
    [
      "cross-realm session-expired dispatcher",
      /SESSION_EXPIRED_EVENT|triggerSessionExpired/,
    ],
  ]) {
    if (pattern.test(source)) {
      violations.push(`${relativePath}: ${label}`);
    }
  }

  if (
    source.includes("shared-service-auth.json") &&
    !legacySharedStoreOwners.has(relativePath)
  ) {
    violations.push(`${relativePath}: adds another shared auth-store owner`);
  }

  const writesBrowserSecret =
    /(?:localStorage|sessionStorage)\.setItem\s*\([\s\S]{0,240}(?:accessToken|refreshToken|idToken|codeVerifier|access_token|refresh_token|id_token|code_verifier)/.test(
      source
    );
  const persistsCloudAuthEnvelope =
    /atomWithStorage\s*<\s*Org2CloudAuthState/.test(source);
  if (
    (writesBrowserSecret || persistsCloudAuthEnvelope) &&
    !legacySecretOwners.has(relativePath)
  ) {
    violations.push(
      `${relativePath}: persists an identity secret outside the inventoried legacy owners`
    );
  }

  const isPublicIdentityBoundary =
    relativePath.startsWith("src/features/Identity/") ||
    relativePath.startsWith("src-tauri/src/identity/commands") ||
    relativePath.startsWith("src-tauri/src/identity/events");
  if (
    isPublicIdentityBoundary &&
    /\b(?:refresh_token|refreshToken|code_verifier|codeVerifier|client_secret|clientSecret|id_token|idToken|session_token|sessionToken|raw_token_response|rawTokenResponse|authorization_header|authorizationHeader)\b/.test(
      source
    )
  ) {
    violations.push(
      `${relativePath}: public identity boundary exposes a secret field`
    );
  }
}

if (violations.length > 0) {
  console.error("Identity secret-boundary check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  "Identity secret-boundary check passed (Cloud and Hosted projections are non-secret; the Cloud rollout-only migration store is inventoried)."
);
