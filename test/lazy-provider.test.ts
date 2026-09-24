import test from "node:test";
import assert from "node:assert/strict";
import { LazyProvider } from "../src/lazy-provider.js";
import type {
  CredentialStore,
  ProviderEvents,
  ProviderFactory,
} from "../src/types.js";

test("cancel while importing a provider prevents late construction or socket work", async () => {
  let resolve!: (factory: ProviderFactory) => void,
    constructed = 0;
  const loader = new Promise<ProviderFactory>((done) => (resolve = done));
  const provider = new LazyProvider(
    "default",
    {} as CredentialStore,
    {} as ProviderEvents,
    () => loader,
  );
  const pending = provider.requestPairingCode("15551234567");
  const rejected = assert.rejects(pending, /pairing_cancelled/);
  await provider.close();
  resolve(() => {
    constructed++;
    throw new Error("must_not_construct");
  });
  await rejected;
  assert.equal(constructed, 0);
});
