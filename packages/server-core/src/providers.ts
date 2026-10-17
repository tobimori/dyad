import type { Resolve, Search } from "@dyad/plugin";
import { Context, Layer } from "effect";

/** Resolvers that plugins add, by provider name */
export class SourceResolvers extends Context.Service<SourceResolvers, Map<string, Resolve>>()(
  "@dyad/server-core/SourceResolvers",
) {}

export const sourceResolversLayer = Layer.sync(SourceResolvers, () => new Map());

/** Catalog searches that plugins add, by provider name */
export class SourceSearches extends Context.Service<SourceSearches, Map<string, Search>>()(
  "@dyad/server-core/SourceSearches",
) {}

export const sourceSearchesLayer = Layer.sync(SourceSearches, () => new Map());
