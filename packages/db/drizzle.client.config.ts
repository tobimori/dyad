import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/client/schema.ts",
  out: "./migrations-client",
});
