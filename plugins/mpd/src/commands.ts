import { nextEntry, positionAt, SessionCommand } from "@dyad/domain";
import type {
  EntryId,
  Output,
  PlayContext,
  QueueEntry,
  SessionCommandFailed,
  SourceSummary,
} from "@dyad/domain";
import {
  Array as Arr,
  Clock,
  Data,
  Effect,
  Option,
  Predicate,
  Redacted,
  Ref,
  SubscriptionRef,
} from "effect";

import { parseFilter } from "./filter.ts";
import { directoryPath, directoryTree, walk } from "./library.ts";
import { Library } from "./mirror.ts";
import type { Artwork, MirrorUnavailable } from "./mirror.ts";
import {
  Ack,
  ackCode,
  field,
  markArtist,
  seconds,
  songLines,
  songUri,
  queryTag,
  sourceIdOf,
  tagNamed,
  tags,
  tagText,
  tagValue,
} from "./protocol.ts";
import type { Response, Tag } from "./protocol.ts";
import { control as controlSession, Session } from "./session.ts";
import type { View } from "./session.ts";

/** State that all connections share */
export class Server extends Data.Class<{
  readonly startedAt: number;
  /** MPD output IDs are small integers. A Dyad output gets one when the server first sees it. */
  readonly outputNumbers: Map<string, number>;
  /** The artist refs of each name in the order of first sight, for `markArtist` */
  readonly artistRefsByName: Map<string, Array<string>>;
}> {}

export class Connection extends Data.Class<{
  readonly server: Server;
  readonly session: Ref.Ref<Option.Option<Session["Service"]>>;
  /** Sets `session` when the password is valid */
  readonly authenticate: (password: Redacted.Redacted<string>) => Effect.Effect<boolean>;
  readonly enabledTags: Set<Tag>;
  readonly binaryLimit: Ref.Ref<number>;
  /** The last image only: clients read it in chunks, with one request for each chunk */
  readonly artwork: Map<string, Option.Option<Artwork>>;
}> {}

const handler = <R = never>(
  min: number,
  max: number,
  run: (args: ReadonlyArray<string>, connection: Connection) => Effect.Effect<Response, Ack, R>,
) => ({ min, max, run });

type Handler<R> = ReturnType<typeof handler<R>>;

const Command = SessionCommand.cases;

const ok = Effect.succeed<Response>([]);

const invalid = (message: string) => new Ack({ code: ackCode.argument, message });

const commandAcks = {
  stale_queue: new Ack({ code: ackCode.argument, message: "playlist changed, try again" }),
  entry_not_found: new Ack({ code: ackCode.noExist, message: "No such song" }),
  queue_full: new Ack({ code: ackCode.playlistMax, message: "Playlist is too large" }),
  output_unavailable: new Ack({ code: ackCode.noExist, message: "No such audio output" }),
  nothing_to_play: new Ack({ code: ackCode.playerSync, message: "Nothing to play" }),
} satisfies Record<SessionCommandFailed["reason"], Ack>;

const fromMirror = (error: SessionCommandFailed | MirrorUnavailable) =>
  Predicate.isTagged(error, "MirrorUnavailable")
    ? new Ack({ code: ackCode.system, message: "The Dyad server is not available" })
    : commandAcks[error.reason];

const view = Effect.flatMap(Session, (session) => SubscriptionRef.get(session.view));

const mirror = Effect.map(Session, (session) => session.mirror);

const library = (connection: Connection) =>
  mirror.pipe(
    Effect.flatMap((mirror) => mirror.library),
    Effect.map(
      ({ songs, syncedAt }) =>
        new Library({
          songs: songs.map((song) => markArtist(connection.server.artistRefsByName, song)),
          syncedAt,
        }),
    ),
    Effect.mapError(fromMirror),
  );

// Reads the library first, so that its order and not the order of commands decides which artist
// of a name keeps the plain name
const artistMarks = (connection: Connection) =>
  library(connection).pipe(
    Effect.ignore,
    Effect.as((song: SourceSummary) => markArtist(connection.server.artistRefsByName, song)),
  );

const control = (command: typeof SessionCommand.Type, ifQueueVersion: number | null = null) =>
  controlSession(command, ifQueueVersion).pipe(Effect.mapError(fromMirror));

const notPlaying = new Ack({ code: ackCode.playerSync, message: "Not playing" });

const integer = (arg: string) =>
  /^-?\d+$/.test(arg)
    ? Effect.succeed(Number(arg))
    : Effect.fail(invalid(`Integer expected: ${arg}`));

const decimal = (arg: string) =>
  /^[+-]?(\d+\.?\d*|\.\d+)$/.test(arg)
    ? Effect.succeed(Number(arg))
    : Effect.fail(invalid(`Float expected: ${arg}`));

const flag = (arg: string) => {
  if (arg === "0") return Effect.succeed(false);
  if (arg === "1") return Effect.succeed(true);
  return Effect.fail(invalid(`Boolean (0/1) expected: ${arg}`));
};

const badIndex = invalid("Bad song index");

// `START:END`, `START:` or one position, as the half-open range `[start, end)`
const range = (arg: string, length: number) =>
  Effect.gen(function* () {
    const [first = "", last] = arg.split(":");
    const start = yield* integer(first);
    const openEnd = last === "" ? length : start + 1;
    const end = last === undefined || last === "" ? openEnd : yield* integer(last);
    if (start < 0 || end < start || end > length) return yield* badIndex;
    return [start, end] as const;
  });

const entryWithId = (current: View, arg: string) =>
  Effect.gen(function* () {
    const id = yield* integer(arg);
    const entry = current.entries.find((entry) => entry.id === id);
    if (entry === undefined) return yield* commandAcks.entry_not_found;
    return entry;
  });

const entryAt = (current: View, arg: string) =>
  Effect.gen(function* () {
    const entry = current.entries[yield* integer(arg)];
    if (entry === undefined) return yield* badIndex;
    return entry;
  });

const entryIdsIn = (current: View, positions: string) =>
  Effect.map(range(positions, current.entries.length), ([start, end]) =>
    current.entries.slice(start, end).map((entry) => entry.id),
  );

const queueLines = (
  current: View,
  connection: Connection,
  keep: (entry: QueueEntry, position: number, song: SourceSummary) => boolean = () => true,
) =>
  Effect.map(artistMarks(connection), (mark) =>
    current.entries.flatMap((entry, position) => {
      const song = mark(entry.source);
      return keep(entry, position, song)
        ? [
            ...songLines(song, connection.enabledTags),
            field("Pos", position),
            field("Id", entry.id),
          ]
        : [];
    }),
  );

const songsLines = (songs: ReadonlyArray<SourceSummary>, connection: Connection) =>
  songs.flatMap((song) => songLines(song, connection.enabledTags));

const activeOutput = (current: View) =>
  Option.fromNullishOr(current.outputs.find((output) => output.id === current.playback.outputId));

const volumeOf = (current: View) =>
  Option.match(activeOutput(current), {
    onNone: () => -1,
    onSome: (output) => (output.volume === null ? -1 : Math.round(output.volume * 100)),
  });

const setVolume = (volume: number) =>
  Effect.gen(function* () {
    const output = activeOutput(yield* view);
    if (Option.isNone(output) || output.value.volume === null) {
      return yield* new Ack({ code: ackCode.unknown, message: "No mixer" });
    }
    yield* control(Command.SetVolume.make({ outputId: output.value.id, volume: volume / 100 }));
    return [];
  });

// Moves the entries so that the first one is at `to` in the new order
const move = (current: View, entryIds: ReadonlyArray<EntryId>, to: number) =>
  Effect.gen(function* () {
    const rest = current.entries.filter((entry) => !entryIds.includes(entry.id));
    if (to < 0 || to > rest.length) return yield* badIndex;
    if (!Arr.isReadonlyArrayNonEmpty(entryIds)) return [];
    const after = to === 0 ? null : (rest[to - 1]?.id ?? null);
    yield* control(Command.Move.make({ entryIds, after }), current.queueVersion);
    return [];
  });

// Adds the sources at `position`, or at the end when it is `null`
const enqueue = (
  sourceIds: ReadonlyArray<string>,
  position: number | null,
  context: typeof PlayContext.Type,
) =>
  Effect.gen(function* () {
    if (!Arr.isReadonlyArrayNonEmpty(sourceIds)) return [];
    const current = yield* view;
    if (position !== null && (position < 0 || position > current.entries.length)) {
      return yield* badIndex;
    }
    const before = position === null ? undefined : current.entries[position - 1];
    const toEnd = position === null || position === current.entries.length;
    // Dyad source IDs are UUIDs, so only the limit of the list can fail
    const command = yield* Command.Enqueue.makeEffect({
      sourceIds,
      context,
      after: toEnd || before === undefined ? "end" : before.id,
    }).pipe(Effect.mapError(() => commandAcks.queue_full));
    const entryIds = yield* control(command, toEnd ? null : current.queueVersion);
    // `Enqueue` cannot insert at the start
    if (!toEnd && before === undefined && Arr.isReadonlyArrayNonEmpty(entryIds)) {
      yield* control(Command.Move.make({ entryIds, after: null }));
    }
    return entryIds;
  });

const sourcesAt = (uri: string, connection: Connection) =>
  Effect.gen(function* () {
    const sourceId = sourceIdOf(uri);
    if (Option.isSome(sourceId)) return [sourceId.value];

    const tree = directoryTree((yield* library(connection)).songs);
    const path = directoryPath(uri);
    if (!tree.has(path)) {
      return yield* new Ack({ code: ackCode.noExist, message: "No such directory" });
    }
    return walk(tree, path).flatMap((entry) => (Predicate.isString(entry) ? [] : [entry.id]));
  });

const findSongs = (args: ReadonlyArray<string>, mode: "find" | "catalog", connection: Connection) =>
  Effect.gen(function* () {
    const filter = yield* parseFilter(args, mode);
    if (filter.query === null) return (yield* library(connection)).songs.filter(filter.matches);
    const found = yield* mirror.pipe(
      Effect.flatMap((mirror) => mirror.search(filter.query ?? "")),
      Effect.mapError(fromMirror),
    );
    const mark = yield* artistMarks(connection);
    return found.map(mark).filter(filter.matches);
  });

const findInQueue = (
  args: ReadonlyArray<string>,
  mode: "find" | "search",
  connection: Connection,
) =>
  Effect.gen(function* () {
    const filter = yield* parseFilter(args, mode);
    return yield* queueLines(yield* view, connection, (_, __, song) => filter.matches(song));
  });

// Splits trailing `group TAG` arguments off a filter
const groupsOf = (args: ReadonlyArray<string>) => {
  const rest = [...args];
  const groups: Array<string> = [];
  while (rest.length >= 2 && rest[rest.length - 2]?.toLowerCase() === "group") {
    const name = rest.pop() ?? "";
    rest.pop();
    groups.unshift(
      Option.match(queryTag(name), { onNone: () => name, onSome: ([label]) => label }),
    );
  }
  return { rest, groups };
};

// Stored playlists by the name that MPD shows. Names must be unique and not empty.
const playlistsByName = Effect.gen(function* () {
  const playlists = yield* mirror.pipe(
    Effect.flatMap((mirror) => mirror.playlists),
    Effect.mapError(fromMirror),
  );
  const named = new Map<string, string>();
  for (const playlist of playlists) {
    // ncmpcpp 0.5.10 crashes on a playlist without a name
    if (playlist.name.trim() === "") continue;
    let name = playlist.name;
    for (let count = 2; named.has(name); count += 1) name = `${playlist.name} [${count}]`;
    named.set(name, playlist.id);
  }
  return named;
});

const playlistSongs = (name: string) =>
  Effect.gen(function* () {
    const id = (yield* playlistsByName).get(name);
    if (id === undefined) {
      return yield* new Ack({ code: ackCode.noExist, message: "No such playlist" });
    }
    return yield* mirror.pipe(
      Effect.flatMap((mirror) => mirror.playlistSongs(id)),
      Effect.mapError(fromMirror),
    );
  });

const outputNumber = (server: Server, outputId: string) => {
  const number = server.outputNumbers.get(outputId) ?? server.outputNumbers.size;
  server.outputNumbers.set(outputId, number);
  return number;
};

const outputWithNumber = (current: View, server: Server, arg: string) =>
  Effect.gen(function* () {
    const number = yield* integer(arg);
    const output = current.outputs.find((output) => outputNumber(server, output.id) === number);
    if (output === undefined) return yield* commandAcks.output_unavailable;
    return output;
  });

// The outputs that play: the active output and the timed outputs in sync with it
const enabledOutputs = (current: View) =>
  current.playback.outputId === null ? [] : [current.playback.outputId, ...current.playback.group];

// As in MPD, enabling a second output plays on both, but only groupable outputs can play in sync
const enableCommand = (current: View, output: Output) => {
  const active = current.outputs.find((each) => each.id === current.playback.outputId);
  return active?.groupable === true && output.groupable
    ? Command.SetGroup.make({ outputIds: [output.id, ...enabledOutputs(current)] })
    : Command.Transfer.make({ outputId: output.id, play: null });
};

const disableCommand = (current: View, output: Output) => {
  const [first, ...rest] = enabledOutputs(current).filter((id) => id !== output.id);
  return first === undefined
    ? Command.Pause.make({})
    : Command.SetGroup.make({ outputIds: [first, ...rest] });
};

const artwork = (picture: boolean) =>
  handler(2, 2, ([uri = "", offsetArg = ""], connection) =>
    Effect.gen(function* () {
      const noFile = new Ack({ code: ackCode.noExist, message: "No file exists" });
      const sourceId = sourceIdOf(uri);
      if (Option.isNone(sourceId)) return yield* noFile;
      const offset = yield* integer(offsetArg);

      const cached = connection.artwork.get(sourceId.value);
      const image =
        cached ??
        (yield* mirror.pipe(
          Effect.flatMap((mirror) => mirror.artwork(sourceId.value)),
          Effect.mapError(fromMirror),
        ));
      connection.artwork.clear();
      connection.artwork.set(sourceId.value, image);

      // MPD answers `readpicture` without a picture with an empty response
      if (Option.isNone(image)) return picture ? [] : yield* noFile;
      const { bytes, mimeType } = image.value;
      if (offset < 0 || offset > bytes.length) return yield* invalid("Bad file offset");
      const chunk = bytes.subarray(offset, offset + (yield* Ref.get(connection.binaryLimit)));
      return [
        field("size", bytes.length),
        ...(picture ? [field("type", mimeType)] : []),
        field("binary", chunk.length),
        chunk,
      ];
    }),
  );

const skip = (direction: 1 | -1) =>
  Effect.gen(function* () {
    const { playback } = yield* view;
    if (playback.entryId === null || playback.state === "stopped") return yield* notPlaying;
    yield* control(Command.Skip.make({ fromEntryId: playback.entryId, direction }));
    return [];
  });

const resume = Effect.gen(function* () {
  if ((yield* view).entries.length === 0) return [];
  yield* control(Command.Resume.make({}));
  return [];
});

const play = (entry: QueueEntry) =>
  Effect.as(control(Command.JumpTo.make({ entryId: entry.id, positionMs: 0 })), []);

const seek = (current: View, entry: QueueEntry, time: string) =>
  Effect.gen(function* () {
    const positionMs = Math.max(0, (yield* decimal(time)) * 1000);
    const { entryId, state } = current.playback;
    // `Seek` keeps a pause, but it does not start a stopped entry
    yield* control(
      entry.id === entryId && state !== "stopped"
        ? Command.Seek.make({ entryId: entry.id, positionMs })
        : Command.JumpTo.make({ entryId: entry.id, positionMs }),
    );
    return [];
  });

// Accepts the entries in `positions` that changed after the queue version `version`
const changedSince = (current: View, version: string, positions: string | undefined) =>
  Effect.gen(function* () {
    const since = yield* integer(version);
    const length = current.entries.length;
    const [start, end] = positions === undefined ? [0, length] : yield* range(positions, length);
    return (_: QueueEntry, position: number) =>
      position >= start && position < end && (current.changedAt[position] ?? 0) > since;
  });

/** Commands that work before `password` */
export const openCommands: ReadonlyMap<string, Handler<never>> = new Map(
  Object.entries({
    password: handler(1, 1, ([password = ""], connection) =>
      Effect.gen(function* () {
        const valid = yield* connection.authenticate(Redacted.make(password));
        if (!valid) {
          return yield* new Ack({ code: ackCode.password, message: "incorrect password" });
        }
        return [];
      }),
    ),
    ping: handler(0, 0, () => ok),
    commands: handler(0, 0, (_, connection) =>
      Effect.map(Ref.get(connection.session), (session) =>
        [
          ...openCommands.keys(),
          "close",
          ...(Option.isSome(session) ? [...sessionCommands.keys(), "idle", "noidle"] : []),
        ]
          .sort()
          .map((name) => field("command", name)),
      ),
    ),
    notcommands: handler(0, 0, (_, connection) =>
      Effect.map(Ref.get(connection.session), (session) =>
        Option.isSome(session)
          ? []
          : [...sessionCommands.keys(), "idle", "noidle"]
              .sort()
              .map((name) => field("command", name)),
      ),
    ),
    tagtypes: handler(0, Infinity, ([action, ...names], connection) =>
      Effect.gen(function* () {
        const enabled = connection.enabledTags;
        if (action === undefined) {
          return tags.filter((tag) => enabled.has(tag)).map((tag) => field("tagtype", tag));
        }
        if (action === "all") {
          tags.forEach((tag) => enabled.add(tag));
          return [];
        }
        if (action === "clear") {
          enabled.clear();
          return [];
        }
        if (action !== "enable" && action !== "disable") {
          return yield* invalid("Unknown sub command");
        }
        if (names.length === 0) return yield* invalid("Not enough arguments");
        // ncmpc enables tags that the server did not list
        for (const tag of names.flatMap((name) => Option.toArray(tagNamed(name)))) {
          if (action === "enable") enabled.add(tag);
          if (action === "disable") enabled.delete(tag);
        }
        return [];
      }),
    ),
    binarylimit: handler(1, 1, ([limit = ""], connection) =>
      Effect.gen(function* () {
        const value = yield* integer(limit);
        if (value < 64) return yield* invalid("Value too small");
        yield* Ref.set(connection.binaryLimit, value);
        return [];
      }),
    ),
  }),
);

/** Commands that need a session */
export const sessionCommands: ReadonlyMap<string, Handler<Session>> = new Map(
  Object.entries({
    status: handler(0, 0, () =>
      Effect.gen(function* () {
        const current = yield* view;
        const now = (yield* Clock.currentTimeMillis) + current.clockOffset;
        const { playback, entries } = current;
        const index = entries.findIndex((entry) => entry.id === playback.entryId);
        const entry = entries[index];
        const next =
          entry === undefined ? undefined : nextEntry(entries, entry.id, playback.repeat, "end");
        const durationMs = entry?.source.durationMs ?? null;
        const elapsedMs = Math.max(0, Math.min(positionAt(playback, now), durationMs ?? Infinity));

        return [
          field("volume", volumeOf(current)),
          field("repeat", playback.repeat === "off" ? 0 : 1),
          field("random", playback.shuffle ? 1 : 0),
          field("single", playback.repeat === "one" ? 1 : 0),
          field("consume", 0),
          field("partition", "default"),
          field("playlist", current.queueVersion),
          field("playlistlength", entries.length),
          field("mixrampdb", 0),
          field("state", { stopped: "stop", paused: "pause", playing: "play" }[playback.state]),
          ...(entry === undefined ? [] : [field("song", index), field("songid", entry.id)]),
          ...(entry === undefined || playback.state === "stopped"
            ? []
            : [
                field(
                  "time",
                  `${Math.round(elapsedMs / 1000)}:${Math.round((durationMs ?? 0) / 1000)}`,
                ),
                field("elapsed", seconds(elapsedMs)),
                ...(durationMs === null ? [] : [field("duration", seconds(durationMs))]),
              ]),
          ...(next === undefined
            ? []
            : [field("nextsong", entries.indexOf(next)), field("nextsongid", next.id)]),
        ];
      }),
    ),
    currentsong: handler(0, 0, (_, connection) =>
      Effect.flatMap(view, (current) =>
        queueLines(current, connection, (entry) => entry.id === current.playback.entryId),
      ),
    ),
    stats: handler(0, 0, (_, connection) =>
      Effect.gen(function* () {
        const { songs, syncedAt } = yield* library(connection);
        const now = yield* Clock.currentTimeMillis;
        const totalMs = songs.reduce((total, song) => total + (song.durationMs ?? 0), 0);
        return [
          field("artists", new Set(songs.flatMap((song) => song.artist ?? [])).size),
          field("albums", new Set(songs.flatMap((song) => song.albumRef ?? song.album ?? [])).size),
          field("songs", songs.length),
          field("uptime", Math.floor((now - connection.server.startedAt) / 1000)),
          field("playtime", 0),
          field("db_playtime", Math.round(totalMs / 1000)),
          field("db_update", Math.floor(syncedAt / 1000)),
        ];
      }),
    ),
    clearerror: handler(0, 0, () => ok),

    play: handler(0, 1, ([position]) =>
      Effect.gen(function* () {
        if (position === undefined || position === "-1") return yield* resume;
        return yield* play(yield* entryAt(yield* view, position));
      }),
    ),
    playid: handler(0, 1, ([id]) =>
      Effect.gen(function* () {
        if (id === undefined || id === "-1") return yield* resume;
        return yield* play(yield* entryWithId(yield* view, id));
      }),
    ),
    pause: handler(0, 1, ([pause]) =>
      Effect.gen(function* () {
        const { playback } = yield* view;
        // MPDroid and ncmpcpp send `pause` without an argument to toggle
        if (pause === undefined && playback.state === "stopped") return [];
        const paused = pause === undefined ? playback.state === "playing" : yield* flag(pause);
        yield* control(paused ? Command.Pause.make({}) : Command.Resume.make({}));
        return [];
      }),
    ),
    stop: handler(0, 0, () => Effect.as(control(Command.Stop.make({})), [])),
    next: handler(0, 0, () => skip(1)),
    previous: handler(0, 0, () => skip(-1)),
    seek: handler(2, 2, ([position = "", time = ""]) =>
      Effect.gen(function* () {
        const current = yield* view;
        return yield* seek(current, yield* entryAt(current, position), time);
      }),
    ),
    seekid: handler(2, 2, ([id = "", time = ""]) =>
      Effect.gen(function* () {
        const current = yield* view;
        return yield* seek(current, yield* entryWithId(current, id), time);
      }),
    ),
    seekcur: handler(1, 1, ([time = ""]) =>
      Effect.gen(function* () {
        const { playback, clockOffset } = yield* view;
        const entryId = playback.entryId;
        if (entryId === null || playback.state === "stopped") return yield* notPlaying;
        const value = yield* decimal(time);
        const now = (yield* Clock.currentTimeMillis) + clockOffset;
        const relative = time.startsWith("+") || time.startsWith("-");
        const positionMs = Math.max(0, value * 1000 + (relative ? positionAt(playback, now) : 0));
        yield* control(Command.Seek.make({ entryId, positionMs }));
        return [];
      }),
    ),
    setvol: handler(1, 1, ([volume = ""]) =>
      Effect.gen(function* () {
        const value = yield* integer(volume);
        if (value > 100) return yield* invalid(`Number too large: ${value}`);
        if (value < 0) return yield* invalid(`Number too small: ${value}`);
        return yield* setVolume(value);
      }),
    ),
    volume: handler(1, 1, ([change = ""]) =>
      Effect.gen(function* () {
        const value = yield* integer(change.replace(/^\+/, ""));
        const current = volumeOf(yield* view);
        return yield* setVolume(Math.max(0, Math.min(100, current + value)));
      }),
    ),
    getvol: handler(0, 0, () =>
      Effect.map(view, (current) => {
        const volume = volumeOf(current);
        return volume < 0 ? [] : [field("volume", volume)];
      }),
    ),
    random: handler(1, 1, ([on = ""]) =>
      Effect.gen(function* () {
        yield* control(Command.SetShuffle.make({ on: yield* flag(on) }));
        return [];
      }),
    ),
    repeat: handler(1, 1, ([on = ""]) =>
      Effect.gen(function* () {
        const repeat = yield* flag(on);
        const { playback } = yield* view;
        if (repeat === (playback.repeat !== "off")) return [];
        yield* control(Command.SetRepeat.make({ mode: repeat ? "all" : "off" }));
        return [];
      }),
    ),
    // Dyad has no "stop after this song", so `single` means "repeat one"
    single: handler(1, 1, ([on = ""]) =>
      Effect.gen(function* () {
        if (on === "oneshot") {
          return yield* new Ack({ code: ackCode.unknown, message: "not supported" });
        }
        const single = yield* flag(on);
        const { playback } = yield* view;
        if (single === (playback.repeat === "one")) return [];
        yield* control(Command.SetRepeat.make({ mode: single ? "one" : "all" }));
        return [];
      }),
    ),
    consume: handler(1, 1, ([on = ""]) =>
      on === "0" ? ok : Effect.fail(new Ack({ code: ackCode.unknown, message: "not supported" })),
    ),
    crossfade: handler(1, 1, ([seconds = ""]) =>
      seconds === "0"
        ? ok
        : Effect.fail(new Ack({ code: ackCode.unknown, message: "not supported" })),
    ),

    add: handler(1, 2, ([uri = "", position], connection) =>
      Effect.gen(function* () {
        const sourceIds = yield* sourcesAt(uri, connection);
        const at = position === undefined ? null : yield* integer(position);
        yield* enqueue(sourceIds, at, "library");
        return [];
      }),
    ),
    addid: handler(1, 2, ([uri = "", position]) =>
      Effect.gen(function* () {
        const sourceId = sourceIdOf(uri);
        if (Option.isNone(sourceId)) return yield* commandAcks.entry_not_found;
        const at = position === undefined ? null : yield* integer(position);
        const [entryId] = yield* enqueue([sourceId.value], at, "library");
        return entryId === undefined ? [] : [field("Id", entryId)];
      }),
    ),
    delete: handler(1, 1, ([positions = ""]) =>
      Effect.gen(function* () {
        const current = yield* view;
        const entryIds = yield* entryIdsIn(current, positions);
        if (!Arr.isReadonlyArrayNonEmpty(entryIds)) return [];
        yield* control(Command.Remove.make({ entryIds }), current.queueVersion);
        return [];
      }),
    ),
    deleteid: handler(1, 1, ([id = ""]) =>
      Effect.gen(function* () {
        const entry = yield* entryWithId(yield* view, id);
        yield* control(Command.Remove.make({ entryIds: [entry.id] }));
        return [];
      }),
    ),
    move: handler(2, 2, ([positions = "", to = ""]) =>
      Effect.gen(function* () {
        const current = yield* view;
        return yield* move(current, yield* entryIdsIn(current, positions), yield* integer(to));
      }),
    ),
    moveid: handler(2, 2, ([id = "", to = ""]) =>
      Effect.gen(function* () {
        const current = yield* view;
        const entry = yield* entryWithId(current, id);
        return yield* move(current, [entry.id], yield* integer(to));
      }),
    ),
    clear: handler(0, 0, () => Effect.as(control(Command.Clear.make({ keepCurrent: false })), [])),
    playlistinfo: handler(0, 1, ([positions], connection) =>
      Effect.gen(function* () {
        const current = yield* view;
        // ncmpc and mpc send `-1` for the whole queue
        if (positions === undefined || positions === "-1") {
          return yield* queueLines(current, connection);
        }
        const [start, end] = yield* range(positions, current.entries.length);
        return yield* queueLines(
          current,
          connection,
          (_, position) => position >= start && position < end,
        );
      }),
    ),
    playlistid: handler(0, 1, ([id], connection) =>
      Effect.gen(function* () {
        const current = yield* view;
        if (id === undefined) return yield* queueLines(current, connection);
        const entry = yield* entryWithId(current, id);
        return yield* queueLines(current, connection, (candidate) => candidate === entry);
      }),
    ),
    plchanges: handler(1, 2, ([version = "", positions], connection) =>
      Effect.gen(function* () {
        const current = yield* view;
        return yield* queueLines(
          current,
          connection,
          yield* changedSince(current, version, positions),
        );
      }),
    ),
    plchangesposid: handler(1, 2, ([version = "", positions]) =>
      Effect.gen(function* () {
        const current = yield* view;
        const changed = yield* changedSince(current, version, positions);
        return current.entries.flatMap((entry, position) =>
          changed(entry, position) ? [field("cpos", position), field("Id", entry.id)] : [],
        );
      }),
    ),
    playlistfind: handler(1, Infinity, (args, connection) => findInQueue(args, "find", connection)),
    playlistsearch: handler(1, Infinity, (args, connection) =>
      findInQueue(args, "search", connection),
    ),

    lsinfo: handler(0, 1, ([uri = ""], connection) =>
      Effect.gen(function* () {
        const { songs } = yield* library(connection);
        const sourceId = sourceIdOf(uri);
        if (Option.isSome(sourceId)) {
          return songsLines(
            songs.filter((song) => song.id === sourceId.value),
            connection,
          );
        }

        const path = directoryPath(uri);
        const directory = directoryTree(songs).get(path);
        if (directory === undefined) {
          return yield* new Ack({ code: ackCode.noExist, message: "No such directory" });
        }
        // mpc `lsplaylists` reads the playlists of the root
        const playlists = path === "" ? [...(yield* playlistsByName).keys()] : [];
        return [
          ...directory.directories.map((child) => field("directory", child)),
          ...songsLines(directory.songs, connection),
          ...playlists.map((name) => field("playlist", name)),
        ];
      }),
    ),
    listall: handler(0, 1, ([uri = ""], connection) =>
      Effect.gen(function* () {
        const tree = directoryTree((yield* library(connection)).songs);
        const path = directoryPath(uri);
        if (!tree.has(path)) {
          return yield* new Ack({ code: ackCode.noExist, message: "No such directory" });
        }
        return walk(tree, path).map((entry) =>
          Predicate.isString(entry) ? field("directory", entry) : field("file", songUri(entry.id)),
        );
      }),
    ),
    listallinfo: handler(0, 1, ([uri = ""], connection) =>
      Effect.gen(function* () {
        const tree = directoryTree((yield* library(connection)).songs);
        const path = directoryPath(uri);
        if (!tree.has(path)) {
          return yield* new Ack({ code: ackCode.noExist, message: "No such directory" });
        }
        return walk(tree, path).flatMap((entry) =>
          Predicate.isString(entry)
            ? [field("directory", entry)]
            : songLines(entry, connection.enabledTags),
        );
      }),
    ),
    list: handler(1, Infinity, ([name = "", ...args], connection) =>
      Effect.gen(function* () {
        const query = queryTag(name);
        // Dyad has no values for other MPD tags, for example the `Genre` of Cantata
        if (Option.isNone(query)) return [];
        const [label, tag] = query.value;
        const { rest, groups } = groupsOf(args);
        // MPD before 0.21: `list Album ARTIST`
        const [artist] = rest;
        const legacy = rest.length === 1 && artist !== undefined && !artist.startsWith("(");
        if (legacy && label !== "Album") {
          return yield* invalid('should be "Album" for 3 arguments');
        }
        const filter = yield* parseFilter(legacy ? ["Artist", artist] : rest, "find");
        const songs = (yield* library(connection)).songs.filter(filter.matches);

        const rows = new Map<string, ReadonlyArray<string>>();
        for (const song of songs) {
          const value = tagValue(song, tag);
          if (value === null) continue;
          const row = [...groups.map((group) => tagText(song, group)), value];
          rows.set(row.join("\n"), row);
        }
        // Column by column, so that the rows of a group stay together. `localeCompare` sees no
        // difference between names that differ only in marks.
        const sorted = [...rows.values()].sort((left, right) => {
          const column = left.findIndex((value, index) => value !== right[index]);
          const [a = "", b = ""] = [left[column], right[column]];
          return a.localeCompare(b) || (a < b ? -1 : 1);
        });

        const columns = [...groups, label];
        return sorted.flatMap((row, index) => {
          const previous = sorted[index - 1];
          const changedAt = row.findIndex((value, column) => previous?.[column] !== value);
          return row.flatMap((value, column) =>
            column >= changedAt ? [field(columns[column] ?? "", value)] : [],
          );
        });
      }),
    ),
    find: handler(1, Infinity, (args, connection) =>
      Effect.map(findSongs(args, "find", connection), (songs) => songsLines(songs, connection)),
    ),
    search: handler(1, Infinity, (args, connection) =>
      Effect.map(findSongs(args, "catalog", connection), (songs) => songsLines(songs, connection)),
    ),
    findadd: handler(1, Infinity, (args, connection) =>
      Effect.gen(function* () {
        const songs = yield* findSongs(args, "find", connection);
        yield* enqueue(
          songs.map((song) => song.id),
          null,
          "library",
        );
        return [];
      }),
    ),
    searchadd: handler(1, Infinity, (args, connection) =>
      Effect.gen(function* () {
        const songs = yield* findSongs(args, "catalog", connection);
        yield* enqueue(
          songs.map((song) => song.id),
          null,
          "search",
        );
        return [];
      }),
    ),
    count: handler(1, Infinity, (args, connection) =>
      Effect.gen(function* () {
        const { rest, groups } = groupsOf(args);
        const filter = yield* parseFilter(rest, "find");
        const songs = (yield* library(connection)).songs.filter(filter.matches);
        const totals = (songs: ReadonlyArray<SourceSummary>) => [
          field("songs", songs.length),
          field(
            "playtime",
            Math.round(songs.reduce((total, song) => total + (song.durationMs ?? 0), 0) / 1000),
          ),
        ];
        const [group] = groups;
        if (group === undefined) return totals(songs);

        const byValue = new Map<string, Array<SourceSummary>>();
        for (const song of songs) {
          const value = tagText(song, group);
          const matching = byValue.get(value) ?? [];
          matching.push(song);
          byValue.set(value, matching);
        }
        return [...byValue.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .flatMap(([value, songs]) => [field(group, value), ...totals(songs)]);
      }),
    ),
    update: handler(0, 1, () =>
      mirror.pipe(
        Effect.flatMap((mirror) => mirror.sync),
        Effect.mapError(fromMirror),
        Effect.as([field("updating_db", 1)]),
      ),
    ),

    listplaylists: handler(0, 0, () =>
      Effect.map(playlistsByName, (playlists) =>
        [...playlists.keys()].map((name) => field("playlist", name)),
      ),
    ),
    listplaylist: handler(1, 1, ([name = ""]) =>
      Effect.map(playlistSongs(name), (songs) =>
        songs.map((song) => field("file", songUri(song.id))),
      ),
    ),
    listplaylistinfo: handler(1, 1, ([name = ""], connection) =>
      Effect.gen(function* () {
        const songs = yield* playlistSongs(name);
        const mark = yield* artistMarks(connection);
        return songsLines(songs.map(mark), connection);
      }),
    ),
    load: handler(1, 2, ([name = "", positions]) =>
      Effect.gen(function* () {
        const songs = yield* playlistSongs(name);
        const [start, end] =
          positions === undefined ? [0, songs.length] : yield* range(positions, songs.length);
        yield* enqueue(
          songs.slice(start, end).map((song) => song.id),
          null,
          "library",
        );
        return [];
      }),
    ),

    albumart: artwork(false),
    // Dyad has no embedded pictures, so `readpicture` gives the same art; rmpc asks for it first
    readpicture: artwork(true),

    outputs: handler(0, 0, (_, connection) =>
      Effect.map(view, (current) =>
        current.outputs
          .map((output) => ({ output, number: outputNumber(connection.server, output.id) }))
          .sort((left, right) => left.number - right.number)
          .flatMap(({ output, number }) => [
            field("outputid", number),
            field("outputname", output.name),
            field("plugin", output.kind),
            field("outputenabled", enabledOutputs(current).includes(output.id) ? 1 : 0),
          ]),
      ),
    ),
    enableoutput: handler(1, 1, ([number = ""], connection) =>
      Effect.gen(function* () {
        const current = yield* view;
        const output = yield* outputWithNumber(current, connection.server, number);
        yield* control(enableCommand(current, output));
        return [];
      }),
    ),
    disableoutput: handler(1, 1, ([number = ""], connection) =>
      Effect.gen(function* () {
        const current = yield* view;
        const output = yield* outputWithNumber(current, connection.server, number);
        if (enabledOutputs(current).includes(output.id)) {
          yield* control(disableCommand(current, output));
        }
        return [];
      }),
    ),
    toggleoutput: handler(1, 1, ([number = ""], connection) =>
      Effect.gen(function* () {
        const current = yield* view;
        const output = yield* outputWithNumber(current, connection.server, number);
        yield* control(
          enabledOutputs(current).includes(output.id)
            ? disableCommand(current, output)
            : enableCommand(current, output),
        );
        return [];
      }),
    ),

    // ncmpcpp shows an error for an ACK, so these answer with nothing
    urlhandlers: handler(0, 0, () => ok),
    decoders: handler(0, 0, () => ok),
    // ncmpc asks on its outputs screen
    listpartitions: handler(0, 0, () => Effect.succeed([field("partition", "default")])),
  }),
);
