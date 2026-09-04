// @vitest-environment jsdom
import { act, createElement } from "react";
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

import type { PairingInitOutput } from "@src/api/tauri/mobileRemote";

import MobileRemoteOutdoorPairingDetails from "../MobileRemoteOutdoorPairingDetails";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const mocks = vi.hoisted(() => ({
  copyText: vi.fn<(...args: [string]) => Promise<void>>(),
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { seconds?: number }) =>
      values?.seconds == null ? key : `${key}:${values.seconds}`,
  }),
}));

vi.mock("@src/util/data/clipboard", () => ({ copyText: mocks.copyText }));
vi.mock("@src/components/Message", () => ({
  default: { error: mocks.error, success: mocks.success },
}));

const pairing: PairingInitOutput = {
  pairingCode: "PAIR-1234",
  confirmationPhrase: "ember-delta-coral",
  qrPayload: "https://relay.example.test/orgii/mobile#pair=payload",
  expiresInSeconds: 120,
};

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return button;
}

describe("MobileRemoteOutdoorPairingDetails", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.copyText.mockReset();
    mocks.copyText.mockResolvedValue(undefined);
    mocks.error.mockReset();
    mocks.success.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  async function renderDetails(options?: {
    confirming?: boolean;
    regenerating?: boolean;
    onConfirm?: () => void;
    onRegenerate?: () => void;
  }): Promise<void> {
    await act(async () => {
      root.render(
        createElement(MobileRemoteOutdoorPairingDetails, {
          pairing,
          confirming: options?.confirming ?? false,
          regenerating: options?.regenerating ?? false,
          onConfirm: options?.onConfirm ?? (() => undefined),
          onRegenerate: options?.onRegenerate ?? (() => undefined),
        })
      );
    });
  }

  it("keeps the generated payload visible and copies the exact QR payload", async () => {
    const onConfirm = vi.fn();
    await renderDetails({ onConfirm });

    const payload = container.querySelector<HTMLTextAreaElement>(
      "#mobile-remote-pairing-payload"
    );
    expect(payload?.value).toBe(pairing.qrPayload);
    expect(container.textContent).toContain(pairing.confirmationPhrase);
    expect(container.textContent).toContain("mobileRemote.pairingExpires:120");

    await act(async () => {
      findButton(container, "mobileRemote.copyPairingPayload").click();
    });
    expect(mocks.copyText).toHaveBeenCalledWith(pairing.qrPayload);
    expect(mocks.success).toHaveBeenCalledWith({
      content: "mobileRemote.pairingPayloadCopied",
    });

    act(() => {
      findButton(container, "mobileRemote.confirmPairing").click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps copy retryable after a clipboard failure", async () => {
    mocks.copyText
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValueOnce(undefined);
    await renderDetails();
    const copyButton = findButton(container, "mobileRemote.copyPairingPayload");

    await act(async () => copyButton.click());
    await act(async () => copyButton.click());

    expect(mocks.error).toHaveBeenCalledWith({
      content: "mobileRemote.pairingPayloadCopyFailed",
    });
    expect(mocks.success).toHaveBeenCalledTimes(1);
    expect(mocks.copyText).toHaveBeenCalledTimes(2);
  });

  it("preserves old pairing details but gates stale actions while regenerating", async () => {
    const onRegenerate = vi.fn();
    await renderDetails({ onRegenerate });
    act(() => {
      findButton(container, "mobileRemote.regeneratePairing").click();
    });
    expect(onRegenerate).toHaveBeenCalledTimes(1);

    await renderDetails({ regenerating: true, onRegenerate });
    expect(
      findButton(container, "mobileRemote.copyPairingPayload").disabled
    ).toBe(true);
    expect(findButton(container, "mobileRemote.confirmPairing").disabled).toBe(
      true
    );
    expect(
      container.querySelector<HTMLTextAreaElement>(
        "#mobile-remote-pairing-payload"
      )?.value
    ).toBe(pairing.qrPayload);
  });
});
