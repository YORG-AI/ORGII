import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, parse, relative, resolve } from "node:path";

const FIXTURE_ROOT_MARKER = ".orgii-sidebar-e2e-fixture-root";
const FIXTURE_ROOT_MARKER_CONTENT = "orgii-sidebar-e2e-fixture-v1\n";

export function prepareSidebarFixtureRoot({
  orgiiHome,
  candidateHome,
  realUserHome,
}) {
  const configuredRoot = resolve(orgiiHome);
  const isolatedRoot = realpathSync(orgiiHome);
  const resolvedRealHome = realpathSync(realUserHome);
  if (
    isolatedRoot === parse(isolatedRoot).root ||
    isolatedRoot === resolvedRealHome
  ) {
    throw new Error(
      `Refusing sidebar fixture setup in non-isolated ORGII_HOME: ${isolatedRoot}`
    );
  }

  const candidate = resolve(candidateHome);
  const relativeCandidate = relative(configuredRoot, candidate);
  if (
    !relativeCandidate ||
    relativeCandidate.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`
    ) ||
    relativeCandidate === ".." ||
    isAbsolute(relativeCandidate) ||
    dirname(candidate) !== configuredRoot ||
    candidate === resolvedRealHome ||
    candidate === parse(candidate).root
  ) {
    throw new Error(
      `E2E_EXTERNAL_PROVIDER_HOME must be a dedicated direct child of isolated ORGII_HOME (${isolatedRoot}); got ${candidate}`
    );
  }
  if (existsSync(candidate)) {
    throw new Error(
      `E2E_EXTERNAL_PROVIDER_HOME must be fresh and absent before setup: ${candidate}`
    );
  }

  mkdirSync(candidate);
  const physicalCandidate = realpathSync(candidate);
  if (dirname(physicalCandidate) !== isolatedRoot) {
    throw new Error(
      `E2E external provider fixture escaped isolated ORGII_HOME: ${physicalCandidate}`
    );
  }
  writeFileSync(
    resolve(physicalCandidate, FIXTURE_ROOT_MARKER),
    FIXTURE_ROOT_MARKER_CONTENT,
    { encoding: "utf8", flag: "wx" }
  );
  return physicalCandidate;
}

export function assertSidebarFixtureRoot(targetHome) {
  const physicalTarget = realpathSync(targetHome);
  const physicalRealHome = realpathSync(homedir());
  if (
    physicalTarget === parse(physicalTarget).root ||
    physicalTarget === physicalRealHome
  ) {
    throw new Error(
      `Refusing destructive sidebar fixture seed in unsafe root: ${physicalTarget}`
    );
  }
  const markerPath = resolve(physicalTarget, FIXTURE_ROOT_MARKER);
  const marker = existsSync(markerPath)
    ? readFileSync(markerPath, "utf8")
    : null;
  if (marker !== FIXTURE_ROOT_MARKER_CONTENT) {
    throw new Error(
      `Refusing destructive sidebar fixture seed without marker: ${targetHome}`
    );
  }
}
