import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { type ReactElement, type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AppUpdateDownloadNoticeContent,
  type AppUpdateDownloadProgress,
  DownloadProgressOrb,
} from "./DownloadProgress";
import {
  AppUpdater,
  checkForUpdatesManually,
  installAvailableAppUpdate,
  resetAppUpdaterForTests,
} from "./index";

interface CapturedButtonProps {
  children?: ReactNode;
  onClick?: () => void | Promise<void>;
}

interface CapturedCheckboxProps {
  children?: ReactNode;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
}

interface CapturedModalProps {
  children?: ReactNode;
  footer?: ReactNode;
  visible?: boolean;
}

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  getVersion: vi.fn(),
  messageError: vi.fn(),
  messageInfo: vi.fn(),
  messageRemove: vi.fn(),
  messageSuccess: vi.fn(),
  relaunch: vi.fn(),
  storeGet: vi.fn(),
  storeSet: vi.fn(),
  storeValues: new Map<unknown, unknown>(),
  useAtom: vi.fn(),
  useAtomValue: vi.fn(),
  setAutoUpdateEnabled: vi.fn(),
  setInstallPromptVisible: vi.fn(),
  buttons: [] as CapturedButtonProps[],
  checkbox: null as CapturedCheckboxProps | null,
  modal: null as CapturedModalProps | null,
}));

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useAtom: mocks.useAtom,
    useAtomValue: mocks.useAtomValue,
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { version?: string }) => {
      const labels: Record<string, string> = {
        "common:actions.later": "Later",
        "update.autoDownloadUpdates": "Automatically download future updates",
        "update.installAndRestart": "Install and restart",
        "update.installConfirmDesc": `Version ${values?.version ?? ""} is ready.`,
        "update.installConfirmTitle": "Update ready to install",
        "update.skipVersion": "Skip this version",
      };
      return labels[key] ?? key;
    },
  }),
}));

vi.mock("@src/components/AppMark", async () => {
  const React = await import("react");
  return {
    default: () => React.createElement("span", { "data-testid": "app-mark" }),
  };
});

vi.mock("@src/components/Button", async () => {
  const React = await import("react");
  return {
    default: (props: CapturedButtonProps) => {
      mocks.buttons.push(props);
      return React.createElement("button", null, props.children);
    },
  };
});

vi.mock("@src/components/Checkbox", async () => {
  const React = await import("react");
  return {
    default: (props: CapturedCheckboxProps) => {
      mocks.checkbox = props;
      return React.createElement("label", null, props.children);
    },
  };
});

vi.mock("@src/scaffold/ModalSystem", async () => {
  const React = await import("react");
  return {
    default: (props: CapturedModalProps) => {
      mocks.modal = props;
      return React.createElement(
        "section",
        { "data-visible": String(props.visible) },
        props.children,
        props.footer
      );
    },
  };
});

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: mocks.getVersion,
}));

vi.mock("./channelCheck", () => ({
  checkAppUpdateOnChannel: mocks.check,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: mocks.relaunch,
}));

vi.mock("@src/components/Message", () => ({
  default: {
    error: mocks.messageError,
    info: mocks.messageInfo,
    remove: mocks.messageRemove,
    success: mocks.messageSuccess,
  },
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock("@src/util/core/state/instrumentedStore", () => ({
  getInstrumentedStore: () => ({
    get: mocks.storeGet,
    set: mocks.storeSet,
  }),
}));

function createUpdate(overrides: Partial<Update> = {}): Update {
  return {
    available: true,
    close: vi.fn().mockResolvedValue(undefined),
    currentVersion: "1.1.21",
    download: vi.fn().mockResolvedValue(undefined),
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
    version: "1.1.22",
    ...overrides,
  } as unknown as Update;
}

describe("AppUpdater", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buttons.length = 0;
    mocks.checkbox = null;
    mocks.modal = null;
    mocks.storeValues.clear();
    mocks.storeGet.mockImplementation((target) =>
      mocks.storeValues.get(target)
    );
    mocks.storeSet.mockImplementation((target, value) => {
      mocks.storeValues.set(target, value);
    });
    mocks.getVersion.mockResolvedValue("1.1.21");
    resetAppUpdaterForTests();
  });

  function renderPreparedUpdate(update: Update): string {
    mocks.useAtom
      .mockReturnValueOnce([true, mocks.setAutoUpdateEnabled])
      .mockReturnValueOnce([true, mocks.setInstallPromptVisible]);
    mocks.useAtomValue
      .mockReturnValueOnce(update)
      .mockReturnValueOnce({ active: false })
      .mockReturnValueOnce(true);
    return renderToStaticMarkup(createElement(AppUpdater));
  }

  function capturedButton(label: string): CapturedButtonProps {
    const button = mocks.buttons.find(
      (candidate) => candidate.children === label
    );
    expect(button, `Missing ${label} button`).toBeDefined();
    return button as CapturedButtonProps;
  }

  it("checks for updates without requiring a browser-exposed Tauri global", async () => {
    const update = createUpdate();
    mocks.check.mockResolvedValue(update);

    await expect(checkForUpdatesManually()).resolves.toBe(update);

    expect(mocks.check).toHaveBeenCalledWith(30_000);
    expect(mocks.messageInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Version 1.1.22 is ready to install.",
        title: "Update available",
      })
    );
  });

  it("clears a stale available update after a failed manual check", async () => {
    const update = createUpdate();
    mocks.check
      .mockResolvedValueOnce(update)
      .mockRejectedValueOnce(new Error("offline"));
    await checkForUpdatesManually();

    await expect(checkForUpdatesManually()).resolves.toBeNull();

    expect(update.close).toHaveBeenCalledOnce();
    expect(mocks.messageError).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Update check failed" })
    );
  });

  it("downloads and asks before installing or relaunching", async () => {
    const update = createUpdate();
    mocks.check.mockResolvedValue(update);

    await installAvailableAppUpdate();

    expect(mocks.check).toHaveBeenCalledOnce();
    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).not.toHaveBeenCalled();
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.storeSet).toHaveBeenLastCalledWith(expect.anything(), true);
  });

  it("surfaces a retry action when the update download times out", async () => {
    const update = createUpdate({
      download: vi.fn().mockRejectedValue(new Error("request timed out")),
    });
    mocks.check.mockResolvedValue(update);

    await installAvailableAppUpdate();

    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(mocks.messageError).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "The download timed out. Check your network or proxy, then retry.",
        duration: 0,
        title: "Update download failed",
        cancel: expect.objectContaining({
          closeOnClick: false,
          label: "Retry",
        }),
      })
    );
  });

  it("renders determinate progress and a collapsible liquid download orb", () => {
    const progress: AppUpdateDownloadProgress = {
      active: true,
      collapsed: true,
      downloadedBytes: 32,
      totalBytes: 100,
      percent: 32,
    };
    const onExpand = vi.fn();

    const noticeMarkup = renderToStaticMarkup(
      createElement(AppUpdateDownloadNoticeContent, { progress })
    );
    const orb = DownloadProgressOrb({ progress, onExpand }) as ReactElement<{
      onClick: () => void;
    }>;
    const orbMarkup = renderToStaticMarkup(orb);

    expect(noticeMarkup).toContain('role="progressbar"');
    expect(noticeMarkup).toContain('aria-valuenow="32"');
    expect(noticeMarkup).toContain("32%");
    expect(orbMarkup).toContain("--download-progress:32%");
    expect(orbMarkup).toContain("Open progress notice");

    orb.props.onClick();
    expect(onExpand).toHaveBeenCalledOnce();
  });

  it("keeps a manually collapsed progress notice closed as download advances", async () => {
    let reportProgress: ((event: DownloadEvent) => void) | undefined;
    let finishDownload: (() => void) | undefined;
    const update = createUpdate({
      download: vi.fn(
        (onEvent) =>
          new Promise<void>((resolve) => {
            reportProgress = onEvent as (event: DownloadEvent) => void;
            finishDownload = resolve;
          })
      ),
    });
    mocks.check.mockResolvedValue(update);
    await checkForUpdatesManually();

    const pendingDownload = installAvailableAppUpdate();
    const progressNotice = mocks.messageInfo.mock.calls.find(
      ([message]) => message.id === "app-update-progress"
    )?.[0];
    expect(progressNotice).toBeDefined();

    progressNotice?.onClose?.();
    const messageCountAfterClose = mocks.messageInfo.mock.calls.length;
    reportProgress?.({ event: "Started", data: { contentLength: 100 } });
    reportProgress?.({ event: "Progress", data: { chunkLength: 50 } });

    expect(mocks.messageInfo).toHaveBeenCalledTimes(messageCountAfterClose);
    expect(mocks.storeSet).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ active: true, collapsed: true })
    );

    finishDownload?.();
    await pendingDownload;
  });

  it("installs and relaunches only after confirmation", async () => {
    const update = createUpdate();
    mocks.check.mockResolvedValue(update);

    await installAvailableAppUpdate();
    await installAvailableAppUpdate({ confirmed: true });

    expect(update.download).toHaveBeenCalledOnce();
    expect(update.install).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });

  it("renders the update choices and wires later and automatic downloads", async () => {
    const update = createUpdate();
    mocks.check.mockResolvedValue(update);
    await installAvailableAppUpdate();

    const markup = renderPreparedUpdate(update);

    expect(markup).toContain("Version 1.1.22 is ready.");
    expect(markup).toContain("Skip this version");
    expect(markup).toContain("Later");
    expect(markup).toContain("Install and restart");
    expect(mocks.modal?.visible).toBe(true);
    expect(mocks.checkbox?.checked).toBe(true);

    mocks.checkbox?.onChange?.(false);
    capturedButton("Later").onClick?.();

    expect(mocks.setAutoUpdateEnabled).toHaveBeenCalledWith(false);
    expect(mocks.setInstallPromptVisible).toHaveBeenCalledWith(false);
    expect(update.install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it("persists a skipped version and closes its update handle", async () => {
    const values = new Map<string, string>();
    const localStorage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      removeItem: vi.fn((key: string) => values.delete(key)),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    };
    vi.stubGlobal("window", { localStorage });
    const update = createUpdate();
    mocks.check.mockResolvedValue(update);
    await installAvailableAppUpdate();
    renderPreparedUpdate(update);

    capturedButton("Skip this version").onClick?.();

    expect(localStorage.setItem).toHaveBeenCalledWith(
      "orgii:updater:skipped-update-version",
      "1.1.22"
    );
    expect(update.close).toHaveBeenCalledOnce();
    expect(mocks.setInstallPromptVisible).toHaveBeenCalledWith(false);
    expect(update.install).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("installs from the dialog only after its primary action is clicked", async () => {
    const update = createUpdate();
    mocks.check.mockResolvedValue(update);
    await installAvailableAppUpdate();
    renderPreparedUpdate(update);

    await capturedButton("Install and restart").onClick?.();

    expect(update.install).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(mocks.setInstallPromptVisible).toHaveBeenCalledWith(false);
  });

  it("keeps one progress notice alive and updates it in place", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const update = createUpdate({
      download: vi.fn(async (onEvent) => {
        const report = onEvent as (event: DownloadEvent) => void;
        report({ event: "Started", data: { contentLength: 100 } });
        report({ event: "Progress", data: { chunkLength: 10 } });
        vi.setSystemTime(12_000);
        report({ event: "Progress", data: { chunkLength: 40 } });
        report({ event: "Finished" });
      }),
    });
    mocks.check.mockResolvedValue(update);

    await installAvailableAppUpdate();

    const progressMessages = mocks.messageInfo.mock.calls.filter(
      ([message]) => message.id === "app-update-progress"
    );
    expect(progressMessages).toHaveLength(4);
    expect(progressMessages[0]?.[0]).toMatchObject({
      duration: 0,
      persistent: true,
      title: "Downloading update…",
    });
    expect(progressMessages[2]?.[0].title).toBe("Downloading update… 50%");
    expect(progressMessages[3]?.[0].title).toBe("Downloading update… 100%");
    expect(mocks.messageRemove).toHaveBeenCalledWith("app-update-progress");
    expect(mocks.relaunch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
