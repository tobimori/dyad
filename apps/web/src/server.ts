import handler from "@tanstack/react-start/server-entry";

export const clientAssetsUrl = new URL("../client/", import.meta.url);

export default handler;
