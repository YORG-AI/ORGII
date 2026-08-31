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
} from "vitest";

import PersonAvatar, { personAvatarInitial } from ".";

describe("personAvatarInitial", () => {
  it("upper-cases the leading character", () => {
    expect(personAvatarInitial("ada lovelace")).toBe("A");
  });

  it("ignores surrounding whitespace", () => {
    expect(personAvatarInitial("   harry ")).toBe("H");
  });

  it("keeps an astral-plane leading character whole", () => {
    expect(personAvatarInitial("𝒜lan")).toBe("𝒜");
  });

  it("falls back to a placeholder for an empty name", () => {
    expect(personAvatarInitial("   ")).toBe("?");
  });
});

describe("PersonAvatar", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("renders the initial over a gradient seeded by the name", () => {
    act(() => {
      root.render(createElement(PersonAvatar, { name: "Ada Lovelace" }));
    });

    const avatar = container.firstElementChild as HTMLElement | null;
    expect(avatar?.className).toContain("bg-gradient-to-br");
    expect(avatar?.textContent).toBe("A");
  });

  it("gives the same person the same gradient on every surface", () => {
    const gradientFor = (size: number): string => {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const hostRoot = createRoot(host);
      act(() => {
        hostRoot.render(
          createElement(PersonAvatar, { name: "Ada Lovelace", size })
        );
      });
      const className = (host.firstElementChild as HTMLElement).className;
      act(() => hostRoot.unmount());
      host.remove();
      return className;
    };

    expect(gradientFor(20)).toBe(gradientFor(28));
  });

  it("prefers the profile image when one exists", () => {
    act(() => {
      root.render(
        createElement(PersonAvatar, {
          name: "Ada Lovelace",
          src: "https://example.com/ada.png",
        })
      );
    });

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/ada.png"
    );
  });

  it("renders a caller-supplied glyph instead of an initial", () => {
    act(() => {
      root.render(
        createElement(PersonAvatar, { name: "Agent", fallback: "✦" })
      );
    });

    expect(container.firstElementChild?.textContent).toBe("✦");
  });

  it("uses the neutral fill for an unnamed person", () => {
    act(() => {
      root.render(createElement(PersonAvatar, { name: "" }));
    });

    const avatar = container.firstElementChild as HTMLElement | null;
    expect(avatar?.className).not.toContain("bg-gradient-to-br");
    expect(avatar?.className).toContain("bg-fill-3");
  });
  it("uses a domain identity colour instead of the derived gradient", () => {
    act(() => {
      root.render(
        createElement(PersonAvatar, { name: "Ada Lovelace", color: "#3b82f6" })
      );
    });

    const avatar = container.firstElementChild as HTMLElement | null;
    // The gradient paints a background-image; an inline background-color
    // cannot override one, so the gradient class must be absent entirely.
    expect(avatar?.className).not.toContain("bg-gradient-to-br");
    expect(avatar?.style.backgroundColor).toBe("rgb(59, 130, 246)");
    expect(avatar?.textContent).toBe("A");
  });
});
