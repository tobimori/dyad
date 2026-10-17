import type { BoxRenderable, InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { Data } from "effect";
import { useEffect, useRef, useState } from "react";

import { fit } from "./format.ts";
import { commands, useCommands } from "./keymap.ts";
import { useTheme } from "./theme.ts";

export class SelectOption<A> extends Data.Class<{
  readonly value: A;
  readonly title: string;
  /** Text at the right end of the row, for example the key of a command */
  readonly detail: string;
}> {}

const rowId = (index: number) => `select-option-${index}`;

/**
 * A list to choose one value from, with the keyboard or the mouse. With `filter`, a text field
 * above the list keeps only the options that contain the typed text.
 */
export function SelectList<A>(props: {
  readonly options: ReadonlyArray<SelectOption<A>>;
  readonly width: number;
  /** The most rows that show at once */
  readonly rows: number;
  readonly filter?: string;
  readonly empty?: string;
  readonly onChoose: (value: A) => void;
}) {
  const theme = useTheme();
  const container = useRef<BoxRenderable | null>(null);
  const filterInput = useRef<InputRenderable | null>(null);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<A | null>(null);

  const needle = query.trim().toLowerCase();
  const visible =
    needle === ""
      ? props.options
      : props.options.filter((option) => option.title.toLowerCase().includes(needle));
  const index = Math.max(
    0,
    visible.findIndex((option) => option.value === highlighted),
  );
  const current = visible[index];

  const move = (direction: 1 | -1) => {
    const next = visible[Math.max(0, Math.min(visible.length - 1, index + direction))];
    if (next !== undefined) setHighlighted(next.value);
  };

  const choose = () => {
    if (current !== undefined) props.onChoose(current.value);
  };

  useCommands(
    [
      [commands.selectUp, () => move(-1)],
      [commands.selectDown, () => move(1)],
      [commands.choose, choose],
    ],
    { target: container, targetMode: "focus-within" },
  );

  useEffect(() => {
    const target = props.filter === undefined ? container.current : filterInput.current;
    target?.focus();
  }, []);

  useEffect(() => {
    scroll.current?.scrollChildIntoView(rowId(index));
  }, [index]);

  const titleWidth = props.width - 2;

  return (
    <box ref={container} focusable flexDirection="column">
      {props.filter !== undefined && (
        <box height={1} marginBottom={1} flexDirection="row">
          <text width={2} fg={theme.accent}>
            ›
          </text>
          <input
            ref={filterInput}
            flexGrow={1}
            value={query}
            placeholder={props.filter}
            backgroundColor={theme.panel}
            focusedBackgroundColor={theme.panel}
            textColor={theme.text}
            focusedTextColor={theme.text}
            placeholderColor={theme.faint}
            cursorColor={theme.accent}
            onInput={setQuery}
          />
        </box>
      )}
      {visible.length === 0 && <text fg={theme.muted}>{props.empty ?? "Nothing found"}</text>}
      <scrollbox
        ref={scroll}
        focusable={false}
        viewportCulling
        height={Math.min(props.rows, visible.length)}
      >
        {visible.map((option, position) => {
          const selected = position === index;
          return (
            <box
              key={String(position)}
              id={rowId(position)}
              flexDirection="row"
              height={1}
              backgroundColor={selected ? theme.selection : theme.panel}
              onMouseOver={() => setHighlighted(option.value)}
              onMouseDown={() => props.onChoose(option.value)}
            >
              <text flexGrow={1} wrapMode="none" fg={selected ? theme.text : theme.muted}>
                <span fg={theme.accent}>{selected ? "› " : "  "}</span>
                {fit(option.title, titleWidth - option.detail.length - 3)}
              </text>
              <text fg={theme.faint}>{option.detail}</text>
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}
