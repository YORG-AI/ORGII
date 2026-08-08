import { useEffect, useState } from "react";

export function useViewportWidth(): number | undefined {
  const [viewportWidth, setViewportWidth] = useState<number | undefined>(() =>
    typeof window !== "undefined" ? window.innerWidth : undefined
  );

  useEffect(() => {
    let frameId: number | null = null;

    const handleResize = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        setViewportWidth(window.innerWidth);
      });
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, []);

  return viewportWidth;
}
