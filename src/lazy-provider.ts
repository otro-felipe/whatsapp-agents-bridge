import {
  BridgeError,
  type BridgeMessage,
  type CredentialStore,
  type ProviderEvents,
  type ProviderFactory,
  type ProviderPort,
} from "./types.js";

const loadBaileys = async (): Promise<ProviderFactory> => {
  const { BaileysProvider } = await import("./baileys-provider.js");
  return (accountId, auth, events) =>
    new BaileysProvider(accountId, auth, events);
};

/** Cancellation must cover module loading as well as an already-open socket. */
export class LazyProvider implements ProviderPort {
  private provider: ProviderPort | undefined;
  private loading: Promise<ProviderPort> | undefined;
  private closed = false;
  constructor(
    private readonly accountId: string,
    private readonly auth: CredentialStore,
    private readonly events: ProviderEvents,
    private readonly loader = loadBaileys,
  ) {}
  private async load() {
    if (this.closed) throw new BridgeError("pairing_cancelled", 409);
    this.loading ??= this.loader()
      .then((factory) => {
        if (this.closed) throw new BridgeError("pairing_cancelled", 409);
        return (this.provider = factory(
          this.accountId,
          this.auth,
          this.events,
        ));
      })
      .catch((error) => {
        this.loading = undefined;
        throw error;
      });
    const provider = await this.loading;
    if (this.closed) throw new BridgeError("pairing_cancelled", 409);
    return provider;
  }
  async connect(options?: { allowPairing: boolean }) {
    await (await this.load()).connect(options);
  }
  async requestPairingCode(phoneNumber: string) {
    const provider = await this.load();
    if (!provider.requestPairingCode)
      throw new BridgeError("pairing_code_unavailable", 501);
    return provider.requestPairingCode(phoneNumber);
  }
  async send(input: Parameters<ProviderPort["send"]>[0]) {
    if (this.closed || !this.provider)
      throw new BridgeError("provider_not_started", 409);
    return this.provider.send(input);
  }
  async downloadAttachment(input: { attachmentId: string }) {
    if (this.closed || !this.provider)
      throw new BridgeError("provider_not_started", 409);
    if (!this.provider.downloadAttachment)
      throw new BridgeError("attachment_unavailable", 404);
    return this.provider.downloadAttachment(input);
  }
  async close() {
    this.closed = true;
    await this.provider?.close();
  }
  async logout() {
    this.closed = true;
    await this.provider?.logout();
  }
}
