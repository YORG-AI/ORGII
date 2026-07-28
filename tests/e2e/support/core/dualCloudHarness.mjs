import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { remote } from "webdriverio";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..", "..");
const tauriConfigPath = resolve(repoRoot, "src-tauri/tauri.conf.json");
const compiledBinaryPath = resolve(repoRoot, "src-tauri/target/debug/org2");

const SECONDARY_WEBDRIVER_PORT = Number.parseInt(
  process.env.E2E_SECONDARY_WEBDRIVER_PORT ?? "4455",
  10
);
const SECONDARY_IDE_PORT = Number.parseInt(
  process.env.E2E_SECONDARY_IDE_SERVER_PORT ?? "24847",
  10
);
const SECONDARY_CLI_PROXY_PORT = Number.parseInt(
  process.env.E2E_SECONDARY_CLI_PROXY_PORT ?? "28889",
  10
);

function writeJsonAtomically(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, path);
}

function seedSecondaryRealAccount(orgiiHome) {
  if (process.env.E2E_PROVIDER_MODE !== "oauth-live") return null;

  const requestedAccount = (process.env.E2E_SECONDARY_ACCOUNT ?? "").trim();
  if (!requestedAccount) {
    throw new Error(
      "E2E_PROVIDER_MODE=oauth-live requires E2E_SECONDARY_ACCOUNT for the second app"
    );
  }
  if (requestedAccount === (process.env.E2E_OPENAI_ACCOUNT ?? "").trim()) {
    throw new Error(
      "The two live app instances must use different OAuth accounts; rotating one credential chain concurrently is unsafe"
    );
  }

  // WDIO's primary app already owns an isolated OAuth home. Seed only the
  // explicitly selected second account from that isolated copy, never the
  // user's complete credentials file.
  const primaryHome = process.env.ORGII_HOME;
  if (!primaryHome) {
    throw new Error("The primary isolated ORGII_HOME is missing");
  }
  const sourcePath = join(primaryHome, "credentials.json");
  if (!existsSync(sourcePath)) {
    throw new Error(`Primary credentials are missing at ${sourcePath}`);
  }
  const source = JSON.parse(readFileSync(sourcePath, "utf8"));
  const match = Object.entries(source.credentials ?? {}).find(
    ([id, account]) =>
      id === requestedAccount || account?.name === requestedAccount
  );
  if (!match) {
    throw new Error(
      `Secondary live account ${requestedAccount} was not found in the isolated credential source`
    );
  }

  const [accountId, account] = match;
  const targetPath = join(orgiiHome, "credentials.json");
  writeJsonAtomically(targetPath, {
    version: source.version ?? "2.0",
    updated_at: source.updated_at ?? new Date().toISOString(),
    credentials: {
      [accountId]: { ...account, enabled: true },
    },
  });
  return {
    accountId,
    accountName: account?.name ?? accountId,
    sourceEnabled: account?.enabled === true,
    sourcePath,
    targetPath,
  };
}

function mergeSecondaryRealAccount(seededAccount) {
  if (!seededAccount || !existsSync(seededAccount.targetPath)) return;
  const source = JSON.parse(readFileSync(seededAccount.sourcePath, "utf8"));
  const secondary = JSON.parse(readFileSync(seededAccount.targetPath, "utf8"));
  const rotated = secondary.credentials?.[seededAccount.accountId];
  if (!rotated) {
    throw new Error(
      `Second app lost its selected account ${seededAccount.accountName}`
    );
  }

  // Preserve the user's enabled/disabled preference while retaining any
  // token rotation performed by the live second app. WDIO later mirrors this
  // combined isolated file back to its source as one clean shutdown step.
  source.credentials = source.credentials ?? {};
  source.credentials[seededAccount.accountId] = {
    ...rotated,
    enabled: seededAccount.sourceEnabled,
  };
  source.updated_at = secondary.updated_at ?? source.updated_at;
  writeJsonAtomically(seededAccount.sourcePath, source);
}

async function canConnect(port) {
  return new Promise((resolveConnection) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (connected) => {
      socket.destroy();
      resolveConnection(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

async function waitForPort(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`secondary service port ${port} did not open`);
}

async function assertPortsFree(ports) {
  const occupied = [];
  for (const port of ports) {
    if (await canConnect(port)) occupied.push(port);
  }
  if (occupied.length > 0) {
    throw new Error(
      `secondary E2E ports already in use: ${occupied.join(", ")}; stop the stale instance or override E2E_SECONDARY_* ports`
    );
  }
}

function secondaryTauriConfig(originalConfig) {
  const config = JSON.parse(originalConfig);
  const frontendPort = process.env.E2E_FRONTEND_PORT ?? "1998";
  return `${JSON.stringify(
    {
      ...config,
      productName: "ORG2 E2E Instance 2",
      identifier: "yorg.orgii.e2e.instance2",
      build: {
        ...config.build,
        devUrl: `http://localhost:${frontendPort}`,
      },
      plugins: {
        ...config.plugins,
        "deep-link": {
          desktop: { schemes: ["yorgai-e2e-instance2", "orgii-e2e-instance2"] },
        },
        updater: { ...config.plugins?.updater, active: false },
      },
    },
    null,
    2
  )}\n`;
}

/**
 * Build an independently identified WebDriver binary without leaving source
 * config modified. The primary process is already running when this executes;
 * after copying the secondary binary, the primary config is rebuilt so the
 * shared Cargo target also returns to its normal identity.
 */
function buildSecondaryBinary(tempRoot) {
  const originalConfig = readFileSync(tauriConfigPath, "utf8");
  const secondaryBinary = join(tempRoot, "org2-e2e-instance2");
  const cargoArgs = [
    "build",
    "--manifest-path",
    resolve(repoRoot, "src-tauri/Cargo.toml"),
    "-p",
    "org2",
    "--features",
    "webdriver",
  ];

  try {
    writeFileSync(tauriConfigPath, secondaryTauriConfig(originalConfig));
    execFileSync("cargo", cargoArgs, { cwd: repoRoot, stdio: "inherit" });
    copyFileSync(compiledBinaryPath, secondaryBinary);
  } finally {
    writeFileSync(tauriConfigPath, originalConfig);
  }

  // Do not leave the shared debug artifact carrying the secondary bundle id.
  execFileSync("cargo", cargoArgs, { cwd: repoRoot, stdio: "inherit" });
  return secondaryBinary;
}

export async function executeOn(client, script, args = []) {
  return client.executeScript(script, args);
}

export async function invokeOn(client, method, ...args) {
  const envelope = await client.executeAsyncScript(
    `
      const cb = arguments[arguments.length - 1];
      const method = arguments[0];
      const rest = Array.prototype.slice.call(arguments, 1, arguments.length - 1);
      if (!window.__e2e || typeof window.__e2e[method] !== "function") {
        cb({ e2eResult: { ok: false, error: "window.__e2e." + method + " not available" } });
        return;
      }
      Promise.resolve(window.__e2e[method].apply(null, rest))
        .then((result) => cb({ e2eResult: result }))
        .catch((error) => cb({ e2eResult: { ok: false, error: String(error && error.message || error) } }));
    `,
    [method, ...args]
  );
  return (
    envelope?.e2eResult ?? {
      ok: false,
      error: "invokeOn returned no envelope",
    }
  );
}

export function unwrapOn(result, label) {
  if (!result || result.ok !== true) {
    throw new Error(`${label} failed: ${result?.error ?? "unknown"}`);
  }
  return result;
}

export async function waitForRenderedOn(
  client,
  selector,
  label,
  timeout = 30_000
) {
  try {
    await client.waitUntil(
      async () =>
        executeOn(client, "return !!document.querySelector(arguments[0]);", [
          selector,
        ]),
      {
        timeout,
        interval: 250,
        timeoutMsg: `${label} never rendered: ${selector}`,
      }
    );
  } catch (error) {
    const diagnostic = await executeOn(
      client,
      `
        return {
          pathname: window.location.pathname,
          readyState: document.readyState,
          title: document.title,
          bodyText: (document.body?.innerText ?? "").slice(0, 2000),
          bodyHtml: (document.body?.innerHTML ?? "").slice(0, 2000),
          testIds: Array.from(document.querySelectorAll("[data-testid]"))
            .slice(0, 80)
            .map((element) => element.getAttribute("data-testid")),
          storageKeys: Object.keys(window.localStorage).sort(),
        };
      `
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `secondary render diagnostic: ${JSON.stringify(diagnostic)}`
    );
  }
}

export async function waitForGoneOn(client, selector, label, timeout = 30_000) {
  await client.waitUntil(
    async () =>
      !(await executeOn(
        client,
        "return !!document.querySelector(arguments[0]);",
        [selector]
      )),
    {
      timeout,
      interval: 250,
      timeoutMsg: `${label} never left the DOM: ${selector}`,
    }
  );
}

export async function clickRenderedOn(client, selector, label) {
  await waitForRenderedOn(client, selector, label);
  let result = "missing";
  await client.waitUntil(
    async () => {
      result = await executeOn(
        client,
        `
          const selector = arguments[0];
          const candidates = Array.from(document.querySelectorAll(selector));
          const visible = candidates.filter((element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          });
          const element = visible[visible.length - 1] ?? candidates[candidates.length - 1] ?? null;
          if (!element) return "missing";
          if (element.disabled) return "disabled";
          element.scrollIntoView({ block: "center", inline: "center" });
          element.click();
          return "clicked";
        `,
        [selector]
      );
      return result === "clicked";
    },
    {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: `${label} click failed (${selector}): ${result}`,
    }
  );
}

export async function typeRenderedOn(client, selector, value, label) {
  await waitForRenderedOn(client, selector, label);
  const result = await executeOn(
    client,
    `
      const selector = arguments[0];
      const value = arguments[1];
      const candidates = Array.from(document.querySelectorAll(selector));
      const visible = candidates.filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      const element = visible[visible.length - 1] ?? candidates[candidates.length - 1] ?? null;
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) return "not-input";
      element.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
      const previousValue = element.value;
      setter?.call(element, value);
      element._valueTracker?.setValue?.(previousValue);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return element.value === value ? "typed" : element.value;
    `,
    [selector, value]
  );
  if (result !== "typed") {
    throw new Error(`${label} input failed (${selector}): ${result}`);
  }
}

export async function typeContentEditableOn(client, selector, value, label) {
  await waitForRenderedOn(client, selector, label);
  const result = await executeOn(
    client,
    `
      const selector = arguments[0];
      const value = arguments[1];
      const editors = Array.from(document.querySelectorAll(selector)).filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return element.isContentEditable && rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      });
      const editor = editors[editors.length - 1] ?? null;
      if (!editor) return "missing";
      editor.focus();
      document.execCommand("selectAll", false, null);
      const inserted = document.execCommand("insertText", false, value);
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      return inserted ? "typed" : "insert-failed";
    `,
    [selector, value]
  );
  if (result !== "typed") {
    throw new Error(`${label} contenteditable failed (${selector}): ${result}`);
  }
}

export async function pressEscapeOn(client) {
  await executeOn(
    client,
    `
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return true;
    `
  );
}

export async function applyCloudEndpointOn(client, endpoint) {
  await executeOn(
    client,
    `
      window.localStorage.setItem(arguments[0], JSON.stringify(arguments[1]));
      return true;
    `,
    [
      "orgii:org2-cloud-v1:endpointOverride",
      {
        webOrigin: endpoint.webOrigin,
        supabaseUrl: endpoint.supabaseUrl,
        anonKey: endpoint.anonKey,
      },
    ]
  );
}

export async function waitForCloudOrgsOn(client, timeout = 45_000) {
  let orgs = [];
  await client.waitUntil(
    async () => {
      const listed = unwrapOn(
        await invokeOn(client, "cloudListOrgs"),
        "secondary cloudListOrgs"
      );
      orgs = listed.orgs ?? [];
      return orgs.length > 0;
    },
    {
      timeout,
      interval: 1_000,
      timeoutMsg: "secondary list_my_orgs never returned an org",
    }
  );
  return orgs;
}

export async function startSecondCloudInstance() {
  await assertPortsFree([
    SECONDARY_WEBDRIVER_PORT,
    SECONDARY_IDE_PORT,
    SECONDARY_CLI_PROXY_PORT,
  ]);

  const tempRoot = mkdtempSync(join(tmpdir(), "orgii-e2e-instance2-"));
  const orgiiHome = join(tempRoot, "home");
  const externalHistoryHome = join(orgiiHome, "external-history-home");
  const seededAccount = seedSecondaryRealAccount(orgiiHome);
  const binary = buildSecondaryBinary(tempRoot);
  const driverProcess = spawn(
    "tauri-wd",
    ["--port", String(SECONDARY_WEBDRIVER_PORT)],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ORGII_E2E: "1",
        ORGII_E2E_DISABLE_BACKGROUND_LLM: "1",
        ORGII_HOME: orgiiHome,
        // Defense in depth: the embedded E2E identity derives this same path,
        // but the launcher pins it explicitly so a parser regression can
        // never expose the real user's Codex/Claude histories to account 2.
        ORGII_EXTERNAL_HISTORY_HOME: externalHistoryHome,
        ORGII_IDE_SERVER_PORT: String(SECONDARY_IDE_PORT),
        ORGII_CLI_PROXY_PORT: String(SECONDARY_CLI_PROXY_PORT),
      },
      stdio: "inherit",
    }
  );

  let client = null;
  try {
    await waitForPort(SECONDARY_WEBDRIVER_PORT);
    client = await remote({
      hostname: "127.0.0.1",
      port: SECONDARY_WEBDRIVER_PORT,
      path: "/",
      logLevel: process.env.WDIO_LOG_LEVEL ?? "warn",
      connectionRetryCount: 10,
      connectionRetryTimeout: Number.parseInt(
        process.env.WDIO_CONNECTION_RETRY_TIMEOUT_MS ?? "30000",
        10
      ),
      capabilities: {
        timeouts: { script: 420_000 },
        "tauri:options": { binary },
      },
    });
    await client.setTimeout({ script: 420_000 });
    await client.waitUntil(
      async () => {
        try {
          await executeOn(
            client,
            "window.localStorage.setItem(arguments[0], arguments[1]); return true;",
            ["orgii:e2eBaseUrl", `http://127.0.0.1:${SECONDARY_IDE_PORT}`]
          );
          return true;
        } catch {
          return false;
        }
      },
      {
        timeout: 60_000,
        interval: 250,
        timeoutMsg: "secondary app never exposed its WebView",
      }
    );

    return {
      client,
      ideServerPort: SECONDARY_IDE_PORT,
      orgiiHome,
      seededAccountName: seededAccount?.accountName ?? null,
      async stop() {
        try {
          await client?.deleteSession();
        } finally {
          driverProcess.kill("SIGTERM");
          try {
            mergeSecondaryRealAccount(seededAccount);
          } finally {
            rmSync(tempRoot, { force: true, recursive: true });
          }
        }
      },
    };
  } catch (error) {
    try {
      await client?.deleteSession();
    } catch {}
    driverProcess.kill("SIGTERM");
    rmSync(tempRoot, { force: true, recursive: true });
    throw error;
  }
}
