/**
 * AskUserPending Component
 *
 * Renders the "ask_user_pending" event - Email notification animation
 * while waiting for user response.
 */
import { motion } from "framer-motion";
import { Mail } from "lucide-react";
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import type { BackendEvent } from "@src/types/session/steps";

// ============================================
// Props
// ============================================

interface AskUserPendingProps {
  event: BackendEvent;
}

// ============================================
// Main Component - Phone Calling Animation
// ============================================

const AskUserPending: React.FC<AskUserPendingProps> = memo(() => {
  const { t } = useTranslation("sessions");
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-8 p-6">
      {/* Animated email icon with ripple effect */}
      <div className="relative flex items-center justify-center">
        {/* Wave Layers */}
        {[0, 1, 2, 3].map((index) => (
          <motion.div
            key={index}
            className="absolute rounded-full border border-primary-5/20 bg-primary-5/5"
            initial={{ width: "80px", height: "80px", opacity: 0.8 }}
            animate={{
              width: ["80px", "240px"],
              height: ["80px", "240px"],
              opacity: [0.6, 0],
            }}
            transition={{
              duration: 3,
              repeat: Infinity,
              delay: index * 0.75,
              ease: "easeOut",
            }}
          />
        ))}

        {/* Static Glow Background */}
        <div className="absolute h-24 w-24 rounded-full bg-primary-5/10 blur-xl" />

        {/* Email icon container with shake animation */}
        <motion.div
          className="relative z-10 flex h-20 w-20 items-center justify-center rounded-full border-2 border-primary-5/10 shadow-lg shadow-primary-5/10"
          animate={{
            rotate: [0, -10, 10, -10, 10, 0],
            scale: [1, 1.05, 1.05, 1.05, 1.05, 1],
          }}
          transition={{
            duration: 1.5,
            repeat: Infinity,
            repeatDelay: 0.5,
            ease: "easeInOut",
            times: [0, 0.1, 0.2, 0.3, 0.4, 1],
          }}
        >
          <motion.div
            animate={{
              scale: [1, 1.1, 1],
            }}
            transition={{
              duration: 1.5,
              repeat: Infinity,
              repeatDelay: 0.5,
              times: [0, 0.2, 1],
            }}
          >
            <Mail size={36} className="text-primary-6" />
          </motion.div>
        </motion.div>
      </div>

      {/* Status text with animation */}
      <motion.div
        className="flex flex-col items-center gap-3 text-center"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="flex flex-col items-center gap-1">
          <div className="text-xl font-semibold tracking-tight text-text-1">
            {t("simulator.askUserPending.incomingRequest")}
          </div>
          <div className="flex items-center justify-center gap-1.5 text-sm text-text-3">
            <div className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success-5 opacity-75"></span>
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success-5"></span>
            </div>
            <span>{t("simulator.askUserPending.respondInChat")}</span>
          </div>
        </div>
      </motion.div>
    </div>
  );
});

AskUserPending.displayName = "AskUserPending";

export default AskUserPending;
