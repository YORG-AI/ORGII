const THEME_TRANSITION_COVER_ATTR = "data-orgii-theme-transition-cover";
const THEME_TRANSITION_FADE_MS = 180;
const THEME_TRANSITION_MIN_VISIBLE_MS = 120;

/**
 * Failsafe: the cover blocks pointer events, so it must never be able to
 * outlive a wedged swap. Must exceed swapThemeCss's SWAP_TIMEOUT_MS plus the
 * fade windows so it only fires in genuinely stuck states, never during a
 * legitimately slow swap.
 */
const THEME_TRANSITION_MAX_LIFETIME_MS = 6000;

interface ThemeTransitionCoverHandle {
  hide: () => Promise<void>;
}

const NOOP_HANDLE: ThemeTransitionCoverHandle = {
  hide: async () => {},
};

/**
 * Resolve after two animation frames, or after the fallback timer if frames
 * never come. WKWebView pauses `requestAnimationFrame` for occluded windows
 * (and can leave it dead after system sleep), and an OS-initiated theme
 * switch while the display is off runs exactly in that state — a bare rAF
 * await here used to strand the cover on screen until the next theme change.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timerId);
      resolve();
    };
    const timerId = setTimeout(finish, THEME_TRANSITION_FADE_MS);
    requestAnimationFrame(() => {
      requestAnimationFrame(finish);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getOpaquePageBackground(): string {
  const bodyBackground = getComputedStyle(document.body).backgroundColor;
  if (bodyBackground && bodyBackground !== "rgba(0, 0, 0, 0)") {
    return bodyBackground;
  }

  const rootBackground = getComputedStyle(
    document.documentElement
  ).backgroundColor;
  if (rootBackground && rootBackground !== "rgba(0, 0, 0, 0)") {
    return rootBackground;
  }

  return "#0f1115";
}

export function showThemeTransitionCover(): ThemeTransitionCoverHandle {
  const existing = document.querySelector<HTMLElement>(
    `[${THEME_TRANSITION_COVER_ATTR}]`
  );

  if (existing) {
    return {
      hide: async () => {
        await hideCover(existing, performance.now());
      },
    };
  }

  // Nobody can see a transition on a hidden window, and this is exactly the
  // state (display off / occluded) where rAF and transitions stall — don't
  // create a cover that can only get stuck.
  if (document.visibilityState === "hidden") {
    return NOOP_HANDLE;
  }

  const shownAt = performance.now();
  const currentBackground = getOpaquePageBackground();
  const wrapper = document.createElement("div");
  wrapper.setAttribute(THEME_TRANSITION_COVER_ATTR, "");
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.style.position = "fixed";
  wrapper.style.inset = "0";
  wrapper.style.zIndex = "10050";
  wrapper.style.pointerEvents = "auto";
  wrapper.style.opacity = "1";
  wrapper.style.backgroundColor = currentBackground;
  wrapper.style.backdropFilter = "blur(18px) saturate(1.15)";
  wrapper.style.setProperty(
    "-webkit-backdrop-filter",
    "blur(18px) saturate(1.15)"
  );
  wrapper.style.transition = `opacity ${THEME_TRANSITION_FADE_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`;

  document.body.appendChild(wrapper);

  window.setTimeout(() => {
    wrapper.remove();
  }, THEME_TRANSITION_MAX_LIFETIME_MS);

  return {
    hide: async () => {
      await hideCover(wrapper, shownAt);
    },
  };
}

async function hideCover(wrapper: HTMLElement, shownAt: number): Promise<void> {
  const elapsed = performance.now() - shownAt;
  if (elapsed < THEME_TRANSITION_MIN_VISIBLE_MS) {
    await sleep(THEME_TRANSITION_MIN_VISIBLE_MS - elapsed);
  }
  await nextFrame();
  wrapper.style.opacity = "0";
  // Stop intercepting clicks the moment the fade starts: an invisible cover
  // must not eat input if removal is delayed.
  wrapper.style.pointerEvents = "none";
  await sleep(THEME_TRANSITION_FADE_MS);
  wrapper.remove();
}
