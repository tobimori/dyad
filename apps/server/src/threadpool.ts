// `node-av` 6.1.1 holds a libuv worker while FFmpeg waits for bytes from JavaScript, and those bytes
// can need a worker too (cache writes, DNS). With the default 4 workers, 4 streams stop the server.
process.env["UV_THREADPOOL_SIZE"] ??= "64";
