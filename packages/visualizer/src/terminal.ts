/**
 * The best image output that the terminal of `env` supports: Kitty graphics with Unicode
 * placeholders, Unicode 16 octant cells or half-block cells. Inside tmux, only cells are safe.
 */
export const graphicsSupport = (env: Readonly<Record<string, string | undefined>>) => {
  const term = env["TERM"] ?? "";
  const program = env["TERM_PROGRAM"] ?? "";
  const tmux =
    env["TMUX"] !== undefined ||
    program === "tmux" ||
    term.startsWith("tmux") ||
    term.startsWith("screen");
  const kitty = term === "xterm-kitty" || env["KITTY_WINDOW_ID"] !== undefined;
  const ghostty = term === "xterm-ghostty" || program === "ghostty";
  if ((kitty || ghostty) && !tmux) return "kitty" as const;
  // tmux keeps the variables of the outer terminal; Kitty and Ghostty draw octants themselves
  if (kitty || ghostty || env["GHOSTTY_RESOURCES_DIR"] !== undefined) return "octants" as const;
  return "halfBlocks" as const;
};
