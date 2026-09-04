/**
 * Cycling art-video clips with ORG II overlay — shared by onboarding flows
 * (select repo, login loading states).
 */
import React, { useCallback, useEffect, useRef, useState } from "react";

import BoyleAnExperiment from "@src/assets/loading/Boyle_an_experiment.mp4";
import BruegelAutumn from "@src/assets/loading/Bruegel_autumn.mp4";
import HopperNighthawks from "@src/assets/loading/Hopper_nighthawks.mp4";
import MatisseRedHarmony from "@src/assets/loading/Matisse_red_harmony.mp4";
import MorisotTheCradle from "@src/assets/loading/Morisot_the_cradle.mp4";
import RaphaelSchoolOfAthens from "@src/assets/loading/Raphael_school_of_athens.mp4";
import RembrandtAnatomyLesson from "@src/assets/loading/Rembrandt_anatomy_lesson.mp4";
import VermeerAstronomer from "@src/assets/loading/Vermeer_astronomer.mp4";
import VermeerGeographer from "@src/assets/loading/Vermeer_geographer.mp4";

import { ONBOARDING_LOADING_VIDEO_FRAME_PX } from "./onboardingTokens";

export {
  ONBOARDING_LOADING_VIDEO_FRAME_PX,
  ONBOARDING_LOADING_VIDEO_MAX_WIDTH_CLASS,
  ONBOARDING_LOADING_VIDEO_WIDTH_CLASS,
} from "./onboardingTokens";

const LOADING_VIDEOS = [
  BoyleAnExperiment,
  BruegelAutumn,
  HopperNighthawks,
  MatisseRedHarmony,
  MorisotTheCradle,
  RaphaelSchoolOfAthens,
  RembrandtAnatomyLesson,
  VermeerAstronomer,
  VermeerGeographer,
];

export const OnboardingLoadingVideo: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentIndex, setCurrentIndex] = useState(() =>
    Math.floor(Math.random() * LOADING_VIDEOS.length)
  );

  const handleEnded = useCallback(() => {
    setCurrentIndex((prev) => (prev + 1) % LOADING_VIDEOS.length);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.load();
    video.play().catch(() => undefined);
  }, [currentIndex]);

  return (
    <div
      className="relative overflow-hidden rounded-lg bg-black"
      style={{
        width: ONBOARDING_LOADING_VIDEO_FRAME_PX,
        height: ONBOARDING_LOADING_VIDEO_FRAME_PX,
      }}
    >
      <video
        ref={videoRef}
        key={currentIndex}
        src={LOADING_VIDEOS[currentIndex]}
        autoPlay
        muted
        playsInline
        onEnded={handleEnded}
        className="h-full w-full object-cover"
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-5xl font-bold tracking-widest text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]">
          ORG II
        </span>
      </div>
    </div>
  );
};
