import {
  AlbumRef,
  ArtistRef,
  catalogRefPrefix as catalogPrefix,
  libraryRefPrefix as libraryPrefix,
} from "@dyad/domain";
import { Option } from "effect";

export { libraryAlbumRef, libraryArtistRef } from "@dyad/domain";

// Everything after the namespace comes from the client and is untrusted
const decodeKey = Option.liftThrowable(decodeURIComponent);

/** `<provider>:<external ID>` */
export const providerArtistRef = (provider: string, externalId: string) =>
  ArtistRef.make(`${provider}:${externalId}`);

export const providerAlbumRef = (provider: string, externalId: string) =>
  AlbumRef.make(`${provider}:${externalId}`);

/** The provider and the external ID of a provider ref. `None` for a library or catalog ref. */
export const providerRefParts = (ref: string) => {
  const separator = ref.indexOf(":");
  const provider = ref.slice(0, separator);
  const externalId = ref.slice(separator + 1);
  return separator < 1 ||
    externalId === "" ||
    ref.startsWith(libraryPrefix) ||
    ref.startsWith(catalogPrefix)
    ? Option.none()
    : Option.some({ provider, externalId });
};

/** The artist ID of a catalog artist ref */
export const catalogArtistId = (ref: string) =>
  ref.startsWith(catalogPrefix) ? Option.some(ref.slice(catalogPrefix.length)) : Option.none();

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
