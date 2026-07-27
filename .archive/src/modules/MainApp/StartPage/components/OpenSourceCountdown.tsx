/**
 * OpenSourceCountdown
 *
 * Counts down to the open-source release date and renders the remaining
 * time as "Open source in [d/h/m/s]".
 */
import React, { useEffect, useState } from "react";

const RELEASE_DATE = new Date("2026-06-14T12:00:00").getTime();

function getRemaining(): {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
} {
  const diff = Math.max(0, RELEASE_DATE - Date.now());
  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return { days, hours, minutes, seconds };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

const OpenSourceCountdown: React.FC = () => {
  const [remaining, setRemaining] = useState(getRemaining);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setRemaining(getRemaining());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const formatted = `${pad(remaining.days)}d ${pad(remaining.hours)}h ${pad(remaining.minutes)}m ${pad(remaining.seconds)}s`;

  return (
    <div className="mb-8 text-center text-3xl font-semibold text-text-1">
      Open source in {formatted}
    </div>
  );
};

export default OpenSourceCountdown;
