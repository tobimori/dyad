import type { SourceSummary } from "@dyad/domain";
import { Data, Effect, Option } from "effect";

import { Ack, ackCode, hasMark, plainName, songUri, tags, tagText, tagValue } from "./protocol.ts";

type Matcher = (song: SourceSummary) => boolean;

export class Filter extends Data.Class<{
  readonly matches: Matcher;
  /** The first `any` term of a catalog search, which the Dyad search matched already */
  readonly query: string | null;
}> {}

const invalid = (message: string) => new Ack({ code: ackCode.argument, message });

const valuesOf = (song: SourceSummary, name: string) => {
  const lower = name.toLowerCase();
  if (lower === "any") {
    return tags.flatMap((tag) => Option.toArray(Option.fromNullishOr(tagValue(song, tag))));
  }
  // ncmpcpp searches `filename`
  if (lower === "file" || lower === "filename") return [songUri(song.id)];
  return [tagText(song, name)];
};

const negations = new Map([
  ["!=", "=="],
  ["!~", "=~"],
  ["!contains", "contains"],
]);

/**
 * Parses MPD 0.21 filters and the older tag and value pairs. `find` compares exactly, `search`
 * ignores case, and `catalog` also takes the first `any` term as the Dyad search query.
 */
export const parseFilter = Effect.fn("parseFilter")(function* (
  args: ReadonlyArray<string>,
  mode: "find" | "search" | "catalog",
) {
  const fold = (value: string) => (mode === "find" ? value : value.toLowerCase());
  let query: string | null = null;

  const compare = Effect.fn("compare")(function* (
    tag: string,
    operator: string,
    value: string,
    negated: boolean,
  ) {
    const positive = negations.get(operator) ?? operator;
    if (
      mode === "catalog" &&
      query === null &&
      !negated &&
      positive === operator &&
      tag.toLowerCase() === "any" &&
      (operator === "==" || operator === "contains")
    ) {
      query = plainName(value);
      return () => true;
    }

    const expected = fold(value);
    const pattern =
      positive === "=~"
        ? yield* Effect.try({
            try: () => new RegExp(value, mode === "find" ? "u" : "iu"),
            catch: () => invalid(`Invalid regular expression: ${value}`),
          })
        : null;
    // `==` and a value with marks select one artist; the other operators match all artists of
    // a name
    const exact = positive === "==" || hasMark(value);
    const test = (tagged: string) => {
      const actual = exact ? tagged : plainName(tagged);
      if (pattern !== null) return pattern.test(actual);
      if (positive === "contains") return fold(actual).includes(expected);
      if (positive === "starts_with") return fold(actual).startsWith(expected);
      return fold(actual) === expected;
    };
    const matcher: Matcher = (song) => valuesOf(song, tag).some(test);
    return positive === operator ? matcher : (song: SourceSummary) => !matcher(song);
  });

  const parseExpression = (text: string) => {
    let index = 0;
    const skipSpaces = () => {
      while (text[index] === " ") index += 1;
    };
    const expect = Effect.fn("expect")(function* (token: string) {
      skipSpaces();
      if (!text.startsWith(token, index)) return yield* invalid(`'${token}' expected`);
      index += token.length;
    });
    const quoted = Effect.gen(function* () {
      skipSpaces();
      const quote = text[index];
      if (quote !== "'" && quote !== '"') return yield* invalid("Quoted string expected");
      let value = "";
      index += 1;
      while (index < text.length && text[index] !== quote) {
        if (text[index] === "\\") index += 1;
        value += text[index] ?? "";
        index += 1;
      }
      if (index >= text.length) return yield* invalid("Closing quote not found");
      index += 1;
      return value;
    });

    // RETURN TYPE: recursive function
    const expression = Effect.fn("expression")(function* (
      negated: boolean,
    ): Effect.fn.Return<Matcher, Ack> {
      yield* expect("(");
      skipSpaces();

      if (text[index] === "(") {
        const parts = [yield* expression(negated)];
        while (true) {
          skipSpaces();
          if (text[index] === ")") {
            index += 1;
            return (song: SourceSummary) => parts.every((part) => part(song));
          }
          yield* expect("AND");
          parts.push(yield* expression(negated));
        }
      }

      if (text[index] === "!") {
        index += 1;
        const inner = yield* expression(!negated);
        yield* expect(")");
        return (song: SourceSummary) => !inner(song);
      }

      const tag = /^[\w-]+/.exec(text.slice(index))?.[0] ?? "";
      index += tag.length;
      if (
        ["base", "modified-since", "added-since", "audioformat", "prio"].includes(tag.toLowerCase())
      ) {
        return yield* invalid(`Filter ${tag} is not supported`);
      }
      skipSpaces();
      const operator = /^(==|!=|=~|!~|!?contains\b|starts_with\b)/.exec(text.slice(index))?.[0];
      if (operator === undefined) {
        return yield* invalid(`Unknown filter operator: ${text.slice(index)}`);
      }
      index += operator.length;
      const value = yield* quoted;
      yield* expect(")");
      return yield* compare(tag, operator, value, negated);
    });

    return Effect.gen(function* () {
      const matcher = yield* expression(false);
      skipSpaces();
      if (index < text.length) return yield* invalid("Unparsed garbage after expression");
      return matcher;
    });
  };

  const parts: Array<Matcher> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg.startsWith("(")) {
      parts.push(yield* parseExpression(arg));
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) return yield* invalid("incorrect arguments");
    parts.push(yield* compare(arg, mode === "find" ? "==" : "contains", value, false));
    index += 1;
  }

  return new Filter({ matches: (song) => parts.every((part) => part(song)), query });
});
