// @vitest-environment jsdom
import { act } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import Message from "@src/components/Message";

// framer-motion drives its enter animation from rAF; jsdom has rAF but the
// motion values never settle in tests, so stub the animation primitives with
// plain elements. The point of this test is the lazy module boundary, not
// the animation.
vi.mock("framer-motion", async () => {
  const React = await import("react");
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    motion: new Proxy(
      {},
      {
        get: (_target, tag: string) =>
          // eslint-disable-next-line react/display-name
          React.forwardRef<HTMLElement, Record<string, unknown>>(
            (props, ref) => {
              // Drop the animation-only props so they don't hit the DOM.
              const {
                initial: _initial,
                animate: _animate,
                exit: _exit,
                transition: _transition,
                ...rest
              } = props;
              return React.createElement(tag, { ...rest, ref });
            }
          ),
      }
    ),
  };
});

async function waitForToastText(text: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const root = document.querySelector("[data-message-root]");
    if (root?.textContent?.includes(text)) return;
  }
  throw new Error(`toast "${text}" did not render within ${timeoutMs}ms`);
}

describe("Message (lazy toast container)", () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    act(() => Message.destroy());
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("renders a toast once the lazily loaded container resolves", async () => {
    let id = "";
    await act(async () => {
      id = Message.success("saved ok", { duration: 0 });
    });
    expect(id).not.toBe("");

    // Let the lazy `import("./MessageContainer")` settle and re-render.
    await waitForToastText("saved ok");
    const root = document.querySelector("[data-message-root]");
    expect(root).not.toBeNull();
    expect(root?.textContent).toContain("saved ok");
  });

  it("removes toasts and the container on destroy", async () => {
    await act(async () => {
      Message.info("temporary", { duration: 0 });
    });
    await waitForToastText("temporary");
    act(() => Message.destroy());
    expect(document.querySelector("[data-message-root]")).toBeNull();
  });
});
