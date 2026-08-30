import { describe, expect, it } from "vitest";

import {
  NATIVE_HTML_TAGS,
  getElementDescription,
  getElementKind,
  isNativeElement,
} from "../isNativeElement";

// ---------------------------------------------------------------------------
// Minimal mock helpers — no real DOM required
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

function makeElement(
  tagName: string,
  namespaceURI: string | null = null
): Element {
  return {
    tagName,
    namespaceURI,
  } as unknown as Element;
}

function makeHtmlElement(tag: string): Element {
  return makeElement(tag.toUpperCase());
}

function makeSvgElement(tag: string): Element {
  return makeElement(tag.toUpperCase(), SVG_NS);
}

function makeCustomElement(tag: string): Element {
  return makeElement(tag.toUpperCase());
}

// ---------------------------------------------------------------------------
// NATIVE_HTML_TAGS
// ---------------------------------------------------------------------------

describe("NATIVE_HTML_TAGS", () => {
  it("is a ReadonlySet", () => {
    expect(NATIVE_HTML_TAGS).toBeInstanceOf(Set);
  });

  it("contains common structural tags", () => {
    const required = ["div", "span", "p", "a", "button", "input", "form"];
    required.forEach((tag) => {
      expect(NATIVE_HTML_TAGS.has(tag)).toBe(true);
    });
  });

  it("contains all heading levels", () => {
    ["h1", "h2", "h3", "h4", "h5", "h6"].forEach((tag) => {
      expect(NATIVE_HTML_TAGS.has(tag)).toBe(true);
    });
  });

  it("contains table elements", () => {
    ["table", "thead", "tbody", "tfoot", "tr", "td", "th"].forEach((tag) => {
      expect(NATIVE_HTML_TAGS.has(tag)).toBe(true);
    });
  });

  it("contains media elements", () => {
    ["video", "audio", "img", "source", "track", "picture"].forEach((tag) => {
      expect(NATIVE_HTML_TAGS.has(tag)).toBe(true);
    });
  });

  it("contains form-related elements", () => {
    ["select", "option", "textarea", "fieldset", "legend", "label"].forEach(
      (tag) => {
        expect(NATIVE_HTML_TAGS.has(tag)).toBe(true);
      }
    );
  });

  it("does not contain custom-element-style tags", () => {
    expect(NATIVE_HTML_TAGS.has("my-component")).toBe(false);
    expect(NATIVE_HTML_TAGS.has("x-button")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getElementKind
// ---------------------------------------------------------------------------

describe("getElementKind", () => {
  describe("native HTML elements", () => {
    it.each([
      "div",
      "span",
      "p",
      "a",
      "button",
      "input",
      "section",
      "article",
      "header",
      "footer",
      "main",
      "nav",
      "ul",
      "li",
      "table",
      "tr",
      "td",
      "form",
      "select",
      "textarea",
      "canvas",
      "script",
      "template",
    ])("classifies <%s> as native", (tag) => {
      expect(getElementKind(makeHtmlElement(tag))).toBe("native");
    });
  });

  describe("custom Web Component elements", () => {
    it.each([
      "my-component",
      "x-button",
      "app-header",
      "cursor-tooltip",
      "wc-modal",
    ])("classifies <%s> as custom-element", (tag) => {
      expect(getElementKind(makeCustomElement(tag))).toBe("custom-element");
    });
  });

  describe("SVG elements", () => {
    it.each(["svg", "circle", "rect", "path", "g", "line", "text", "use"])(
      "classifies SVG <%s> as svg",
      (tag) => {
        expect(getElementKind(makeSvgElement(tag))).toBe("svg");
      }
    );

    it("prioritises SVG namespace over tag name for <svg>", () => {
      expect(getElementKind(makeSvgElement("svg"))).toBe("svg");
    });
  });

  describe("unknown elements", () => {
    it("classifies unrecognised non-hyphen tags as unknown", () => {
      expect(getElementKind(makeHtmlElement("blink"))).toBe("unknown");
      expect(getElementKind(makeHtmlElement("marquee"))).toBe("unknown");
      expect(getElementKind(makeHtmlElement("xmp"))).toBe("unknown");
    });
  });

  describe("tag name casing", () => {
    it("handles uppercase tagName from DOM (browsers return uppercase)", () => {
      expect(getElementKind(makeElement("DIV"))).toBe("native");
      expect(getElementKind(makeElement("BUTTON"))).toBe("native");
    });

    it("handles mixed-case custom element tagName", () => {
      // Custom elements with a hyphen are normalised to lowercase before check
      expect(getElementKind(makeElement("MY-COMPONENT"))).toBe(
        "custom-element"
      );
    });
  });
});

// ---------------------------------------------------------------------------
// isNativeElement
// ---------------------------------------------------------------------------

describe("isNativeElement", () => {
  it("returns true for native HTML elements", () => {
    expect(isNativeElement(makeHtmlElement("div"))).toBe(true);
    expect(isNativeElement(makeHtmlElement("span"))).toBe(true);
    expect(isNativeElement(makeHtmlElement("input"))).toBe(true);
  });

  it("returns false for custom elements", () => {
    expect(isNativeElement(makeCustomElement("my-widget"))).toBe(false);
  });

  it("returns false for SVG elements", () => {
    expect(isNativeElement(makeSvgElement("circle"))).toBe(false);
  });

  it("returns false for unknown tags", () => {
    expect(isNativeElement(makeHtmlElement("blink"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getElementDescription
// ---------------------------------------------------------------------------

describe("getElementDescription", () => {
  it("describes a native element correctly", () => {
    expect(getElementDescription(makeHtmlElement("div"))).toBe(
      "<div> (native)"
    );
    expect(getElementDescription(makeHtmlElement("button"))).toBe(
      "<button> (native)"
    );
  });

  it("describes a custom element correctly", () => {
    expect(getElementDescription(makeCustomElement("my-component"))).toBe(
      "<my-component> (custom element)"
    );
  });

  it("describes an SVG element correctly", () => {
    expect(getElementDescription(makeSvgElement("circle"))).toBe(
      "<circle> (SVG)"
    );
    expect(getElementDescription(makeSvgElement("svg"))).toBe("<svg> (SVG)");
  });

  it("describes an unknown element correctly", () => {
    expect(getElementDescription(makeHtmlElement("blink"))).toBe(
      "<blink> (unknown)"
    );
  });

  it("always uses lowercase tag names in the output", () => {
    // Browsers return tagName in uppercase; the description must still be lowercase
    const result = getElementDescription(makeElement("DIV"));
    expect(result).toBe("<div> (native)");
  });

  it("formats the description as <tag> (label)", () => {
    const result = getElementDescription(makeHtmlElement("p"));
    expect(result).toMatch(/^<[a-z-]+> \(.+\)$/);
  });
});

// ---------------------------------------------------------------------------
// Edge / boundary cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles the <template> element (scripting/templates category)", () => {
    expect(getElementKind(makeHtmlElement("template"))).toBe("native");
  });

  it("handles <slot> (scripting/templates category)", () => {
    expect(getElementKind(makeHtmlElement("slot"))).toBe("native");
  });

  it("handles <canvas>", () => {
    expect(isNativeElement(makeHtmlElement("canvas"))).toBe(true);
  });

  it("handles <dialog>", () => {
    expect(isNativeElement(makeHtmlElement("dialog"))).toBe(true);
  });

  it("handles <details> and <summary>", () => {
    expect(isNativeElement(makeHtmlElement("details"))).toBe(true);
    expect(isNativeElement(makeHtmlElement("summary"))).toBe(true);
  });

  it("a single-word unrecognised tag is unknown, not custom-element", () => {
    // Custom elements MUST contain a hyphen per spec
    expect(getElementKind(makeHtmlElement("foobar"))).toBe("unknown");
  });

  it("a hyphenated SVG element is classified as svg (namespace wins)", () => {
    // Hypothetical SVG extension element — namespace should take priority
    expect(getElementKind(makeSvgElement("my-svg-ext"))).toBe("svg");
  });
});
