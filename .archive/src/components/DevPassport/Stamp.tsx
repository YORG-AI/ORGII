/**
 * DevPassport Stamp Component
 */
import React from "react";

import {
  AnchorIcon,
  Award01Icon,
  BrainIcon,
  Bug01Icon,
  CloudIcon,
  CodeIcon,
  Coffee01Icon,
  ComputerTerminal01Icon,
  CpuIcon,
  DatabaseIcon,
  FlashIcon,
  HexagonIcon,
  HugeiconsIcon,
  type IconSvgElement,
  InternetIcon,
  Key01Icon,
  LaptopIcon,
  Layers01Icon,
  LockIcon,
  RadioIcon,
  RocketIcon,
  Search01Icon,
  ServerStack01Icon,
  Shield01Icon,
  Wifi01Icon,
  WorkflowCircle05Icon,
} from "@src/icons";

import type { StampData, StampShape } from "./types";

interface StampProps {
  data: StampData;
}

interface ShapeConfig {
  containerClass: string;
  containerStyle: React.CSSProperties;
  innerClass: string;
  width: string;
  height: string;
}

const getShapeConfig = (
  shape: StampShape = "round",
  color: string
): ShapeConfig => {
  const baseContainerStyle = {
    color: color,
    boxShadow: `inset 0 0 0 1px ${color}20`,
  };

  switch (shape) {
    case "circle":
      return {
        containerClass:
          "flex items-center justify-center bg-transparent p-2 rounded-full",
        containerStyle: {
          ...baseContainerStyle,
          border: `3px double ${color}`,
        },
        innerClass: "flex flex-col items-center justify-center text-center",
        width: "110px",
        height: "110px",
      };

    case "oval":
      return {
        containerClass:
          "flex items-center justify-center bg-transparent p-2 rounded-[50%]",
        containerStyle: {
          ...baseContainerStyle,
          border: `3px double ${color}`,
        },
        innerClass: "flex flex-col items-center justify-center text-center",
        width: "140px",
        height: "90px",
      };

    case "code":
      return {
        containerClass:
          "flex flex-col items-start justify-center bg-transparent px-3 py-2 font-mono relative",
        containerStyle: {
          color: color,
        },
        innerClass: "flex flex-col items-start justify-start text-left w-full",
        width: "150px",
        height: "90px",
      };

    case "rectangular":
      return {
        containerClass:
          "flex items-center justify-center bg-transparent p-2 rounded-none",
        containerStyle: {
          ...baseContainerStyle,
          border: `4px solid ${color}`,
        },
        innerClass: "flex flex-col items-center justify-center text-center",
        width: "140px",
        height: "85px",
      };

    case "hexagon":
      return {
        containerClass:
          "flex items-center justify-center bg-transparent relative",
        containerStyle: {
          color: color,
        },
        innerClass: "flex flex-col items-center justify-center text-center",
        width: "130px",
        height: "115px",
      };

    case "triangle":
      return {
        containerClass:
          "flex items-center justify-center bg-transparent relative",
        containerStyle: {
          color: color,
        },
        innerClass:
          "flex flex-col items-center justify-center text-center pt-6 pb-2",
        width: "140px",
        height: "120px",
      };

    case "round":
    default:
      return {
        containerClass:
          "flex items-center justify-center bg-transparent p-2 rounded-lg",
        containerStyle: {
          ...baseContainerStyle,
          border: `3px double ${color}`,
        },
        innerClass: "flex flex-col items-center justify-center text-center",
        width: "140px",
        height: "100px",
      };
  }
};

const Stamp: React.FC<StampProps> = ({ data }) => {
  const iconMap: Record<string, IconSvgElement> = {
    code: CodeIcon,
    bug: Bug01Icon,
    coffee: Coffee01Icon,
    rocket: RocketIcon,
    award: Award01Icon,
    server: ServerStack01Icon,
    database: DatabaseIcon,
    cloud: CloudIcon,
    cpu: CpuIcon,
    git: WorkflowCircle05Icon,
    terminal: ComputerTerminal01Icon,
    zap: FlashIcon,
    globe: InternetIcon,
    lock: LockIcon,
    search: Search01Icon,
    wifi: Wifi01Icon,
    laptop: LaptopIcon,
    brain: BrainIcon,
    layers: Layers01Icon,
    shield: Shield01Icon,
    key: Key01Icon,
    radio: RadioIcon,
    anchor: AnchorIcon,
    hexagon: HexagonIcon,
  };

  const IconComponent = iconMap[data.icon.toLowerCase()] || CodeIcon;
  const shape = data.shape || "round";
  const shapeConfig = getShapeConfig(shape, data.color);

  // Code format has a special layout
  if (shape === "code") {
    return (
      <div
        className="pointer-events-none absolute flex select-none items-center justify-center"
        style={{
          top: `${data.positionY}%`,
          left: `${data.positionX}%`,
          width: shapeConfig.width,
          height: shapeConfig.height,
          transform: "translate(-50%, -50%)",
          zIndex: 20,
        }}
      >
        <div
          className="h-full w-full"
          style={{ transform: `rotate(${data.rotation}deg)` }}
        >
          <div
            className={`h-full w-full animate-stamp-slam ${shapeConfig.containerClass}`}
            style={shapeConfig.containerStyle}
          >
            {/* Left Bracket */}
            <div
              className="absolute left-0 top-0 h-full w-3 border-b-2 border-l-2 border-t-2 opacity-80"
              style={{ borderColor: data.color }}
            ></div>

            {/* Right Bracket */}
            <div
              className="absolute right-0 top-0 h-full w-3 border-b-2 border-r-2 border-t-2 opacity-80"
              style={{ borderColor: data.color }}
            ></div>

            <div className="flex w-full flex-col justify-between gap-1.5 px-1">
              <div
                className="flex items-center gap-1.5 border-b border-dashed pb-1.5 opacity-80"
                style={{ borderColor: `${data.color}40` }}
              >
                <HugeiconsIcon
                  icon={IconComponent}
                  size={14}
                  className="opacity-90"
                />
                <div className="text-[10px] font-bold uppercase tracking-wider">
                  {data.location}
                </div>
              </div>

              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <span
                    className="text-[10px] font-bold text-opacity-60"
                    style={{ color: data.color }}
                  >
                    const
                  </span>
                  <span className="text-xs font-bold uppercase tracking-wide">
                    {data.title.replace(/\s+/g, "_")}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[9px] opacity-70">
                  <span className="font-bold">=</span>
                  <span>{`"${data.date}"`}</span>
                  <span className="opacity-50">;</span>
                </div>
              </div>

              {data.description && (
                <div className="text-[8px] italic opacity-60">
                  {"// "}
                  {data.description}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Circle shape - compact layout
  if (shape === "circle") {
    return (
      <div
        className="pointer-events-none absolute flex select-none items-center justify-center"
        style={{
          top: `${data.positionY}%`,
          left: `${data.positionX}%`,
          width: shapeConfig.width,
          height: shapeConfig.height,
          transform: "translate(-50%, -50%)",
          zIndex: 20,
        }}
      >
        <div
          className="h-full w-full"
          style={{ transform: `rotate(${data.rotation}deg)` }}
        >
          <div
            className={`h-full w-full animate-stamp-slam ${shapeConfig.containerClass}`}
            style={shapeConfig.containerStyle}
          >
            <div className="relative flex h-full w-full flex-col items-center justify-center">
              {/* Curve text effect simulated with absolute positioning for top/bottom */}
              <div className="absolute top-1.5 text-[8px] font-bold uppercase tracking-[0.2em] opacity-80">
                {data.location}
              </div>

              <div className="flex flex-col items-center justify-center gap-1 py-1">
                <HugeiconsIcon
                  icon={IconComponent}
                  size={26}
                  strokeWidth={1.5}
                  className="opacity-90"
                />
                <div className="max-w-[80px] text-center text-[10px] font-bold uppercase leading-tight tracking-wide">
                  {data.title}
                </div>
              </div>

              <div className="absolute bottom-2 text-[8px] font-bold tracking-widest opacity-70">
                {data.date}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Hexagon shape
  if (shape === "hexagon") {
    return (
      <div
        className="pointer-events-none absolute flex select-none items-center justify-center"
        style={{
          top: `${data.positionY}%`,
          left: `${data.positionX}%`,
          width: shapeConfig.width,
          height: shapeConfig.height,
          transform: "translate(-50%, -50%)",
          zIndex: 20,
        }}
      >
        <div
          className="h-full w-full"
          style={{ transform: `rotate(${data.rotation}deg)` }}
        >
          <div
            className={`h-full w-full animate-stamp-slam ${shapeConfig.containerClass}`}
            style={shapeConfig.containerStyle}
          >
            {/* SVG Border */}
            <svg
              className="absolute inset-0 h-full w-full overflow-visible"
              viewBox="0 0 130 115"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              {/* Outer Hexagon - Thick solid - Flat Topped */}
              <path
                d="M32 2 L98 2 L128 57.5 L98 113 L32 113 L2 57.5 Z"
                stroke={data.color}
                strokeWidth="4"
                strokeLinecap="butt"
                strokeLinejoin="round"
                className="opacity-80"
              />
              {/* Inner Hexagon - Solid - Flat Topped */}
              <path
                d="M36 8 L94 8 L122 57.5 L94 107 L36 107 L8 57.5 Z"
                stroke={data.color}
                strokeWidth="1.5"
                fill="none"
              />
            </svg>

            {/* Content Container */}
            <div className="relative z-10 flex h-full w-full flex-col items-center justify-between px-6 py-7">
              <div
                className="flex w-full flex-col items-center gap-0.5 border-b border-dashed pb-1 opacity-80"
                style={{ borderColor: data.color }}
              >
                <div className="text-[8px] font-bold uppercase tracking-widest">
                  {data.location}
                </div>
              </div>

              <div className="my-auto text-center text-[10px] font-bold uppercase leading-tight tracking-widest text-current">
                {data.title}
              </div>

              <div
                className="flex w-full flex-col items-center gap-1 border-t border-dashed pt-1 opacity-90"
                style={{ borderColor: data.color }}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="h-0.5 w-0.5 rounded-full"
                    style={{ backgroundColor: data.color }}
                  ></div>
                  <HugeiconsIcon icon={IconComponent} size={18} />
                  <div
                    className="h-0.5 w-0.5 rounded-full"
                    style={{ backgroundColor: data.color }}
                  ></div>
                </div>
                <div className="text-[7px] font-bold">{data.date}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Triangle shape
  if (shape === "triangle") {
    return (
      <div
        className="pointer-events-none absolute flex select-none items-center justify-center"
        style={{
          top: `${data.positionY}%`,
          left: `${data.positionX}%`,
          width: shapeConfig.width,
          height: shapeConfig.height,
          transform: "translate(-50%, -50%)",
          zIndex: 20,
        }}
      >
        <div
          className="h-full w-full"
          style={{ transform: `rotate(${data.rotation}deg)` }}
        >
          <div
            className={`h-full w-full animate-stamp-slam ${shapeConfig.containerClass}`}
            style={shapeConfig.containerStyle}
          >
            {/* SVG Border */}
            <svg
              className="absolute inset-0 h-full w-full overflow-visible"
              viewBox="0 0 140 120"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              {/* Outer Triangle */}
              <path
                d="M70 5 L135 115 H5 L70 5Z"
                stroke={data.color}
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {/* Inner Triangle (Double border effect) */}
              <path
                d="M70 12 L128 110 H12 L70 12Z"
                stroke={data.color}
                strokeWidth="1"
                strokeDasharray="4 2"
                strokeOpacity="0.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>

            {/* Content Container - Pushed down to fit triangle */}
            <div className="relative z-10 flex h-full w-full flex-col items-center justify-end pb-4 pt-10">
              <div className="mb-0.5 text-[7px] font-bold uppercase tracking-widest opacity-80">
                {data.location}
              </div>

              <div className="flex flex-col items-center justify-center gap-0.5">
                <HugeiconsIcon
                  icon={IconComponent}
                  size={20}
                  className="mt-1 opacity-90"
                />
                <div className="max-w-[80px] text-center text-[9px] font-bold uppercase leading-tight tracking-wide">
                  {data.title}
                </div>
              </div>

              <div className="mt-1 flex flex-col items-center gap-0 opacity-80">
                <div
                  className="my-0.5 h-px w-8 border-t border-dashed"
                  style={{ borderColor: data.color }}
                ></div>
                <div className="text-[7px] font-bold">{data.date}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Default layout for round, oval, and rectangular
  return (
    <div
      className="pointer-events-none absolute flex select-none items-center justify-center"
      style={{
        top: `${data.positionY}%`,
        left: `${data.positionX}%`,
        width: shapeConfig.width,
        height: shapeConfig.height,
        transform: "translate(-50%, -50%)",
        zIndex: 20,
      }}
    >
      <div
        className="h-full w-full"
        style={{ transform: `rotate(${data.rotation}deg)` }}
      >
        <div
          className={`h-full w-full animate-stamp-slam ${shapeConfig.containerClass}`}
          style={shapeConfig.containerStyle}
        >
          <div className="flex h-full w-full flex-col justify-between p-1">
            <div className="flex w-full items-center justify-between px-1">
              <div className="text-[9px] font-bold tracking-widest opacity-60">
                VISA
              </div>
              <div className="text-[9px] font-bold tracking-widest opacity-60">
                {data.location}
              </div>
            </div>

            <div className="flex flex-1 flex-col items-center justify-center gap-1.5">
              <div className="flex items-center gap-2">
                <HugeiconsIcon
                  icon={IconComponent}
                  size={22}
                  strokeWidth={2}
                  className="opacity-90"
                />
                <span className="text-sm font-bold uppercase leading-none tracking-wide">
                  {data.title}
                </span>
              </div>
              <div
                className="w-full border-t border-dashed opacity-50"
                style={{ borderColor: data.color }}
              ></div>
            </div>

            <div className="flex w-full flex-col items-center gap-0.5 pb-1">
              <div className="text-[10px] font-bold opacity-90">
                {data.date}
              </div>
              <div className="max-w-full truncate text-[8px] uppercase tracking-wide opacity-70">
                {data.description}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Stamp;
