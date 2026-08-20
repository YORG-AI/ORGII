/**
 * Bot personas for the phase-0 table (human vs. five bots, play chips).
 *
 * Names are invented agent handles on purpose: no real people (the design
 * mock seats real accounts — a right-of-publicity problem) and no provider
 * marks. Style knobs feed `botBrain`; hue feeds the generated avatar.
 */
import type { PokerPlayer } from "./types";

export interface BotStyle {
  /** 0 = plays only premiums, 1 = plays almost anything. */
  looseness: number;
  /** 0 = calls, 1 = bets/raises whenever it continues. */
  aggression: number;
  /** Probability of betting with air when checked to. */
  bluffFrequency: number;
  /** Thinking-time multiplier (1 = normal). */
  tempo: number;
}

export interface BotPersona {
  id: string;
  name: string;
  avatarHue: number;
  style: BotStyle;
}

export const BOT_PERSONAS: readonly BotPersona[] = [
  {
    id: "lambda",
    name: "lambda",
    avatarHue: 262,
    style: {
      looseness: 0.35,
      aggression: 0.75,
      bluffFrequency: 0.18,
      tempo: 0.9,
    },
  },
  {
    id: "vector",
    name: "vector",
    avatarHue: 200,
    style: {
      looseness: 0.55,
      aggression: 0.55,
      bluffFrequency: 0.12,
      tempo: 1.1,
    },
  },
  {
    id: "byte",
    name: "byte",
    avatarHue: 24,
    style: {
      looseness: 0.8,
      aggression: 0.35,
      bluffFrequency: 0.06,
      tempo: 0.7,
    },
  },
  {
    id: "cipher",
    name: "cipher",
    avatarHue: 150,
    style: {
      looseness: 0.25,
      aggression: 0.5,
      bluffFrequency: 0.1,
      tempo: 1.4,
    },
  },
  {
    id: "quark",
    name: "quark",
    avatarHue: 340,
    style: {
      looseness: 0.65,
      aggression: 0.85,
      bluffFrequency: 0.28,
      tempo: 0.8,
    },
  },
  {
    id: "nomad",
    name: "nomad",
    avatarHue: 48,
    style: {
      looseness: 0.45,
      aggression: 0.45,
      bluffFrequency: 0.14,
      tempo: 1.0,
    },
  },
] as const;

export function findPersona(personaId: string | undefined): BotPersona {
  return (
    BOT_PERSONAS.find((persona) => persona.id === personaId) ?? BOT_PERSONAS[0]
  );
}

export function personaToPlayer(persona: BotPersona): PokerPlayer {
  return {
    id: `bot:${persona.id}`,
    name: persona.name,
    kind: "bot",
    avatarHue: persona.avatarHue,
    personaId: persona.id,
  };
}
