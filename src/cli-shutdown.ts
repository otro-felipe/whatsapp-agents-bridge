export function createCliShutdown() {
  let close: (() => Promise<void>) | undefined;
  let requested = false;
  let stopping = false;

  const dispose = () => {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    process.off("message", message);
    process.off("disconnect", stop);
    if (process.connected) process.disconnect?.();
  };
  const stop = () => {
    requested = true;
    if (!close || stopping) return;
    stopping = true;
    void close()
      .then(() => {
        process.exitCode = 0;
      })
      .catch(() => {
        process.stderr.write(
          JSON.stringify({ error: "shutdown_failed" }) + "\n",
        );
        process.exitCode = 1;
      })
      .finally(dispose);
  };
  const message = (value: unknown) => {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      "type" in value &&
      value.type === "shutdown"
    )
      stop();
  };

  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  if (typeof process.send === "function") {
    process.on("message", message);
    process.on("disconnect", stop);
    if (!process.connected) stop();
  }

  return {
    get requested() {
      return requested;
    },
    setCloseHandler(handler: () => Promise<void>) {
      close = handler;
      if (requested) stop();
    },
    dispose,
  };
}
