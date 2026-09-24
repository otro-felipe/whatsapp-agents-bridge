# WhatsApp Agents Bridge

A local, agent-agnostic WhatsApp transport with an authenticated HTTP API, durable SSE events, encrypted SQLite storage, and an MCP client. The bridge moves text messages and attachments in individual and group chats; your host decides which agents run, who may activate them, what context they receive, and which actions they may take.

Node.js 24 or newer is required. MIT licensed. Baileys is pinned to the official `@whiskeysockets/baileys@7.0.0-rc14` package. This is an unofficial WhatsApp integration; it is not the WhatsApp Business Platform.

## Install and validate

Clone the repository with Node.js 24 or newer and npm available:

```sh
git clone https://github.com/otro-felipe/whatsapp-agents-bridge.git
cd whatsapp-agents-bridge
npm ci --ignore-scripts
npm run validate
```

`npm ci` uses the committed lockfile; `--ignore-scripts` skips dependency lifecycle scripts. `npm run validate` runs the synthetic test suite, TypeScript checks, and the build. You can run `npm test`, `npm run check`, and `npm run build` separately; `npm run format:check` checks source and documentation formatting.

The tests use temporary databases, synthetic identities and fake transports. They never pair a real account or send a real message, and they do not require WhatsApp credentials. `dist/cli.js` is the compiled entry point; `dist/index.js` exports the HTTP SDK and injectable server used by integration tests.

This repository contains only the transport and its generic integration boundaries. It does not require Team Agents or another agent host to install, build, or test. A supervising application supplies protected runtime state and credentials when starting a real provider; keep those outside this checkout.

### Windows

See the [Windows setup guide in Spanish](docs/windows.md) for PowerShell commands, Node.js installation, synthetic checks and private state under `%LOCALAPPDATA%`. This is a supervised bridge/SDK, not an installed chat application. A host must manage persistent credentials and explicit account linking. Windows support is checked by the platform CI jobs; consult their results for the revision you use.

## Public source and private state

The public repository contains source, documentation, examples and synthetic tests. Keep real credentials, QR material, pairing codes, conversations, runtime databases and local reports outside Git. `.gitignore` excludes private and generated files, but it does not remove files that Git already tracks.

Before pushing, scan all local Git history with [Gitleaks](https://github.com/gitleaks/gitleaks):

```sh
gitleaks git --config .gitleaks.toml --redact=100 --no-banner --ignore-gitleaks-allow --log-opts="--all" .
```

The repository's CI repeats this secret scan. Scanning complements review of the exact files and changes being published.

## Start the dedicated bridge process

```sh
node dist/cli.js serve --port 0 --data-dir /absolute/private/state/directory --retention-days 7 --history-retention-days forever
```

The process expects one newline-terminated JSON object on stdin containing `token` and `masterKey`. Obtain these from the supervising application's protected secret store and write directly to the child pipe. `token` must be 32–512 characters without whitespace. `masterKey` must be exactly 32 random bytes encoded as canonical standard base64. Keep the same master key across restarts. Never place either value in command arguments, source, logs, or a checked-in configuration file.

The supervisor can close stdin after the configuration line. The server stays alive and writes exactly one readiness line to stdout: `{"port":12345}`. It binds exclusively to `127.0.0.1`; `--port 0` selects an available port. For portable graceful shutdown, launch the child with a Node IPC channel and send `{type:"shutdown"}` through that channel. A parent IPC disconnect also closes the bridge. On POSIX, SIGTERM/SIGINT remain supported. Graceful shutdown closes the provider, marks pending sends uncertain, closes HTTP and SQLite, and exits. Startup reconnects an existing linked account; creating a new pairing requires the explicit link API.

For an existing secret-injection environment, `node examples/serve-from-env.mjs --data-dir /absolute/private/state/directory` forwards `WHATSAPP_BRIDGE_TOKEN` and `WHATSAPP_BRIDGE_MASTER_KEY` to the child through stdin and supervises shutdown through IPC. Those credential variables are removed from the child's environment without relying on their letter case. The launcher does not generate, display, or persist keys. The application managing those environment variables remains responsible for durable secret storage.

Use the dedicated CLI for the real Baileys provider. Some transitive Signal code logs raw session objects through `console`; the CLI suppresses third-party console methods before importing Baileys, and the provider logger is silent. Embedding the real provider in another process is not a supported production path. Embedding `BridgeClient` or the server with a synthetic `providerFactory` is supported.

## HTTP API

Every endpoint requires `Authorization: Bearer <token>`, including health and event streams. The exact Host must be `127.0.0.1:PORT` or `localhost:PORT`. Requests with an Origin are rejected by default. An embedding supervisor may supply an explicit Origin allowlist. Tokens never appear in URLs. JSON errors have the shape `{"error":{"code":"safe_code"}}`; raw provider errors are not returned.

| Method | Path                                                                     | Response / behavior                                                                                                                     |
| ------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                                                                | `{status:"ok",version:1}`                                                                                                               |
| GET    | `/v1/accounts`                                                           | `{accounts:[{accountId,state,identityId?,identityIds?,diagnosticCode?}]}`                                                               |
| POST   | `/v1/accounts/default/link`                                              | JSON `{}`; starts explicit pairing, returns 202 `{state}`                                                                               |
| GET    | `/v1/accounts/default/link`                                              | `{state,qr?}`; the only endpoint returning QR data                                                                                      |
| DELETE | `/v1/accounts/default/link`                                              | Unlinks the provider and removes credentials; `{state:"logged_out"}`                                                                    |
| GET    | `/v1/chats?accountId=default`                                            | Up to 500 retained individual/group chats, most recently active first                                                                   |
| GET    | `/v1/chats/:chatId/messages?accountId=default&limit=50&before=messageId` | `{messages,nextBefore?}`; newest page by default, older pages with `before`, forward pages with `after`; cursors are mutually exclusive |
| POST   | `/v1/messages`                                                           | Send request below; returns `{send}`                                                                                                    |
| GET    | `/v1/sends/:sendId`                                                      | `{send}`; never retries a send                                                                                                          |
| GET    | `/v1/events`                                                             | SSE stream; resumes from Last-Event-ID, `?after=`, or the saved checkpoint                                                              |
| GET    | `/v1/events/head`                                                        | `{eventId}` for explicit resynchronization                                                                                              |
| GET    | `/v1/events/checkpoint`                                                  | `{eventId}` for the current bearer consumer                                                                                             |
| POST   | `/v1/checkpoint`                                                         | JSON `{eventId:"123"}`; monotonic, bounded by the durable head                                                                          |

The first release supports one account named `default`. Each account also includes `history:{storedMessages,retentionDays}`: local record count and the configured archive lifetime (`null` means indefinite). Counts are safe metadata and do not prove complete WhatsApp synchronization. Account states are `disconnected`, `linking`, `connected`, `reconnecting`, `logged_out`, and `error`. Identity metadata comes from authenticated Baileys owner PN/LID data. Display names or text never prove ownership. URL-encode chat IDs using `encodeURIComponent`; individual chat IDs end in `@s.whatsapp.net` or `@lid`; modern numeric and legacy numeric-numeric group IDs end in `@g.us`. Broadcast, status and newsletter addresses remain unsupported. Group IDs are conversation addresses, never PN/LID identities.

`connectionDiagnostics` contains durable `attempts` and `disconnects` counters, optional store-generated `lastAttemptAt`/`lastDisconnectAt` timestamps and `lastDisconnectStatus`. The last status is exposed only when the provider supplies an integer between 100 and 599; an unrecognized subsequent disconnect clears that field. Raw error messages, objects and provider payloads never enter these diagnostics. Counters survive restart and describe connection activity, not message delivery or history completion.

Send requests contain `accountId`, `chatId`, `text`, `idempotencyKey`, and optional `quoteMessageId`. Text is capped at 4,096 characters / 16 KiB; the JSON request limit is 32 KiB. Quotes must reference a retained message in the same account and chat. URL previews are disabled; text links do not cause the bridge to fetch their destinations.

Send records contain `sendId`, `accountId`, `chatId`, `messageId`, `idempotencyKey`, `status`, and ISO `createdAt`. Status is `reserved`, `sending`, `sent`, or `delivery_unknown`. The provider message ID and idempotency record are persisted **before** sending. Repeating the same request returns the same operation. Reusing a key for different content returns 409. Provider exceptions, timeouts, shutdowns and process interruption produce uncertain delivery; they do not trigger a blind resend. A later matching provider echo or acknowledgement may reconcile the record to `sent`. Here `sent` means accepted by the provider, not read by the recipient. Never mint a new idempotency key merely because the previous delivery is unknown.

QR material is held only in memory with a 60-second lifetime and is cleared when pairing progresses or is cancelled. Never route the QR endpoint through an agent tool, diagnostics, SSE, screenshots, or logs. The supervising UI may present it directly to the owner as part of the explicit pairing flow.

## Pair with a phone number and code

`POST /v1/accounts/default/pairing-code` accepts JSON `{phoneNumber}` with an international E.164 number containing 7–15 digits, a nonzero first digit and no plus sign or punctuation. Authentication and Host/Origin validation are identical to the other endpoints. A linked account returns `409 already_linked`.

The explicit response is `{state:"linking",code,expiresAt}`. The code is eight uppercase alphanumeric characters. The adapter waits for its internal QR readiness event before invoking Baileys `requestPairingCode`; it does not expose that QR during code pairing. Enter the returned code through the phone's WhatsApp linked-device flow. This request initiates account pairing, so the supervising UI must obtain the owner's intent before making it.

The code appears only in this POST response. It is never returned from general account state, `GET .../link`, events, MCP, logs or a retry. Only the provider's encrypted authentication record may retain its protocol copy. The bridge expires an incomplete attempt 60 seconds after successful generation and closes that unlinked socket. A successfully linked account is preserved. `DELETE /v1/accounts/default/link` cancels the attempt and invalidates pending or late responses, including cancellation while the provider module is loading.

Only one request/issued code may be pending per account. A 60-second cooldown starts when a valid generation attempt is admitted; encrypted system metadata preserves it across cancellation and restarts. A failed or timed-out request is never retried automatically. The HTTP generation wait is capped at 12 seconds. Safe error codes are `invalid_phone_number` (400), `already_linked`, `pairing_in_progress`, `pairing_cancelled` (409), `pairing_cooldown` (429), `pairing_code_unavailable` (501), `pairing_failed` (502), and `pairing_timeout` (504). Raw provider errors and phone numbers are not echoed in errors.

This implementation follows the [official Baileys connection and pairing-code guidance](https://github.com/WhiskeySockets/baileys.wiki-site/blob/main/docs/socket/connecting.md). Tests cover HTTP validation, one-time output, cancellation races, expiry, errors, encrypted persistence and socket readiness using synthetic providers. No live code generation was performed by these tests.

## Events, replay and identity

Each SSE event has decimal-string ID, event name `message`, and JSON data:

```json
{
  "eventId": "123",
  "type": "message",
  "message": {
    "accountId": "default",
    "chatId": "56922222222@s.whatsapp.net",
    "messageId": "synthetic-message-id",
    "authorId": "56911111111@s.whatsapp.net",
    "text": "synthetic message",
    "timestamp": "2026-09-05T12:00:00.000Z",
    "fromMe": true,
    "origin": "live",
    "identityVerified": true,
    "forwarded": false,
    "quoted": false
  }
}
```

Origins are `live`, `history`, `bridge`, `edit`, and `delete`. Baileys startup/backfill traffic remains history until initial pending notifications drain, and stale/replayed messages do not become fresh commands. Full batches are processed. Original messages deduplicate on account/chat/provider ID. Provider edit wrappers become edits; revokes and deletion keys become empty tombstones. Echoes of IDs reserved by this bridge are marked `bridge` even when `fromMe` is true. Quoted and forwarded metadata comes from the provider; quoted text is never extracted as a new message. Attachment captions are direct text; filenames are metadata, never instructions. View-once content and disappearing-message wrappers remain excluded. In groups, a new incoming message requires an authenticated PN/LID participant. Only the linked account’s own `fromMe` messages can represent its owner; group membership or admin status grants no owner authority. Group edits/deletes without a participant remain non-triggering updates with unknown/unverified authors.

Only fresh, verified messages should trigger your host. A typical host also rejects forwarded/quoted administrative commands and compares `fromMe` plus `authorId` to authenticated account identity aliases. The bridge itself does not interpret agent activation commands, store agent preferences, choose prompts, or run agents.

Authenticated PN/LID pairs from provider owner data, message aliases and mapping events preserve existing canonical routing IDs. A late authenticated pair may connect two existing identities without moving either published route or host binding. Contradictory partners quarantine the affected personal identities; healthy chats continue receiving messages. `/v1/accounts` retains the actual connection state with `diagnosticCode:"identity_conflict"`. Sends to an affected direct recipient are denied; if the account owner is affected, all sends are denied and own messages cannot authorize host commands. A legacy account-wide conflict marker is preserved as diagnostic evidence and does not itself stop a healthy connection. Recovery never silently merges bindings or promotes historical commands to fresh authority; hosts should review affected identities and explicitly register the intended route when needed.

Commit a checkpoint only after the host has durably processed the event. SSE delivery is at least once; the consumer must also deduplicate. A slow stream is closed so it can resume from the consumer's last durable checkpoint. On retention expiry, the endpoint returns HTTP 410 `cursor_expired` with the latest `eventId`; show an explicit resync state. The owner may choose to checkpoint `/v1/events/head` and resume future traffic. Do not silently skip unknown history. Checkpoints are scoped to the current token digest; changing the token creates a new consumer.

## Local history archive

The provider requests available history with `syncFullHistory:true` and `shouldSyncHistoryMessage:() => true`, preserving the original `Browsers.macOS("Chrome")` device profile for linking and reconnects. Baileys sets registration's `requireFullSync` independently of that browser name; switching to Desktop also changes the reconnect platform and is intentionally avoided for compatibility. Every supported individual or group message delivered through `messaging-history.set` is normalized as `history` and persisted in the encrypted archive, including attachment metadata. Disappearing/view-once wrappers are excluded. See the [official connection payload implementation](https://github.com/WhiskeySockets/Baileys/blob/master/src/Utils/validate-connection.ts) and [history event guidance](https://github.com/WhiskeySockets/baileys.wiki-site/blob/main/docs/socket/history-sync.md).

WhatsApp controls what history it supplies. An existing linked device may not receive messages already skipped by an earlier configuration, and reconnecting does not guarantee a complete download. The bridge preserves what it receives; no claim of complete account history is made. It does not automatically request additional pages from the phone when the local archive ends. The account becomes connected when its authenticated socket opens; initial pending notifications remain `history` until their separate live-readiness boundary. A long history sync cannot expire an already completed pairing.

The API and `conversation.get_context` MCP tool read the same archive without causing a new agent turn. Omit cursors for the latest page. To read older messages, pass the returned `nextBefore` as `before`; its absence means there are no earlier retained messages before that page. Use `after` for forward pagination. Do not supply both cursors. Every page is chronological, with message ID as the timestamp tie-breaker. A cursor from another chat or an unavailable record returns 404. Archived owner messages are historical context and must never be interpreted as fresh activation or authorization.

## Attachments

Images, videos, audio, documents and stickers expose only `{attachmentId,kind,mimeType,fileName?,sizeBytes?}`. Captions may be empty. MIME parameters are removed; documents retain valid MIME types and fall back to `application/octet-stream` when missing or invalid. Filenames are untrusted display metadata. Provider download descriptors, media keys and URLs remain encrypted in the credential store; they never enter HTTP metadata, SSE or MCP context.

| Method | Path                                                                              | Behavior                                                          |
| ------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| GET    | `/v1/chats/:chatId/attachments?accountId=default&messageId=optional`              | Latest 50 `{attachments}`, or one message, scoped to account/chat |
| GET    | `/v1/chats/:chatId/attachments/:attachmentId?accountId=default`                   | `{attachment}` metadata                                           |
| GET    | `/v1/chats/:chatId/attachments/:attachmentId/content?accountId=default`           | Binary download, `no-store`, `nosniff`, attachment disposition    |
| POST   | `/v1/chats/:chatId/attachments?accountId=default&kind=document&fileName=optional` | Raw binary body with MIME Content-Type; `{attachment}`            |

Uploads and downloads are limited to 64 MiB per file. Downloads are lazy; imported history alone does not fetch media. The adapter follows [Baileys' documented streaming download and reupload flow](https://github.com/WhiskeySockets/Baileys#downloading-media-messages), restricts media fetches to the WhatsApp media host, and cancels on timeout/disconnect. Old media may no longer be available even when its metadata is archived. Successfully fetched/uploaded bytes are retained encrypted locally. There is no automatic execution, preview, arbitrary-URL fetching, or base64 media in model context.

`POST /v1/messages` accepts optional `attachmentId`. Text can be empty with an attachment. Image/video/document text becomes its caption; audio/sticker captions are rejected before reserving a send. Quote and durable idempotency semantics also apply to media sends. SDK methods are `attachments`, `attachment`, `uploadAttachment`, and `downloadAttachment`.

Outgoing media uses a temporary input file inside a unique private directory, removed after success or failure. POSIX uses file mode 0600 and directory mode 0700; Windows applies and verifies private ACLs before writing private content. Baileys rc14 otherwise creates an additional plaintext original while calculating previews/duration, even for a file input. The adapter skips automatic image/video thumbnails and calculates audio duration directly from its private input. Unreadable audio is sent as a document to preserve the file without inventing its duration. This avoids changing the embedding process's global umask.

## MCP

```sh
node dist/cli.js mcp --url http://127.0.0.1:12345 --account default --chat 56922222222@s.whatsapp.net
```

Inject `WHATSAPP_BRIDGE_TOKEN` through the child environment, not command arguments. The MCP server is a client of the same HTTP API and exposes:

- `accounts.list`
- `conversations.list`
- `conversation.get_context`
- `conversation.send`
- `conversation.get_send_status`
- `attachments.list`
- `attachment.upload`
- `attachment.download`

`attachment.upload` reads one regular local `filePath`, rejecting symlinks, special files and files over 64 MiB. It stores the attachment without sending it. `attachment.download` creates a unique private directory and file, returning its absolute `filePath` for local tools. POSIX uses directory mode 0700 and file mode 0600; Windows applies and verifies private ACLs. Downloads never overwrite existing paths or automatically open files. These explicit local files remain available after the tool returns; the caller manages their cleanup. No workspace path is treated as a sandbox or file allowlist.

With `--chat`, context and sends are restricted to that chat and callers cannot override it. Omit `--chat` only for a trusted owner client that intentionally needs all chats. Pairing, QR retrieval and credential administration are not MCP tools. The host must enforce authorization, purpose, output limits and agent capabilities independently; a prompt guideline is not an operating-system sandbox.

## Storage, operations and limits

SQLite uses WAL and full synchronous commits. Credentials, Signal key records, message bodies, event snapshots and outbox text use AES-256-GCM with a fresh nonce and record-bound associated data. A persisted integrity sentinel detects the wrong master key; there is no plaintext fallback. POSIX uses private directory mode 0700 and database mode 0600. Windows uses a protected DACL allowing only the current user's SID and verifies permissions before writing private content; an unsuccessful permission check rejects the operation. This requires Windows PowerShell 5.1 and a filesystem with persistent ACLs, such as NTFS or ReFS. It does not prevent an operating-system administrator from taking ownership. Account/chat identifiers, timestamps, status and idempotency metadata remain structured plaintext. Disk encryption and operating-system access controls still matter for local metadata.

The encrypted message archive is retained indefinitely by default (`historyRetentionDays:null`, CLI `--history-retention-days forever`), until explicit deletion. Optionally set `--history-retention-days N` / `historyRetentionDays:N` from 1 to 36,500 days; this expires local records based on their last receipt/update time. Operational event snapshots and outbox text have a separate seven-day lifetime (`--retention-days`, 1–365 days). Pruning runs at startup and hourly; expiring the SSE journal does not erase the message archive. Minimal send/idempotency records remain to prevent duplicate sends. Text stays encrypted in SQLite; identifiers, timestamps and status remain plaintext metadata, and there is no plaintext text-search index. Deletion removes logical database records, not a forensic secure wipe of filesystem blocks or old backups. Unlink removes authentication keys, while conversation retention continues. Back up the state directory consistently with its separately protected master key; losing that key makes encrypted records unreadable. Never check the state directory into Git.

Automated coverage includes synthetic end-to-end HTTP/SQLite/SSE/MCP flows, CLI stdin EOF/readiness/SIGTERM behavior, encrypted credential and Signal-key roundtrips, Baileys normalization, replay expiry, identity conflict, duplicate prevention and uncertain delivery recovery. The official Baileys package is imported without connection. These checks do not establish real QR pairing, WhatsApp reconnect behavior or delivery; those require a separate owner-driven live acceptance test. The package is a release candidate pinned to an exact version; review provider changes deliberately.

Primary references: [official Baileys repository](https://github.com/WhiskeySockets/Baileys), [official package](https://www.npmjs.com/package/@whiskeysockets/baileys), [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk). Exact npm metadata was checked on 2026-09-05.
