import { useEffect, useState } from "react";

export function useViewportWidth(): number | undefined {
  const [viewportWidth, setViewportWidth] = useState<number | undefined>(() =>
    typeof window !== "undefined" ? window.innerWidth : undefined
  );

  useEffect(() => {
    const handleResize = () => {
      setViewportWidth(window.innerWidth);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return viewportWidth;
}
