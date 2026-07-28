import EAFH_AVATAR from "@src/assets/builderProfile/avatars/EAFH.png";
import EAFS_AVATAR from "@src/assets/builderProfile/avatars/EAFS.png";
import EAWH_AVATAR from "@src/assets/builderProfile/avatars/EAWH.png";
import EAWS_AVATAR from "@src/assets/builderProfile/avatars/EAWS.png";
import EDFH_AVATAR from "@src/assets/builderProfile/avatars/EDFH.png";
import EDFS_AVATAR from "@src/assets/builderProfile/avatars/EDFS.png";
import EDWH_AVATAR from "@src/assets/builderProfile/avatars/EDWH.png";
import EDWS_AVATAR from "@src/assets/builderProfile/avatars/EDWS.png";
import MAFH_AVATAR from "@src/assets/builderProfile/avatars/MAFH.png";
import MAFS_AVATAR from "@src/assets/builderProfile/avatars/MAFS.png";
import MAWH_AVATAR from "@src/assets/builderProfile/avatars/MAWH.png";
import MAWS_AVATAR from "@src/assets/builderProfile/avatars/MAWS.png";
import MDFH_AVATAR from "@src/assets/builderProfile/avatars/MDFH.png";
import MDFS_AVATAR from "@src/assets/builderProfile/avatars/MDFS.png";
import MDWH_AVATAR from "@src/assets/builderProfile/avatars/MDWH.png";
import MDWS_AVATAR from "@src/assets/builderProfile/avatars/MDWS.png";

export type BuilderTypeLetter = "M" | "E" | "D" | "A" | "F" | "W" | "S" | "H";

export const BUILDER_TYPE_CODES = [
  "MDFS",
  "MDFH",
  "MDWS",
  "MDWH",
  "MAFS",
  "MAFH",
  "MAWS",
  "MAWH",
  "EDFS",
  "EDFH",
  "EDWS",
  "EDWH",
  "EAFS",
  "EAFH",
  "EAWS",
  "EAWH",
] as const;

export type BuilderTypeCode = (typeof BUILDER_TYPE_CODES)[number];
export type BuilderTypeFamily = "MD" | "MA" | "ED" | "EA";

export interface BuilderTypeDefinition {
  code: BuilderTypeCode;
  name: string;
  family: BuilderTypeFamily;
  letters: readonly ["M" | "E", "D" | "A", "F" | "W", "S" | "H"];
  avatar: string;
}

export const BUILDER_TYPES: readonly BuilderTypeDefinition[] = [
  {
    code: "MDFS",
    name: "Systems Architect",
    family: "MD",
    letters: ["M", "D", "F", "S"],
    avatar: MDFS_AVATAR,
  },
  {
    code: "MDFH",
    name: "Mission Commander",
    family: "MD",
    letters: ["M", "D", "F", "H"],
    avatar: MDFH_AVATAR,
  },
  {
    code: "MDWS",
    name: "Fleet Architect",
    family: "MD",
    letters: ["M", "D", "W", "S"],
    avatar: MDWS_AVATAR,
  },
  {
    code: "MDWH",
    name: "Campaign Commander",
    family: "MD",
    letters: ["M", "D", "W", "H"],
    avatar: MDWH_AVATAR,
  },
  {
    code: "MAFS",
    name: "Platform Builder",
    family: "MA",
    letters: ["M", "A", "F", "S"],
    avatar: MAFS_AVATAR,
  },
  {
    code: "MAFH",
    name: "Studio Producer",
    family: "MA",
    letters: ["M", "A", "F", "H"],
    avatar: MAFH_AVATAR,
  },
  {
    code: "MAWS",
    name: "Orchestration Architect",
    family: "MA",
    letters: ["M", "A", "W", "S"],
    avatar: MAWS_AVATAR,
  },
  {
    code: "MAWH",
    name: "Portfolio Operator",
    family: "MA",
    letters: ["M", "A", "W", "H"],
    avatar: MAWH_AVATAR,
  },
  {
    code: "EDFS",
    name: "Investigative Engineer",
    family: "ED",
    letters: ["E", "D", "F", "S"],
    avatar: EDFS_AVATAR,
  },
  {
    code: "EDFH",
    name: "Debugging Detective",
    family: "ED",
    letters: ["E", "D", "F", "H"],
    avatar: EDFH_AVATAR,
  },
  {
    code: "EDWS",
    name: "Parallel Prospector",
    family: "ED",
    letters: ["E", "D", "W", "S"],
    avatar: EDWS_AVATAR,
  },
  {
    code: "EDWH",
    name: "Multi-Track Hacker",
    family: "ED",
    letters: ["E", "D", "W", "H"],
    avatar: EDWH_AVATAR,
  },
  {
    code: "EAFS",
    name: "Emergent Architect",
    family: "EA",
    letters: ["E", "A", "F", "S"],
    avatar: EAFS_AVATAR,
  },
  {
    code: "EAFH",
    name: "Improvising Shipper",
    family: "EA",
    letters: ["E", "A", "F", "H"],
    avatar: EAFH_AVATAR,
  },
  {
    code: "EAWS",
    name: "Research Conductor",
    family: "EA",
    letters: ["E", "A", "W", "S"],
    avatar: EAWS_AVATAR,
  },
  {
    code: "EAWH",
    name: "Swarm Founder",
    family: "EA",
    letters: ["E", "A", "W", "H"],
    avatar: EAWH_AVATAR,
  },
] as const;

const BUILDER_TYPE_BY_CODE = new Map<BuilderTypeCode, BuilderTypeDefinition>(
  BUILDER_TYPES.map((type) => [type.code, type])
);

export function isBuilderTypeCode(code: string): code is BuilderTypeCode {
  return BUILDER_TYPE_BY_CODE.has(code as BuilderTypeCode);
}

export function getBuilderType(
  code: string | null | undefined
): BuilderTypeDefinition | undefined {
  return code && isBuilderTypeCode(code)
    ? BUILDER_TYPE_BY_CODE.get(code)
    : undefined;
}
