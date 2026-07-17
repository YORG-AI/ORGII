/**
 * TypewriterText Component
 *
 * Reveals text character by character (classic typewriter effect).
 * Replaces the old DecryptedText scramble animation, which recomputed a
 * randomized suffix and rebuilt its effect on every animation frame.
 *
 * Performance model:
 * - Time-driven: each frame derives the reveal target from elapsed time, so
 *   dropped frames catch up instead of slowing the animation down.
 * - At most ONE state update per frame, and none once the value settles.
 * - The effect only re-runs when `text` or `speed` changes (streaming
 *   appends continue from the already-revealed position, they never reset).
 */
import React, { useEffect, useRef, useState } from "react";

interface TypewriterTextProps {
  /** The text to reveal */
  text: string;
  /** Reveal speed in milliseconds per character (default: 30) */
  speed?: number;
  /** Custom className */
  className?: string;
}

const TypewriterText: React.FC<TypewriterTextProps> = ({
  text,
  speed = 30,
  className = "",
}) => {
  const [revealedCount, setRevealedCount] = useState(0);
  // Progress survives effect re-runs so a streaming append (longer text)
  // continues typing instead of restarting from the first character.
  const revealedRef = useRef(0);

  useEffect(() => {
    // Shorter text means a different message reused the mount — restart.
    if (revealedRef.current > text.length) {
      revealedRef.current = 0;
    }
    if (revealedRef.current >= text.length) {
      // Already fully revealed (e.g. speed changed after completion) — just
      // ensure the state caught up, asynchronously to keep the effect pure.
      const frameId = requestAnimationFrame(() =>
        setRevealedCount(text.length)
      );
      return () => cancelAnimationFrame(frameId);
    }

    const startCount = revealedRef.current;
    const startTime = performance.now();
    const perChar = Math.max(1, speed);
    let frameId = 0;

    const tick = (now: number) => {
      const target = Math.min(
        text.length,
        startCount + Math.max(1, Math.floor((now - startTime) / perChar))
      );
      if (target !== revealedRef.current) {
        revealedRef.current = target;
        setRevealedCount(target);
      }
      if (target < text.length) {
        frameId = requestAnimationFrame(tick);
      }
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [text, speed]);

  return (
    <span className={className}>
      {text.slice(0, Math.min(revealedCount, text.length))}
    </span>
  );
};

export default TypewriterText;
