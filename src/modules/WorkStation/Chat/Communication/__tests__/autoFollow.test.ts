/**
 * Regression tests for the streaming auto-follow (stick-to-bottom) decision.
 *
 * Bug: while a turn was streaming, scrolling up to read earlier content was
 * repeatedly dragged back to the bottom because the viewport snapped to the
 * bottom on every delta regardless of the user's scroll position. These tests
 * exercise the pure decision helpers that now gate that snap, matching the
 * pure selection-logic test style used elsewhere in this module (no DOM/render
 * environment required).
 */
import { describe, expect, it } from "vitest";

import {
  AUTO_FOLLOW_THRESHOLD_PX,
  isViewportAtBottom,
  resolveAutoFollowOnScroll,
} from "../MessageViewer/autoFollow";

const CLIENT_HEIGHT = 400;
const SCROLL_HEIGHT = 2000;
const BOTTOM_SCROLL_TOP = SCROLL_HEIGHT - CLIENT_HEIGHT; // 1600

describe("isViewportAtBottom", () => {
  it("treats an exact-bottom viewport as at the bottom", () => {
    expect(
      isViewportAtBottom({
        scrollTop: BOTTOM_SCROLL_TOP,
        scrollHeight: SCROLL_HEIGHT,
        clientHeight: CLIENT_HEIGHT,
      })
    ).toBe(true);
  });

  it("treats a viewport within the threshold as at the bottom", () => {
    expect(
      isViewportAtBottom({
        scrollTop: BOTTOM_SCROLL_TOP - (AUTO_FOLLOW_THRESHOLD_PX - 1),
        scrollHeight: SCROLL_HEIGHT,
        clientHeight: CLIENT_HEIGHT,
      })
    ).toBe(true);
  });

  it("treats a viewport scrolled well above the bottom as not at the bottom", () => {
    expect(
      isViewportAtBottom({
        scrollTop: 200,
        scrollHeight: SCROLL_HEIGHT,
        clientHeight: CLIENT_HEIGHT,
      })
    ).toBe(false);
  });

  it("treats a non-scrollable container as at the bottom", () => {
    expect(
      isViewportAtBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })
    ).toBe(true);
  });
});

describe("resolveAutoFollowOnScroll", () => {
  it("suspends auto-follow when the user scrolls up away from the bottom", () => {
    const following = resolveAutoFollowOnScroll({
      following: true,
      previousScrollTop: BOTTOM_SCROLL_TOP,
      metrics: {
        scrollTop: 800,
        scrollHeight: SCROLL_HEIGHT,
        clientHeight: CLIENT_HEIGHT,
      },
    });
    expect(following).toBe(false);
  });

  it("keeps auto-follow suspended across repeated streaming growth while scrolled up", () => {
    // Simulate content growing (scrollHeight increasing) after the user has
    // scrolled up: follow must stay false so the snap effect leaves them put.
    let following = false;
    let scrollHeight = SCROLL_HEIGHT;
    const userScrollTop = 800;
    for (let delta = 0; delta < 5; delta++) {
      scrollHeight += 500; // more streamed content arrives
      following = resolveAutoFollowOnScroll({
        following,
        previousScrollTop: userScrollTop,
        metrics: {
          scrollTop: userScrollTop, // user has not moved
          scrollHeight,
          clientHeight: CLIENT_HEIGHT,
        },
      });
      expect(following).toBe(false);
    }
  });

  it("re-arms auto-follow once the user returns to the bottom", () => {
    let following = false;
    following = resolveAutoFollowOnScroll({
      following,
      previousScrollTop: 800,
      metrics: {
        scrollTop: BOTTOM_SCROLL_TOP,
        scrollHeight: SCROLL_HEIGHT,
        clientHeight: CLIENT_HEIGHT,
      },
    });
    expect(following).toBe(true);
  });

  it("does not re-arm on a downward scroll that stops short of the bottom", () => {
    const following = resolveAutoFollowOnScroll({
      following: false,
      previousScrollTop: 400,
      metrics: {
        scrollTop: 900, // scrolled down, but still above the bottom
        scrollHeight: SCROLL_HEIGHT,
        clientHeight: CLIENT_HEIGHT,
      },
    });
    expect(following).toBe(false);
  });

  it("stays following while the user sits at the bottom during streaming", () => {
    const following = resolveAutoFollowOnScroll({
      following: true,
      previousScrollTop: BOTTOM_SCROLL_TOP,
      metrics: {
        scrollTop: BOTTOM_SCROLL_TOP,
        scrollHeight: SCROLL_HEIGHT,
        clientHeight: CLIENT_HEIGHT,
      },
    });
    expect(following).toBe(true);
  });
});
