class WebPlatformUnsupportedError extends Error {
  constructor(capability) {
    super(`${capability} is only available in the ORG2 desktop app`);
    this.name = "WebPlatformUnsupportedError";
  }
}

const unsupported = (capability) =>
  Promise.reject(new WebPlatformUnsupportedError(capability));
const unlisten = async () => () => undefined;

class Channel {
  constructor(onmessage = () => undefined) {
    this.id = 0;
    this.onmessage = onmessage;
  }
}

class LazyStore {
  constructor() {
    throw new WebPlatformUnsupportedError("Tauri store");
  }
}

class Update {
  downloadAndInstall() {
    return unsupported("desktop updates");
  }
}

class Menu {
  static async new() {
    return new Menu();
  }

  popup() {
    return unsupported("native menus");
  }
}

class Command {
  static create() {
    return new Command();
  }

  execute() {
    return unsupported("native command execution");
  }

  spawn() {
    return unsupported("native command execution");
  }
}

class LogicalPosition {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}

class PhysicalPosition extends LogicalPosition {}

const webWindow = {
  label: "web",
  isFocused: async () =>
    typeof document === "undefined" ? true : document.hasFocus(),
  onFocusChanged: unlisten,
  onCloseRequested: unlisten,
  listen: unlisten,
  emit: async () => undefined,
};

class WebviewWindow {
  static getByLabel() {
    return null;
  }

  static getCurrent() {
    return webWindow;
  }

  constructor() {
    return webWindow;
  }
}

async function openUrl(url) {
  if (typeof window === "undefined") return;
  window.open(String(url), "_blank", "noopener,noreferrer");
}

async function join(...parts) {
  return parts
    .map((part) => String(part).replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

const unsupportedFileSystem = () => unsupported("local filesystem access");
const unsupportedNativeDialog = () => unsupported("native file dialog");

module.exports = {
  Channel,
  Command,
  LazyStore,
  LogicalPosition,
  Menu,
  PhysicalPosition,
  Update,
  WebviewWindow,
  appCacheDir: unsupportedFileSystem,
  appDataDir: unsupportedFileSystem,
  ask: unsupportedNativeDialog,
  convertFileSrc: (source) => String(source),
  copyFile: unsupportedFileSystem,
  documentDir: unsupportedFileSystem,
  emit: async () => undefined,
  exists: async () => false,
  getCurrentWebview: () => webWindow,
  getCurrentWebviewWindow: () => webWindow,
  getCurrentWindow: () => webWindow,
  getVersion: async () => "web",
  homeDir: unsupportedFileSystem,
  invoke: (command) => unsupported(`Tauri command ${String(command)}`),
  isPermissionGranted: async () => false,
  isTauri: () => false,
  join,
  listen: unlisten,
  load: () => unsupported("Tauri store"),
  message: unsupportedNativeDialog,
  mkdir: unsupportedFileSystem,
  onAction: unlisten,
  open: unsupportedNativeDialog,
  openPath: () => unsupported("opening a local path"),
  openUrl,
  readDir: unsupportedFileSystem,
  readFile: unsupportedFileSystem,
  readTextFile: unsupportedFileSystem,
  registerActionTypes: async () => undefined,
  relaunch: () => unsupported("desktop relaunch"),
  remove: unsupportedFileSystem,
  rename: unsupportedFileSystem,
  requestPermission: async () => "denied",
  resolveResource: unsupportedFileSystem,
  revealItemInDir: () => unsupported("revealing a local path"),
  save: unsupportedNativeDialog,
  sendNotification: async () => undefined,
  stat: unsupportedFileSystem,
  transformCallback: () => 0,
  writeFile: unsupportedFileSystem,
  writeTextFile: unsupportedFileSystem,
};
