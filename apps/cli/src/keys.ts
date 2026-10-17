import type { KeyEvent } from "@opentui/core";

/**
 * The typed character of a printable key, else the key name. With the Kitty keyboard protocol,
 * OpenTUI 0.6.6 names a shifted symbol by its base key, for example `/` with `shift` for `?`, and
 * puts the typed text in `sequence`.
 */
export const keyOf = (key: KeyEvent) =>
  key.sequence.length === 1 && key.sequence > " " ? key.sequence : key.name;

/** All keys, for the help overlay, in two columns of groups */
export const helpColumns = [
  [
    [
      "Playback",
      [
        ["space", "Play or pause"],
        ["n  b", "Next, previous"],
        ["⇧← ⇧→  , .", "Seek 10 seconds"],
        ["+  -", "Volume"],
        ["s", "Shuffle"],
        ["R", "Repeat: off, all, one"],
      ],
    ],
    [
      "Other",
      [
        ["r", "Reload"],
        ["?", "Help"],
        ["q", "Quit"],
      ],
    ],
  ],
  [
    [
      "Browse",
      [
        ["tab  ⇧tab", "Next, previous section"],
        ["↑ ↓  j k", "Move"],
        ["g  G", "First, last"],
        ["⏎", "Play, queue the rest"],
        ["/", "Search"],
        ["a", "Actions"],
        ["esc", "Leave search, close"],
      ],
    ],
    [
      "Queue",
      [
        ["d  del", "Remove"],
        ["c", "Clear, keep current"],
      ],
    ],
  ],
] as const;

/** The few keys that the footer shows for what has focus */
export const hints = {
  list: [
    ["⏎", "play"],
    ["a", "actions"],
    ["/", "search"],
    ["tab", "section"],
    ["?", "help"],
  ],
  queue: [
    ["⏎", "play"],
    ["d", "remove"],
    ["c", "clear"],
    ["a", "actions"],
    ["?", "help"],
  ],
  input: [
    ["⏎", "results"],
    ["esc", "leave"],
  ],
  help: [["esc", "close"]],
  actions: [
    ["↑↓", "move"],
    ["⏎", "choose"],
    ["esc", "close"],
  ],
} as const;
