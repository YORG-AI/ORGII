import React, {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { getViewportSize } from "@src/util/ui/window/viewport";

import {
  allocateInstanceId,
  cancelPendingClose,
  dismissHoverCard,
  openCard,
  scheduleClose,
  useHoverCardState,
} from "./singletonStore";

export type HoverCardPosition = "bottom-start" | "right-start";

const DEFAULT_MOUSE_ENTER_DELAY_MS = 500;
const DEFAULT_MOUSE_LEAVE_DELAY_MS = 100;
const DEFAULT_POSITION: HoverCardPosition = "bottom-start";
const VIEWPORT_PADDING_PX = 8;
const TRIGGER_GAP_PX = 8;
const CARD_LEAVE_DELAY_MS = 80;

interface HoverCardBaseProps {
  cardId?: string | null;
  children: React.ReactElement;
  position?: HoverCardPosition;
  mouseEnterDelay?: number;
  mouseLeaveDelay?: number;
  renderContent: (cardId: string) => React.ReactNode;
}

interface HoverCardTriggerProps {
  instanceId: number;
  cardId: string;
  position: HoverCardPosition;
  mouseEnterDelay: number;
  mouseLeaveDelay: number;
  children: React.ReactElement;
}

interface HoverCardPortalProps {
  instanceId: number;
  cardId: string;
  position: HoverCardPosition;
  renderContent: (cardId: string) => React.ReactNode;
}

interface HoverCardPanelProps {
  title?: string;
  children: React.ReactNode;
  /** Allow anchored child menus to extend beyond short hover-card panels. */
  allowOverflow?: boolean;
}

interface HoverCardRowProps {
  icon: React.ReactNode;
  children: React.ReactNode;
  iconClassName?: string;
}

type ElementProps = {
  ref?: React.Ref<HTMLElement>;
  onMouseEnter?: (event: React.MouseEvent) => void;
  onMouseLeave?: (event: React.MouseEvent) => void;
  onClick?: (event: React.MouseEvent) => void;
  [key: string]: unknown;
};

function applyRef(
  ref: React.Ref<HTMLElement> | undefined,
  node: HTMLElement | null
): void {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(node);
  } else {
    (ref as React.MutableRefObject<HTMLElement | null>).current = node;
  }
}

function computePortalStyle(
  rect: DOMRect,
  position: HoverCardPosition,
  cardWidth: number,
  cardHeight: number
): React.CSSProperties {
  let top = 0;
  let left = 0;

  const viewport = getViewportSize();

  if (position === "right-start") {
    top = rect.top;
    left = rect.right + TRIGGER_GAP_PX;

    if (
      cardWidth > 0 &&
      left + cardWidth > viewport.width - VIEWPORT_PADDING_PX
    ) {
      const leftSide = rect.left - cardWidth - TRIGGER_GAP_PX;
      if (leftSide >= VIEWPORT_PADDING_PX) {
        left = leftSide;
      }
    }
  } else {
    top = rect.bottom + TRIGGER_GAP_PX;
    left = rect.left;
  }

  if (cardWidth > 0) {
    left = Math.max(
      VIEWPORT_PADDING_PX,
      Math.min(left, viewport.width - cardWidth - VIEWPORT_PADDING_PX)
    );
  }
  if (cardHeight > 0) {
    top = Math.max(
      VIEWPORT_PADDING_PX,
      Math.min(top, viewport.height - cardHeight - VIEWPORT_PADDING_PX)
    );
  }

  return { position: "fixed", top, left, zIndex: 1000 };
}

const HoverCardTrigger: React.FC<HoverCardTriggerProps> = ({
  instanceId,
  cardId,
  position,
  mouseEnterDelay,
  mouseLeaveDelay,
  children,
}) => {
  const triggerRef = useRef<HTMLElement | null>(null);
  const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearEnterTimer = useCallback(() => {
    if (enterTimerRef.current !== null) {
      clearTimeout(enterTimerRef.current);
      enterTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearEnterTimer();
      cancelPendingClose();
      scheduleClose(instanceId, 0);
    };
  }, [clearEnterTimer, instanceId]);

  const openWithDelay = useCallback(() => {
    clearEnterTimer();
    const node = triggerRef.current;
    if (!node) return;
    const run = () => {
      enterTimerRef.current = null;
      const current = triggerRef.current;
      if (!current) return;
      openCard(instanceId, cardId, current.getBoundingClientRect(), position);
    };
    if (mouseEnterDelay <= 0) {
      run();
    } else {
      enterTimerRef.current = setTimeout(run, mouseEnterDelay);
    }
  }, [cardId, clearEnterTimer, instanceId, mouseEnterDelay, position]);

  const handleLeave = useCallback(() => {
    clearEnterTimer();
    scheduleClose(instanceId, mouseLeaveDelay);
  }, [clearEnterTimer, instanceId, mouseLeaveDelay]);

  const originalProps =
    (children.props as ElementProps | undefined) ?? ({} as ElementProps);
  const originalRef = originalProps.ref;

  const composedRef = useCallback(
    (node: HTMLElement | null) => {
      triggerRef.current = node;
      applyRef(originalRef, node);
    },
    [originalRef]
  );

  // eslint-disable-next-line react-hooks/refs -- cloneElement only forwards the composed callback ref for React to invoke during commit; it never reads ref.current during render
  return cloneElement(children, {
    ref: composedRef,
    onMouseEnter: (event: React.MouseEvent) => {
      openWithDelay();
      originalProps.onMouseEnter?.(event);
    },
    onMouseLeave: (event: React.MouseEvent) => {
      handleLeave();
      originalProps.onMouseLeave?.(event);
    },
    onClick: (event: React.MouseEvent) => {
      clearEnterTimer();
      dismissHoverCard();
      originalProps.onClick?.(event);
    },
  } as ElementProps);
};

const HoverCardPortal: React.FC<HoverCardPortalProps> = ({
  instanceId,
  cardId,
  position,
  renderContent,
}) => {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [cardSize, setCardSize] = useState({ width: 0, height: 0 });
  const { triggerRect } = useHoverCardState();

  useLayoutEffect(() => {
    const node = cardRef.current;
    if (!node) return;

    const updateCardSize = () => {
      const rect = node.getBoundingClientRect();
      setCardSize((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height }
      );
    };

    updateCardSize();
    const observer = new ResizeObserver(updateCardSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [cardId]);

  if (!triggerRect) return null;

  const style = computePortalStyle(
    triggerRect,
    position,
    cardSize.width,
    cardSize.height
  );

  return createPortal(
    <div
      ref={cardRef}
      data-hover-card="true"
      style={style}
      onMouseEnter={cancelPendingClose}
      onMouseLeave={() => scheduleClose(instanceId, CARD_LEAVE_DELAY_MS)}
    >
      {renderContent(cardId)}
    </div>,
    document.body
  );
};

export const HoverCardPanel: React.FC<HoverCardPanelProps> = ({
  title,
  children,
  allowOverflow = false,
}) => (
  <div
    className={`w-[280px] rounded-xl border border-border-2 bg-bg-2 p-3 shadow-dropdown ${
      allowOverflow ? "overflow-visible" : "overflow-y-auto"
    }`}
    style={{ maxHeight: `calc(100vh - ${VIEWPORT_PADDING_PX * 2}px)` }}
  >
    {title && (
      <div
        className="mb-2 block max-w-full overflow-hidden text-[13px] font-medium text-ellipsis whitespace-nowrap text-text-1"
        title={title}
      >
        {title}
      </div>
    )}
    <div className="space-y-2">{children}</div>
  </div>
);

export const HoverCardRow: React.FC<HoverCardRowProps> = ({
  icon,
  children,
  iconClassName = "text-text-3",
}) => (
  <div className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2 text-[13px] leading-5 text-text-2">
    <span
      className={`mt-0.5 flex h-4 w-4 items-center justify-center ${iconClassName}`}
    >
      {icon}
    </span>
    <div className="min-w-0">{children}</div>
  </div>
);

const HoverCardBase: React.FC<HoverCardBaseProps> = ({
  cardId,
  children,
  position = DEFAULT_POSITION,
  mouseEnterDelay = DEFAULT_MOUSE_ENTER_DELAY_MS,
  mouseLeaveDelay = DEFAULT_MOUSE_LEAVE_DELAY_MS,
  renderContent,
}) => {
  const [instanceId] = useState(allocateInstanceId);
  const { activeInstanceId } = useHoverCardState();

  if (!cardId || !isValidElement(children)) return children;

  const isActiveOwner = activeInstanceId === instanceId;

  return (
    <>
      <HoverCardTrigger
        instanceId={instanceId}
        cardId={cardId}
        position={position}
        mouseEnterDelay={mouseEnterDelay}
        mouseLeaveDelay={mouseLeaveDelay}
      >
        {children}
      </HoverCardTrigger>
      {isActiveOwner && (
        <HoverCardPortal
          instanceId={instanceId}
          cardId={cardId}
          position={position}
          renderContent={renderContent}
        />
      )}
    </>
  );
};

export default HoverCardBase;
