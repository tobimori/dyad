import { AlbumRef, ArtistRef } from "@dyad/domain";
import { Option } from "effect";

// Page refs are `<namespace>:<id>`. Everything after the namespace comes from the client and is
// untrusted. `encodeURIComponent` keeps a `/` in a key, for example in `ac/dc`, from splitting an
// album ref.

const libraryPrefix = "library:";

const decodeKey = Option.liftThrowable(decodeURIComponent);

/** `library:<artist key>`, where the key is the `norm_v1` of the name */
export const libraryArtistRef = (artistKey: string) =>
  ArtistRef.make(`${libraryPrefix}${encodeURIComponent(artistKey)}`);

/** `library:<album artist key>/<album key>` */
export const libraryAlbumRef = (albumArtistKey: string, albumKey: string) =>
  AlbumRef.make(
    `${libraryPrefix}${encodeURIComponent(albumArtistKey)}/${encodeURIComponent(albumKey)}`,
  );

/** The artist key of a library artist ref. `None` for another namespace or a malformed ref. */
export const libraryArtistKey = (ref: string) =>
  ref.startsWith(libraryPrefix) && !ref.includes("/")
    ? decodeKey(ref.slice(libraryPrefix.length))
    : Option.none();

/** The two keys of a library album ref. `None` for another namespace or a malformed ref. */
export const libraryAlbumKeys = (ref: string) => {
  if (!ref.startsWith(libraryPrefix)) return Option.none();

  const [albumArtistKey, albumKey, ...rest] = ref.slice(libraryPrefix.length).split("/");
  if (albumArtistKey === undefined || albumKey === undefined || rest.length > 0) {
    return Option.none();
  }

  return Option.all([decodeKey(albumArtistKey), decodeKey(albumKey)]);
};
