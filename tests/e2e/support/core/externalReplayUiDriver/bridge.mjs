/** Serialized access to the single-slot Tauri WebDriver bridge. */

export const MIB = 1024 * 1024;
export const REPLAY_MAX_IPC_BYTES = 4 * MIB;
export const REPLAY_MAX_EVENTS = 200;

// tauri-plugin-webdriver-automation 0.1.3 has a single pending-script slot.
// Serialize sync and async bridge calls through one queue so WebdriverIO
// retries or diagnostics cannot overwrite that slot and poison its mutex.
let webDriverBridgeTail = Promise.resolve();

function runWebDriverBridge(operation) {
  const current = webDriverBridgeTail.then(operation, operation);
  webDriverBridgeTail = current.catch(() => undefined);
  return current;
}

export async function execJS(script) {
  return runWebDriverBridge(() => browser.executeScript(script, []));
}

export async function invokeTauriCommand(command, args = {}) {
  const envelope = await runWebDriverBridge(() =>
    browser.executeAsyncScript(
      `
        const cb = arguments[arguments.length - 1];
        const command = arguments[0];
        const args = arguments[1];
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (typeof invoke !== "function") {
          cb({ ok: false, error: "Tauri invoke is unavailable" });
          return;
        }
        Promise.resolve(invoke(command, args))
          .then((result) => cb({ ok: true, result }))
          .catch((error) => cb({ ok: false, error: String(error?.message || error) }));
      `,
      [command, args]
    )
  );
  if (envelope?.ok !== true) {
    throw new Error(
      `Tauri ${command} failed: ${envelope?.error ?? "unknown error"}`
    );
  }
  return envelope.result;
}

export async function invokeE2E(method, ...args) {
  return runWebDriverBridge(() =>
    browser.executeAsyncScript(
      `
        const cb = arguments[arguments.length - 1];
        const method = arguments[0];
        const rest = Array.prototype.slice.call(arguments, 1, arguments.length - 1);
        if (!window.__e2e || typeof window.__e2e[method] !== "function") {
          cb({ ok: false, error: "window.__e2e." + method + " not available" });
          return;
        }
        Promise.resolve(window.__e2e[method].apply(null, rest))
          .then(cb)
          .catch((error) =>
            cb({ ok: false, error: String(error && error.message || error) })
          );
      `,
      [method, ...args]
    )
  );
}
