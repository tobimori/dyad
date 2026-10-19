import { Array as Arr, Order } from "effect";

import type { Section } from "../context/routes.ts";
import { albums } from "./albums.tsx";
import { artists } from "./artists.tsx";
import { favorites } from "./favorites.tsx";
import { home } from "./home.tsx";
import { playlists } from "./playlists.tsx";
import { queue } from "./queue.tsx";
import { recent } from "./recent.tsx";
import { search } from "./search.tsx";
import { sets } from "./sets.tsx";
import { songs } from "./songs.tsx";

export const sections = Arr.sort(
  [home, search, songs, albums, artists, playlists, sets, favorites, recent, queue],
  Order.mapInput(Order.Number, (section: Section) => section.order),
);

export const startSection = songs;
