import { alchemy } from "./alchemy.ts";
import { ambience } from "./ambience.ts";
import { backdrops } from "./backdrop.ts";
import { rings } from "./rings.ts";
import { starfield } from "./starfield.ts";
import { terrain } from "./terrain.ts";
import { tunnel } from "./tunnel.ts";
import { wmpPresets } from "./wmp/index.ts";

export { backdrops, wmpPresets };

export const presets = [alchemy, tunnel, rings, starfield, terrain, ambience, ...wmpPresets];
