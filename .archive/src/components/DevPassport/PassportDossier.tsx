import { motion } from "framer-motion";
import React, { useState } from "react";

import { PassportDisplay } from "./PassportDisplay";
import type { PageContent, UserProfile } from "./types";

interface PassportDossierProps {
  user: UserProfile;
  pages: PageContent[];
  currentSheetIndex: number;
  onFlip: (index: number) => void;
  coverColor?: string;
}

export const PassportDossier: React.FC<PassportDossierProps> = (props) => {
  // Animation stages:
  // 1. "closed" - Folder visible, passport hidden inside
  // 2. "sliding" - Passport slides up out of folder
  // 3. "presented" - Folder fades away, passport settles
  const [stage, setStage] = useState<"closed" | "sliding" | "presented">(
    "closed"
  );

  const handleOpen = () => {
    if (stage !== "closed") return;
    setStage("sliding");

    // Auto-advance to presented after slide animation
    setTimeout(() => setStage("presented"), 1100);
  };

  // Animation variants
  const folderVariants = {
    closed: { y: 100, opacity: 1, scale: 1 },
    sliding: { y: 100, opacity: 1, scale: 1 },
    presented: {
      y: 300,
      opacity: 0,
      scale: 0.95,
      transition: { duration: 0.4, ease: "easeOut" as const },
    },
  };

  const passportVariants = {
    closed: { y: 250, scale: 0.9, rotate: -2 }, // Hidden inside
    sliding: {
      y: -20,
      scale: 1,
      rotate: 0,
      transition: {
        duration: 1.0,
        ease: [0.2, 0.8, 0.2, 1] as [number, number, number, number],
      }, // Faster slide
    },
    presented: {
      y: 0,
      scale: 1,
      rotate: 0,
      transition: { duration: 0.4 },
    },
  };

  return (
    <div className="relative flex h-[700px] w-full items-center justify-center overflow-hidden">
      {/* Folder Back Plane */}
      <motion.div
        className="absolute bottom-20 z-0 flex h-[420px] w-[640px] items-start justify-center rounded-tl-xl bg-[#3a3a3a] shadow-2xl will-change-[transform,opacity]"
        variants={folderVariants}
        initial="closed"
        animate={stage}
      >
        {/* Tab on back folder - better connection */}
        <div className="absolute -top-8 right-0 h-8 w-48 rounded-t-xl bg-[#3a3a3a]">
          {/* Smoothing element for the corner connection */}
          <div className="absolute -left-4 bottom-0 h-4 w-4 bg-[#3a3a3a]"></div>
          <div className="absolute -left-4 bottom-0 h-4 w-4 rounded-br-xl bg-[#2a2a2a]/0 shadow-[4px_4px_0_#3a3a3a]"></div>
        </div>
      </motion.div>

      {/* The Passport */}
      <motion.div
        className={`z-10 flex items-center justify-center will-change-transform ${
          stage !== "presented" ? "pointer-events-none" : ""
        }`}
        variants={passportVariants}
        initial="closed"
        animate={stage}
      >
        <PassportDisplay {...props} />
      </motion.div>

      {/* Folder Front Plane */}
      <motion.div
        className={`absolute bottom-20 z-20 flex h-[320px] w-[640px] items-center justify-center rounded-t-lg bg-[#2a2a2a] shadow-[0_-5px_15px_rgba(0,0,0,0.3)] will-change-[transform,opacity] ${
          stage === "closed"
            ? "cursor-pointer transition-transform duration-300 hover:-translate-y-2"
            : ""
        }`}
        variants={folderVariants}
        initial="closed"
        animate={stage}
        onClick={handleOpen}
      >
        {/* Folder details */}
        <div className="absolute top-0 h-px w-full bg-white/10"></div>
        <div className="absolute top-3 h-px w-full bg-white/5"></div>

        {/* Click Prompt */}
        {stage === "closed" && (
          <div className="absolute left-1/2 top-1/2 z-30 -translate-x-1/2 -translate-y-1/2 animate-pulse rounded bg-black/40 px-4 py-2 font-mono text-xs font-bold text-white backdrop-blur-sm">
            CLICK TO OPEN
          </div>
        )}

        {/* Stamp */}
        <div className="rotate-[-12deg] select-none rounded border-4 border-red-900/40 px-6 py-2 text-4xl font-black tracking-[0.2em] text-red-900/40 opacity-60 mix-blend-overlay">
          CLASSIFIED
        </div>

        {/* Label */}
        <div className="absolute bottom-12 left-12">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-white/20">
            Subject
          </div>
          <div className="bg-white/5 px-4 py-2 font-mono text-sm text-white/60 shadow-inner">
            {props.user.name || "UNKNOWN AGENT"}
          </div>
        </div>

        {/* Code */}
        <div className="absolute bottom-12 right-12 text-right">
          <div className="text-[10px] font-bold uppercase tracking-widest text-white/20">
            Case ID
          </div>
          <div className="font-mono text-xs text-white/40">
            {props.user.idNumber || "XXX-000"}
          </div>
        </div>
      </motion.div>
    </div>
  );
};
