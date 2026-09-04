import React, { useCallback, useEffect, useRef } from "react";

import { CODEMIRROR_STYLE_NONCE } from "@src/features/CodeMirror/config/nonce";
import { HugeiconsIcon, type IconSvgElement } from "@src/icons";

type AnimationStrategy =
  | "stroke-draw"
  | "spring-rotate"
  | "bounce-settle"
  | "blink-eyes"
  | "shift-piece"
  | "sparkle-fill"
  | "wiggle"
  | "stagger-fade"
  | "stagger-bars"
  | "search-bounce"
  | "squeeze-chevrons";

const ICON_STRATEGY: Record<string, AnimationStrategy> = {
  home: "stroke-draw",
  inbox: "stroke-draw",
  "book-open": "wiggle",
  "chevrons-left-right-ellipsis": "stroke-draw",
  settings: "spring-rotate",
  "list-filter": "stagger-fade",
  gauge: "stagger-bars",
  plus: "stroke-draw",
  radar: "stagger-bars",
  "square-mouse-pointer": "stroke-draw",
  "folder-git-2": "stroke-draw",
  "badge-cent": "stroke-draw",
  house: "stroke-draw",
  box: "stroke-draw",
  "shopping-cart": "stroke-draw",
  "shopping-bag": "stroke-draw",
  blocks: "shift-piece",
  store: "stroke-draw",
  bot: "blink-eyes",
  "package-check": "stroke-draw",
  "bar-chart-3": "stagger-bars",
  wallet: "stroke-draw",
  "id-card": "stroke-draw",
  "wand-2": "stroke-draw",
  "circle-dollar-sign": "stroke-draw",
  airplay: "stroke-draw",
  "map-pin": "bounce-settle",
  sparkles: "sparkle-fill",
  search: "search-bounce",
  "search-code": "search-bounce",
  "list-todo": "stroke-draw",
  database: "stroke-draw",
  "git-branch": "stroke-draw",
  play: "stroke-draw",
  globe: "wiggle",
  terminal: "stroke-draw",
  "code-2": "stroke-draw",
};

function getStrategy(iconName?: string): AnimationStrategy {
  if (!iconName) return "stroke-draw";
  return ICON_STRATEGY[iconName.trim().toLowerCase()] ?? "stroke-draw";
}

const STYLE_ID = "sidebar-hover-icon-styles";

const KEYFRAMES_CSS = `
@keyframes sidebar-spring-rotate {
  0% { transform: rotate(0deg); }
  30% { transform: rotate(60deg); }
  85% { transform: rotate(175deg); }
  100% { transform: rotate(180deg); }
}
@keyframes sidebar-bounce-settle {
  0% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
  100% { transform: translateY(-2px); }
}
@keyframes sidebar-wiggle {
  0% { transform: scale(1) rotate(0deg) translateY(0); }
  20% { transform: scale(1.06) rotate(-6deg) translateY(-1.5px); }
  50% { transform: scale(1.06) rotate(6deg) translateY(-1.5px); }
  80% { transform: scale(1.06) rotate(-6deg) translateY(-1.5px); }
  100% { transform: scale(1) rotate(0deg) translateY(0); }
}
@keyframes sidebar-search-bounce {
  0% { transform: translate(0, 0); }
  25% { transform: translate(0, -3px); }
  50% { transform: translate(-2px, 0); }
  100% { transform: translate(0, 0); }
}
@keyframes sidebar-sparkle-bounce {
  0% { transform: translateY(0); }
  40% { transform: translateY(-1.5px); }
  100% { transform: translateY(0); }
}
@keyframes sidebar-blink {
  0% { transform: scaleY(1); }
  40% { transform: scaleY(0.1); }
  100% { transform: scaleY(1); }
}
@keyframes sidebar-squeeze-left {
  0% { transform: translateX(0); }
  40% { transform: translateX(2px); }
  70% { transform: translateX(-0.5px); }
  100% { transform: translateX(0); }
}
@keyframes sidebar-squeeze-right {
  0% { transform: translateX(0); }
  40% { transform: translateX(-2px); }
  70% { transform: translateX(0.5px); }
  100% { transform: translateX(0); }
}
`;

function injectStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.setAttribute("nonce", CODEMIRROR_STYLE_NONCE);
  style.textContent = KEYFRAMES_CSS;
  document.head.appendChild(style);
}

function restartCssAnimation(
  element: HTMLElement | SVGElement,
  animationCss: string
) {
  element.style.animation = "none";
  void (element as HTMLElement).offsetHeight;
  element.style.animation = animationCss;
}

function getGeometryElements(svgElement: SVGSVGElement): SVGGeometryElement[] {
  const elements = svgElement.querySelectorAll(
    "path, line, circle, rect, polyline, polygon, ellipse"
  );
  return Array.from(elements).filter(
    (el): el is SVGGeometryElement => el instanceof SVGGeometryElement
  );
}

function animateStrokeDraw(svgElement: SVGSVGElement) {
  const shapes = getGeometryElements(svgElement);
  shapes.forEach((shape, index) => {
    let totalLength: number;
    try {
      totalLength = shape.getTotalLength();
    } catch {
      return;
    }
    if (totalLength === 0) return;

    shape.style.transition = "none";
    shape.setAttribute("stroke-dasharray", String(totalLength));
    shape.setAttribute("stroke-dashoffset", String(totalLength));
    shape.style.opacity = "0";

    const delay = index * 60;
    setTimeout(() => {
      shape.style.transition = `stroke-dashoffset 400ms cubic-bezier(0.4, 0, 0.2, 1), opacity 150ms ease`;
      shape.setAttribute("stroke-dashoffset", "0");
      shape.style.opacity = "1";
    }, delay);

    setTimeout(() => {
      shape.style.transition = "";
      shape.removeAttribute("stroke-dasharray");
      shape.removeAttribute("stroke-dashoffset");
      shape.style.opacity = "";
    }, delay + 450);
  });
}

function animateSpringRotate(wrapperElement: HTMLElement) {
  wrapperElement.style.transformOrigin = "center";
  restartCssAnimation(
    wrapperElement,
    "sidebar-spring-rotate 650ms cubic-bezier(0.22, 1, 0.36, 1) 1 forwards"
  );
}

function animateBounceSettle(
  wrapperElement: HTMLElement,
  svgElement: SVGSVGElement
) {
  restartCssAnimation(
    wrapperElement,
    "sidebar-bounce-settle 500ms cubic-bezier(0.22, 1, 0.36, 1) 1 forwards"
  );

  const circles = svgElement.querySelectorAll("circle");
  circles.forEach((circle) => {
    if (!(circle instanceof SVGGeometryElement)) return;
    let totalLength: number;
    try {
      totalLength = circle.getTotalLength();
    } catch {
      return;
    }
    if (totalLength === 0) return;

    circle.style.transition = "none";
    circle.setAttribute("stroke-dasharray", String(totalLength));
    circle.setAttribute("stroke-dashoffset", String(totalLength * 0.5));
    circle.style.opacity = "0";

    setTimeout(() => {
      circle.style.transition =
        "stroke-dashoffset 500ms cubic-bezier(0.4, 0, 0.2, 1), opacity 100ms ease";
      circle.setAttribute("stroke-dashoffset", "0");
      circle.style.opacity = "1";
    }, 250);

    setTimeout(() => {
      circle.style.transition = "";
      circle.removeAttribute("stroke-dasharray");
      circle.removeAttribute("stroke-dashoffset");
      circle.style.opacity = "";
    }, 800);
  });
}

function animateBlinkEyes(svgElement: SVGSVGElement) {
  const allShapes = getGeometryElements(svgElement);

  const eyeElements = allShapes.filter((el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "line") return true;
    if (tag === "circle") {
      const r = parseFloat(el.getAttribute("r") || "0");
      return r > 0 && r <= 3;
    }
    return false;
  });

  eyeElements.forEach((el) => {
    el.style.transformOrigin = "center";
    el.style.transformBox = "fill-box";
    restartCssAnimation(
      el as unknown as HTMLElement,
      "sidebar-blink 400ms ease-in-out 1"
    );
  });
}

function animateShiftPiece(svgElement: SVGSVGElement) {
  const paths = svgElement.querySelectorAll("path, rect");
  const movable = paths.length > 1 ? paths[paths.length - 1] : null;
  if (!movable) return;

  const el = movable as unknown as HTMLElement;
  el.style.transition = "transform 250ms cubic-bezier(0.22, 1, 0.36, 1)";
  el.style.transform = "translate(-3px, 3px)";

  setTimeout(() => {
    el.style.transform = "translate(0, 0)";
  }, 250);

  setTimeout(() => {
    el.style.transition = "";
    el.style.transform = "";
  }, 550);
}

function animateSparkleFill(
  wrapperElement: HTMLElement,
  svgElement: SVGSVGElement
) {
  restartCssAnimation(
    wrapperElement,
    "sidebar-sparkle-bounce 700ms ease-in-out 1"
  );

  const paths = svgElement.querySelectorAll("path");
  if (paths.length === 0) return;

  const mainShape = paths[0] as unknown as HTMLElement;
  mainShape.style.transition = "fill 300ms ease-in-out";
  mainShape.style.fill = "currentColor";

  setTimeout(() => {
    mainShape.style.fill = "none";
  }, 400);

  setTimeout(() => {
    mainShape.style.transition = "";
    mainShape.style.fill = "";
  }, 750);

  const starPaths = Array.from(paths).slice(1);
  starPaths.forEach((sp) => {
    const spEl = sp as unknown as HTMLElement;
    spEl.style.transition = "opacity 200ms ease";
    setTimeout(() => {
      spEl.style.opacity = "0";
    }, 500);
    setTimeout(() => {
      spEl.style.opacity = "1";
    }, 800);
    setTimeout(() => {
      spEl.style.opacity = "0";
    }, 1100);
    setTimeout(() => {
      spEl.style.opacity = "1";
      spEl.style.transition = "";
    }, 1400);
  });
}

function animateWiggle(wrapperElement: HTMLElement) {
  wrapperElement.style.transformOrigin = "center";
  restartCssAnimation(wrapperElement, "sidebar-wiggle 600ms ease-in-out 1");
}

function animateStaggerFade(svgElement: SVGSVGElement) {
  const shapes = getGeometryElements(svgElement);

  shapes.forEach((shape, index) => {
    const el = shape as unknown as HTMLElement;
    el.style.transition = "opacity 200ms ease-out";
    el.style.opacity = "0";

    setTimeout(
      () => {
        el.style.transition = "opacity 300ms cubic-bezier(0.22, 1, 0.36, 1)";
        el.style.opacity = "1";
      },
      200 + index * 80
    );

    setTimeout(
      () => {
        el.style.transition = "";
        el.style.opacity = "";
      },
      200 + index * 80 + 350
    );
  });
}

function animateStaggerBars(svgElement: SVGSVGElement) {
  const shapes = getGeometryElements(svgElement);
  const barShapes = shapes.slice(1);

  barShapes.forEach((shape, index) => {
    let totalLength: number;
    try {
      totalLength = shape.getTotalLength();
    } catch {
      return;
    }
    if (totalLength === 0) return;

    shape.style.transition = "none";
    shape.setAttribute("stroke-dasharray", String(totalLength));
    shape.setAttribute("stroke-dashoffset", String(totalLength));
    shape.style.opacity = "0";

    const delay = 100 + index * 100;
    setTimeout(() => {
      shape.style.transition =
        "stroke-dashoffset 350ms cubic-bezier(0.4, 0, 0.2, 1), opacity 150ms ease";
      shape.setAttribute("stroke-dashoffset", "0");
      shape.style.opacity = "1";
    }, delay);

    setTimeout(() => {
      shape.style.transition = "";
      shape.removeAttribute("stroke-dasharray");
      shape.removeAttribute("stroke-dashoffset");
      shape.style.opacity = "";
    }, delay + 400);
  });
}

function animateSqueezeChevrons(svgElement: SVGSVGElement) {
  const paths = svgElement.querySelectorAll("path");
  if (paths.length < 2) return;

  const leftChevron = paths[0] as unknown as HTMLElement;
  const rightChevron = paths[paths.length - 1] as unknown as HTMLElement;

  restartCssAnimation(
    leftChevron,
    "sidebar-squeeze-left 450ms cubic-bezier(0.22, 1, 0.36, 1) 1"
  );
  restartCssAnimation(
    rightChevron,
    "sidebar-squeeze-right 450ms cubic-bezier(0.22, 1, 0.36, 1) 1"
  );
}

function animateSearchBounce(wrapperElement: HTMLElement) {
  restartCssAnimation(
    wrapperElement,
    "sidebar-search-bounce 700ms cubic-bezier(0.22, 1, 0.36, 1) 1"
  );
}

function runAnimation(
  strategy: AnimationStrategy,
  wrapperElement: HTMLElement,
  svgElement: SVGSVGElement
) {
  switch (strategy) {
    case "stroke-draw":
      animateStrokeDraw(svgElement);
      break;
    case "spring-rotate":
      animateSpringRotate(wrapperElement);
      break;
    case "bounce-settle":
      animateBounceSettle(wrapperElement, svgElement);
      break;
    case "blink-eyes":
      animateBlinkEyes(svgElement);
      break;
    case "shift-piece":
      animateShiftPiece(svgElement);
      break;
    case "sparkle-fill":
      animateSparkleFill(wrapperElement, svgElement);
      break;
    case "wiggle":
      animateWiggle(wrapperElement);
      break;
    case "stagger-fade":
      animateStaggerFade(svgElement);
      break;
    case "stagger-bars":
      animateStaggerBars(svgElement);
      break;
    case "search-bounce":
      animateSearchBounce(wrapperElement);
      break;
    case "squeeze-chevrons":
      animateSqueezeChevrons(svgElement);
      break;
  }
}

/**
 * Trigger animation on an icon wrapper found inside a container element.
 * Call from the parent row's onMouseEnter to animate on full-row hover.
 */
export function triggerIconAnimation(containerElement: HTMLElement) {
  const wrapper = containerElement.querySelector<HTMLElement>(
    "[data-icon-wrapper]"
  );
  if (!wrapper) return;

  const svgElement = wrapper.querySelector("svg");
  if (!svgElement) return;

  const iconName = wrapper.getAttribute("data-icon-wrapper") || undefined;
  const strategy = getStrategy(iconName);
  runAnimation(strategy, wrapper, svgElement);
}

interface HoverAnimatedIconProps {
  /** Static hugeicons glyph data — every caller passes an `@src/icons` import. */
  icon: IconSvgElement;
  iconName?: string;
  size?: number;
  strokeWidth?: number;
  color?: string;
  className?: string;
  triggerToken?: number;
}

export default function HoverAnimatedIcon({
  icon,
  iconName,
  size = 14,
  strokeWidth = 2,
  color,
  className,
  triggerToken = 0,
}: HoverAnimatedIconProps): React.ReactElement {
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const previousTriggerTokenRef = useRef<number>(triggerToken);

  useEffect(() => {
    injectStyles();
  }, []);

  const triggerAnimation = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const svgElement = wrapper.querySelector("svg");
    if (!svgElement) return;

    const strategy = getStrategy(iconName);
    runAnimation(strategy, wrapper, svgElement);
  }, [iconName]);

  const handleMouseEnter = useCallback(() => {
    triggerAnimation();
  }, [triggerAnimation]);

  useEffect(() => {
    if (triggerToken === previousTriggerTokenRef.current) return;
    previousTriggerTokenRef.current = triggerToken;
    triggerAnimation();
  }, [triggerAnimation, triggerToken]);

  return (
    <span
      ref={wrapperRef}
      className="inline-flex items-center justify-center"
      data-icon-wrapper={iconName || ""}
      onMouseEnter={handleMouseEnter}
    >
      <HugeiconsIcon
        icon={icon}
        size={size}
        strokeWidth={strokeWidth}
        color={color}
        className={className}
      />
    </span>
  );
}
