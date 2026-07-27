import React from "react";

const THUMB_W = 56;
const THUMB_H = 36;

export const LeftChatThumb: React.FC = () => (
  <svg
    width={THUMB_W}
    height={THUMB_H}
    viewBox={`0 0 ${THUMB_W} ${THUMB_H}`}
    className="block"
  >
    <rect
      x={0.5}
      y={0.5}
      width={THUMB_W - 1}
      height={THUMB_H - 1}
      rx={4}
      className="fill-fill-2 stroke-border-2"
      strokeWidth={1}
    />
    {/* Left: chat panel */}
    <rect x={4} y={6} width={20} height={24} rx={2} className="fill-fill-3" />
    <rect x={7} y={10} width={14} height={2} rx={1} className="fill-text-4" />
    <rect
      x={7}
      y={14}
      width={10}
      height={2}
      rx={1}
      className="fill-text-4/60"
    />
    <rect
      x={7}
      y={18}
      width={12}
      height={2}
      rx={1}
      className="fill-text-4/40"
    />
    {/* Right: editor */}
    <rect x={27} y={6} width={25} height={24} rx={2} className="fill-fill-1" />
    <rect
      x={30}
      y={10}
      width={18}
      height={2}
      rx={1}
      className="fill-text-4/30"
    />
    <rect
      x={30}
      y={14}
      width={14}
      height={2}
      rx={1}
      className="fill-text-4/20"
    />
    <rect
      x={30}
      y={18}
      width={16}
      height={2}
      rx={1}
      className="fill-text-4/25"
    />
  </svg>
);

export const RightChatThumb: React.FC = () => (
  <svg
    width={THUMB_W}
    height={THUMB_H}
    viewBox={`0 0 ${THUMB_W} ${THUMB_H}`}
    className="block"
  >
    <rect
      x={0.5}
      y={0.5}
      width={THUMB_W - 1}
      height={THUMB_H - 1}
      rx={4}
      className="fill-fill-2 stroke-border-2"
      strokeWidth={1}
    />
    {/* Left: editor */}
    <rect x={4} y={6} width={25} height={24} rx={2} className="fill-fill-1" />
    <rect
      x={7}
      y={10}
      width={18}
      height={2}
      rx={1}
      className="fill-text-4/30"
    />
    <rect
      x={7}
      y={14}
      width={14}
      height={2}
      rx={1}
      className="fill-text-4/20"
    />
    <rect
      x={7}
      y={18}
      width={16}
      height={2}
      rx={1}
      className="fill-text-4/25"
    />
    {/* Right: chat panel */}
    <rect x={32} y={6} width={20} height={24} rx={2} className="fill-fill-3" />
    <rect x={35} y={10} width={14} height={2} rx={1} className="fill-text-4" />
    <rect
      x={35}
      y={14}
      width={10}
      height={2}
      rx={1}
      className="fill-text-4/60"
    />
    <rect
      x={35}
      y={18}
      width={12}
      height={2}
      rx={1}
      className="fill-text-4/40"
    />
  </svg>
);

export const AgentLeftThumb: React.FC = () => (
  <svg
    width={THUMB_W}
    height={THUMB_H}
    viewBox={`0 0 ${THUMB_W} ${THUMB_H}`}
    className="block"
  >
    <rect
      x={0.5}
      y={0.5}
      width={THUMB_W - 1}
      height={THUMB_H - 1}
      rx={4}
      className="fill-fill-2 stroke-border-2"
      strokeWidth={1}
    />
    {/* Left: chat panel */}
    <rect x={4} y={6} width={22} height={24} rx={2} className="fill-fill-3" />
    <rect x={7} y={10} width={16} height={2} rx={1} className="fill-text-4" />
    <rect
      x={7}
      y={14}
      width={12}
      height={2}
      rx={1}
      className="fill-text-4/60"
    />
    <rect
      x={7}
      y={18}
      width={14}
      height={2}
      rx={1}
      className="fill-text-4/40"
    />
    {/* Right: content */}
    <rect x={29} y={6} width={23} height={24} rx={2} className="fill-fill-1" />
  </svg>
);

export const AgentRightThumb: React.FC = () => (
  <svg
    width={THUMB_W}
    height={THUMB_H}
    viewBox={`0 0 ${THUMB_W} ${THUMB_H}`}
    className="block"
  >
    <rect
      x={0.5}
      y={0.5}
      width={THUMB_W - 1}
      height={THUMB_H - 1}
      rx={4}
      className="fill-fill-2 stroke-border-2"
      strokeWidth={1}
    />
    {/* Left: content */}
    <rect x={4} y={6} width={23} height={24} rx={2} className="fill-fill-1" />
    {/* Right: chat panel */}
    <rect x={30} y={6} width={22} height={24} rx={2} className="fill-fill-3" />
    <rect x={33} y={10} width={16} height={2} rx={1} className="fill-text-4" />
    <rect
      x={33}
      y={14}
      width={12}
      height={2}
      rx={1}
      className="fill-text-4/60"
    />
    <rect
      x={33}
      y={18}
      width={14}
      height={2}
      rx={1}
      className="fill-text-4/40"
    />
  </svg>
);
