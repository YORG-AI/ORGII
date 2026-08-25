// @vitest-environment jsdom
import {
  type RefObject,
  act,
  createElement,
  createRef,
  forwardRef,
  useImperativeHandle,
} from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  MAX_OUTPUT_CHANNELS,
  useOutputChannels,
} from "@src/modules/WorkStation/CodeEditor/hooks/output/useOutputChannels";

type OutputController = ReturnType<typeof useOutputChannels>;

// Probe exposes the hook's return value through a ref (the repo pattern for
// hook tests) so no module-level variable is reassigned during render.
const Probe = forwardRef<OutputController>((_props, ref) => {
  const output = useOutputChannels({ defaultMaxChars: 1000 });
  useImperativeHandle(ref, () => output, [output]);
  return null;
});
Probe.displayName = "OutputChannelsProbe";

describe("useOutputChannels bounds", () => {
  let container: HTMLDivElement;
  let root: Root;
  let controllerRef: RefObject<OutputController | null>;
  const controller = () => {
    if (!controllerRef.current) throw new Error("probe not mounted");
    return controllerRef.current;
  };
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    controllerRef = createRef<OutputController>();
    act(() => root.render(createElement(Probe, { ref: controllerRef })));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("drops the oldest non-active channels past MAX_OUTPUT_CHANNELS", () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_OUTPUT_CHANNELS + 4; i++) {
      act(() => {
        ids.push(controller().createChannel(`run ${i}`, "tasks"));
      });
    }
    const remaining = controller().channels.map((c) => c.id);
    expect(remaining).toHaveLength(MAX_OUTPUT_CHANNELS);
    // Newest survive, oldest were evicted.
    expect(remaining).toContain(ids[ids.length - 1]);
    expect(remaining).not.toContain(ids[0]);
  });

  it("debounces sessionStorage writes instead of persisting per append", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    let id = "";
    act(() => {
      id = controller().createChannel("build", "build");
    });
    act(() => {
      controller().appendToChannel(id, "line 1\n");
      controller().appendToChannel(id, "line 2\n");
      controller().appendToChannel(id, "line 3\n");
    });
    // Nothing written synchronously.
    expect(
      setItem.mock.calls.filter(
        ([key]) => key === "orgii_output_channels_history"
      )
    ).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    const writes = setItem.mock.calls.filter(
      ([key]) => key === "orgii_output_channels_history"
    );
    expect(writes).toHaveLength(1);
    expect(String(writes[0][1])).toContain("line 3");
    setItem.mockRestore();
  });
});
