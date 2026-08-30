import { useEffect, useState } from "react";

const CountdownTimer = ({
  minutes,
  onCountdownEnd,
  color,
}: {
  minutes: number;
  onCountdownEnd?: () => void;
  color?: string;
}) => {
  const [time, setTime] = useState(minutes); // Initial time is n minutes in seconds

  useEffect(() => {
    const countdown = setInterval(() => {
      setTime((prevTime) => {
        if (prevTime <= 1) {
          clearInterval(countdown); // Clear timer when countdown ends
          if (onCountdownEnd) {
            onCountdownEnd(); // Call callback function
          }
          return 0;
        }
        return prevTime - 1;
      });
    }, 1000);

    return () => clearInterval(countdown); // Clear timer when component unmounts
  }, [minutes, onCountdownEnd]); // Format time as MM:SS
  const formatTime = (seconds: number) => {
    const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
    const secs = String(seconds % 60).padStart(2, "0");
    return `${minutes}:${secs}`;
  };

  return (
    <p
      className={`${color ?? "text-text-1 text-warning-6"} text-[12px] font-[400]`}
    >
      {formatTime(time)}
    </p>
  );
};

export default CountdownTimer;
