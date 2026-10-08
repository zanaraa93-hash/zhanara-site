// Runs one parser in a separate process. Native code inside document
// libraries can crash hard (segfault); in a worker thread that would take the
// whole server down, in a child process it only ends this process.
process.once("message", async ({ modulePath, buffer, options }) => {
  let reply;
  try {
    const text = await require(modulePath).parse(Buffer.from(buffer), options || {});
    reply = { ok: true, text: String(text || "") };
  } catch (err) {
    reply = { ok: false, error: String(err?.message || err) };
  }
  process.send(reply, () => process.exit(0));
});
