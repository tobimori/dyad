import { Array as Arr, Order } from "effect";

import type { Section } from "../context/routes.ts";
import { albums } from "./albums.tsx";
import { artists } from "./artists.tsx";
import { queue } from "./queue.tsx";
import { recent } from "./recent.tsx";
import { search } from "./search.tsx";
import { songs } from "./songs.tsx";

export const sections = Arr.sort(
  [search, songs, artists, albums, recent, queue],
  Order.mapInput(Order.Number, (section: Section) => section.order),
);

export const startSection = songs;
