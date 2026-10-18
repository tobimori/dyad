import { alchemyRandom } from "./alchemy.ts";
import {
  ambienceAnon,
  ambienceBlender,
  ambienceBubble,
  ambienceDizzy,
  ambienceDrain,
  ambienceFalloff,
  ambienceNiagara,
  ambienceRandom,
  ambienceSwirl,
  ambienceThingus,
  ambienceWarp,
  ambienceWater,
  ambienceWindmill,
  ambienceXMarks,
} from "./ambience.ts";
import { bars, fireStorm, oceanMist, scope } from "./bars-and-waves.ts";

/** The visualizations of Windows Media Player 9 on Windows XP */
export const wmpPresets = [
  bars,
  oceanMist,
  fireStorm,
  scope,
  ambienceRandom,
  ambienceSwirl,
  ambienceWarp,
  ambienceAnon,
  ambienceFalloff,
  ambienceWater,
  ambienceBubble,
  ambienceDizzy,
  ambienceWindmill,
  ambienceNiagara,
  ambienceBlender,
  ambienceXMarks,
  ambienceDrain,
  ambienceThingus,
  alchemyRandom,
];
