import { type TrailPanelSize } from "./trailPanelSize";
import { useTrailPanelResize } from "./useTrailPanelResize";

interface TrailPanelResizeHandleProps {
  label: string;
  min: TrailPanelSize;
  max: TrailPanelSize;
  onResize: (size: TrailPanelSize) => void;
  onResizeEnd: (size: TrailPanelSize) => void;
  onResizingChange: (resizing: boolean) => void;
}

/** Shared bottom-left grip; arrow keys resize too (Shift takes larger steps). */
export function TrailPanelResizeHandle({
  label,
  ...options
}: TrailPanelResizeHandleProps) {
  const handlers = useTrailPanelResize(options);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...handlers}
      className="absolute bottom-0 left-0 z-40 flex h-5 w-5 cursor-nesw-resize touch-none items-center justify-center rounded-tr rounded-bl-xl text-text-3 select-none hover:text-primary-6 focus-visible:ring-2 focus-visible:ring-primary-6 focus-visible:outline-none focus-visible:ring-inset"
    >
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
      >
        <path
          d="m3 5 8 8M3 9l4 4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
