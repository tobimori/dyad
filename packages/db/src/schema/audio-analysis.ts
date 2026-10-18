import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Replica-local and not catalog evidence: the values depend on the exact bytes, and each replica
// computes them again from its own files.

/**
 * Loudness and silence of one variant's audio. A local variant's source ID comes from its audio
 * hash, so the variant names the exact audio; a provider variant also needs `asset`.
 */
export const audioAnalysis = sqliteTable("audio_analysis", {
  variantId: text("variant_id").primaryKey(),
  // The CENC key IDs of the analyzed media cache file, joined with `-`. Empty without encryption.
  asset: text("asset").notNull(),
  // A row from an earlier analyzer is analyzed again
  analyzerVersion: integer("analyzer_version").notNull(),
  // Integrated loudness in LUFS (EBU R128)
  loudness: real("loudness").notNull(),
  // In dBTP
  truePeak: real("true_peak").notNull(),
  leadingSilenceMs: integer("leading_silence_ms").notNull(),
  trailingSilenceMs: integer("trailing_silence_ms").notNull(),
  analyzedAt: integer("analyzed_at").notNull(),
});
