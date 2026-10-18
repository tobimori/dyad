import { Data } from "effect";

/** The receiver wants a password, and none was given or it was wrong */
export class AirPlayAuthRequired extends Data.TaggedError("AirPlayAuthRequired")<{
  readonly device: string;
}> {}

/** The receiver needs AirPlay 2 pairing, FairPlay or an audio format that RAOP here does not send */
export class AirPlayUnsupported extends Data.TaggedError("AirPlayUnsupported")<{
  readonly device: string;
  readonly reason: string;
}> {}

/** A socket failed, closed or timed out */
export class AirPlayNetworkError extends Data.TaggedError("AirPlayNetworkError")<{
  readonly device: string;
  readonly cause: unknown;
}> {}

/** The receiver answered an RTSP request with an error status, for example 453 when it is busy */
export class AirPlayRequestFailed extends Data.TaggedError("AirPlayRequestFailed")<{
  readonly device: string;
  readonly method: string;
  readonly status: number;
}> {}

export type AirPlayError =
  | AirPlayAuthRequired
  | AirPlayUnsupported
  | AirPlayNetworkError
  | AirPlayRequestFailed;
