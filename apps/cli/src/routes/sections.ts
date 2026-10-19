import { Array as Arr, Order } from "effect";

import type { Section } from "../context/routes.ts";
import { albums } from "./library/albums.tsx";
import { artists } from "./library/artists.tsx";
import { favorites } from "./library/favorites.tsx";
import { home } from "./home.tsx";
import { playlists } from "./playlists/playlists.tsx";
import { queue } from "./queue.tsx";
import { recent } from "./recent.tsx";
import { search } from "./search.tsx";
import { sets } from "./sets/sets.tsx";
import { songs } from "./library/songs.tsx";

export const sections = Arr.sort(
  [home, search, songs, albums, artists, playlists, sets, favorites, recent, queue],
  Order.mapInput(Order.Number, (section: Section) => section.order),
);

export const startSection = songs;
