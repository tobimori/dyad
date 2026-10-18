import { alchemy } from "./alchemy.ts";
import { ambience } from "./ambience.ts";
import { rings } from "./rings.ts";
import { starfield } from "./starfield.ts";
import { terrain } from "./terrain.ts";
import { tunnel } from "./tunnel.ts";
import { wmpPresets } from "./wmp/index.ts";

export { wmpPresets };

export const presets = [alchemy, tunnel, rings, starfield, terrain, ambience, ...wmpPresets];
