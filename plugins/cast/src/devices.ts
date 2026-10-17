import { Stream } from "effect";

import { openCast } from "./castv2/cast.ts";
import { castDevices } from "./castv2/mdns.ts";
import { upnpDevices } from "./upnp/ssdp.ts";
import { CastDevice } from "./target.ts";
import type { Device } from "./target.ts";
import { openUpnp } from "./upnp/upnp.ts";

/**
 * Finds UPnP MediaRenderers, Sonos rooms, Cast devices and Cast groups on the local network. It
 * searches again until the stream ends, and emits a device again when its address changes.
 */
export const discover = Stream.merge(upnpDevices, castDevices);

/** Opens `device` as a target until the scope closes */
export const openTarget = (device: Device) =>
  device instanceof CastDevice ? openCast(device) : openUpnp(device);
