import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

export type AppUpdaterPhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "relaunching"
  | "failed";

export interface AppUpdaterState {
  phase: AppUpdaterPhase;
  update: Update | null;
  downloaded: boolean;
  currentVersion?: string;
  lastCheckStartedAt: number | null;
  error: string | null;
}

export interface AppUpdateCheckResult {
  update: Update | null;
  currentVersion?: string;
  fromCache: boolean;
}

interface AppUpdaterCoordinatorDependencies {
  check: () => Promise<Update | null>;
  downloadTimeoutMs: number;
  getVersion: () => Promise<string>;
  onStateChange: (state: AppUpdaterState) => void;
  minCheckIntervalMs: number;
  now?: () => number;
}

export function createInitialAppUpdaterState(): AppUpdaterState {
  return {
    phase: "idle",
    update: null,
    downloaded: false,
    lastCheckStartedAt: null,
    error: null,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error";
}

/**
 * Owns updater lifecycle state and serializes check/download/install work.
 * UI atoms are projections of this coordinator rather than a second source
 * of truth.
 */
export class AppUpdaterCoordinator {
  private state = createInitialAppUpdaterState();
  private pendingCheck: Promise<AppUpdateCheckResult> | null = null;
  private pendingDownload: Promise<Update | null> | null = null;
  private pendingInstall: Promise<boolean> | null = null;

  constructor(private readonly deps: AppUpdaterCoordinatorDependencies) {}

  getState(): AppUpdaterState {
    return { ...this.state };
  }

  getAvailableUpdate(): Update | null {
    return this.state.update;
  }

  clearAvailableUpdate(): void {
    const update = this.state.update;
    if (update) void update.close().catch(() => undefined);
    this.setState({
      phase: this.state.phase === "failed" ? "failed" : "idle",
      update: null,
      downloaded: false,
    });
  }

  reset(): void {
    const update = this.state.update;
    if (update) void update.close().catch(() => undefined);
    this.pendingCheck = null;
    this.pendingDownload = null;
    this.pendingInstall = null;
    this.state = createInitialAppUpdaterState();
    this.deps.onStateChange(this.getState());
  }

  checkForUpdate(force = false): Promise<AppUpdateCheckResult> {
    if (this.pendingCheck) return this.pendingCheck;

    if (this.pendingDownload || this.pendingInstall) {
      return Promise.resolve(this.cachedCheckResult());
    }

    const now = this.deps.now?.() ?? Date.now();
    if (
      !force &&
      this.state.lastCheckStartedAt !== null &&
      now - this.state.lastCheckStartedAt < this.deps.minCheckIntervalMs
    ) {
      return Promise.resolve(this.cachedCheckResult());
    }

    this.setState({
      phase: "checking",
      lastCheckStartedAt: now,
      error: null,
    });

    const operation = this.runCheck();
    this.pendingCheck = operation;
    void operation.then(
      () => {
        if (this.pendingCheck === operation) this.pendingCheck = null;
      },
      () => {
        if (this.pendingCheck === operation) this.pendingCheck = null;
      }
    );
    return operation;
  }

  downloadAvailableUpdate(
    onEvent?: (event: DownloadEvent) => void
  ): Promise<Update | null> {
    if (this.pendingDownload) return this.pendingDownload;
    if (this.state.downloaded) return Promise.resolve(this.state.update);

    const update = this.state.update;
    if (!update) return Promise.resolve(null);

    this.setState({ phase: "downloading", error: null });
    const operation = update
      .download(onEvent, { timeout: this.deps.downloadTimeoutMs })
      .then(() => {
        this.setState({ phase: "downloaded", downloaded: true });
        return update;
      })
      .catch((error: unknown) => {
        this.setState({ phase: "available", error: errorMessage(error) });
        throw error;
      });

    this.pendingDownload = operation;
    void operation.then(
      () => {
        if (this.pendingDownload === operation) this.pendingDownload = null;
      },
      () => {
        if (this.pendingDownload === operation) this.pendingDownload = null;
      }
    );
    return operation;
  }

  installAvailableUpdate(
    onEvent?: (event: DownloadEvent) => void
  ): Promise<boolean> {
    if (this.pendingInstall) {
      return this.pendingInstall.then(() => false);
    }

    const operation = this.runInstall(onEvent);
    this.pendingInstall = operation;
    void operation.then(
      () => {
        if (this.pendingInstall === operation) this.pendingInstall = null;
      },
      () => {
        if (this.pendingInstall === operation) this.pendingInstall = null;
      }
    );
    return operation;
  }

  private async runCheck(): Promise<AppUpdateCheckResult> {
    try {
      const [currentVersion, checkedUpdate] = await Promise.all([
        this.deps.getVersion().catch(() => undefined),
        this.deps.check(),
      ]);
      const update = await this.replaceCheckedUpdate(checkedUpdate);
      const downloaded = Boolean(
        update &&
        this.state.update === update &&
        this.state.downloaded &&
        update.version === checkedUpdate?.version
      );

      this.setState({
        phase: update
          ? downloaded
            ? "downloaded"
            : "available"
          : "up-to-date",
        update,
        downloaded,
        currentVersion,
        error: null,
      });

      return { update, currentVersion, fromCache: false };
    } catch (error) {
      this.setState({ phase: "failed", error: errorMessage(error) });
      throw error;
    }
  }

  private async replaceCheckedUpdate(
    checkedUpdate: Update | null
  ): Promise<Update | null> {
    const current = this.state.update;
    if (current === checkedUpdate) return current;

    if (
      current &&
      checkedUpdate &&
      this.state.downloaded &&
      current.version === checkedUpdate.version
    ) {
      await checkedUpdate.close().catch(() => undefined);
      return current;
    }

    if (current) await current.close().catch(() => undefined);
    return checkedUpdate;
  }

  private async runInstall(
    onEvent?: (event: DownloadEvent) => void
  ): Promise<boolean> {
    if (this.pendingDownload) await this.pendingDownload;
    const update = this.state.update;
    if (!update) return false;

    this.setState({ phase: "installing", error: null });
    try {
      if (this.state.downloaded) {
        await update.install();
      } else {
        await update.downloadAndInstall(onEvent, {
          timeout: this.deps.downloadTimeoutMs,
        });
      }
      this.setState({ phase: "relaunching" });
      return true;
    } catch (error) {
      this.setState({
        phase: this.state.downloaded ? "downloaded" : "available",
        error: errorMessage(error),
      });
      throw error;
    }
  }

  private cachedCheckResult(): AppUpdateCheckResult {
    return {
      update: this.state.update,
      currentVersion: this.state.currentVersion,
      fromCache: true,
    };
  }

  private setState(update: Partial<AppUpdaterState>): void {
    this.state = { ...this.state, ...update };
    this.deps.onStateChange(this.getState());
  }
}
