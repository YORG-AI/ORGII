/**
 * DevPassport Types
 */

export type LayoutMode = "grid" | "freestyle";

export type StampShape =
  | "round"
  | "oval"
  | "circle"
  | "code"
  | "rectangular"
  | "triangle"
  | "hexagon";

export interface StampData {
  id: string;
  title: string;
  date: string;
  location: string;
  color: string;
  icon: string;
  description?: string;
  rotation: number;
  positionX: number;
  positionY: number;
  shape?: StampShape;
}

export interface UserProfile {
  name: string;
  role: string;
  memberSince: string;
  idNumber: string;
  avatarUrl: string;
}

export interface PageContent {
  id: string;
  type: "profile" | "stamps";
  stamps?: StampData[];
}
