export interface AnimationFrameScheduler {
  schedule: () => void;
  cancel: () => void;
}

interface AnimationFrameSchedulerOptions {
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (frameId: number) => void;
}

/**
 * Coalesces repeated layout invalidations so expensive DOM reads run at most
 * once per animation frame.
 */
export function createAnimationFrameScheduler(
  callback: () => void,
  options: AnimationFrameSchedulerOptions
): AnimationFrameScheduler {
  let pendingFrameId: number | null = null;

  const schedule = () => {
    if (pendingFrameId !== null) return;

    pendingFrameId = options.requestFrame(() => {
      pendingFrameId = null;
      callback();
    });
  };

  const cancel = () => {
    if (pendingFrameId === null) return;

    options.cancelFrame(pendingFrameId);
    pendingFrameId = null;
  };

  return { schedule, cancel };
}
