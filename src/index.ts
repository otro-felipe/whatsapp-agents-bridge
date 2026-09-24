import { BridgeStore } from "./store.js";
import { BridgeService } from "./service.js";
import { createHttpServer } from "./http.js";
import type { ProviderFactory } from "./types.js";
import { LazyProvider } from "./lazy-provider.js";
export * from "./types.js";
export { BridgeStore, BridgeService };
export { BridgeClient } from "./client.js";
export { createMcpServer } from "./mcp.js";
export async function startBridge(options: {
  dataDir: string;
  token: string;
  masterKey: Uint8Array;
  port?: number;
  retentionDays?: number;
  historyRetentionDays?: number | null;
  allowedOrigins?: string[];
  providerFactory?: ProviderFactory;
  now?: () => Date;
  pairingRequestTimeoutMs?: number;
}) {
  const store = new BridgeStore(
    options.dataDir,
    options.masterKey,
    options.now,
    options.retentionDays,
    options.historyRetentionDays,
  );
  const factory =
    options.providerFactory ??
    ((accountId, auth, events) => {
      return new LazyProvider(accountId, auth, events);
    });
  const service = new BridgeService(
    store,
    factory,
    options.now,
    options.pairingRequestTimeoutMs,
  );
  let http: Awaited<ReturnType<typeof createHttpServer>> | undefined;
  try {
    http = await createHttpServer(
      service,
      options.token,
      options.port,
      options.allowedOrigins,
    );
    await service.restore();
  } catch (error) {
    await service.close();
    await http?.close();
    store.close();
    throw error;
  }
  const listening = http;
  let closed = false;
  const prune = setInterval(() => store.prune(), 60 * 60_000);
  prune.unref();
  return {
    port: listening.port,
    store,
    service,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(prune);
      await service.close();
      await listening.close();
      store.close();
    },
  };
}
export type BridgeInstance = Awaited<ReturnType<typeof startBridge>>;
