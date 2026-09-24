# WhatsApp Agents Bridge builder

This repository is an agent-agnostic transport, not a managed agent workspace. Keep the provider adapter, encrypted store, service, HTTP boundary, SDK and MCP boundary separate. Do not add host-specific prompts, model selection or agent activation rules here.

- Write specification-focused regression tests before substantial behavior changes. Prefer integration flows over isolated mocks. Use temporary SQLite databases and synthetic fake providers.
- Never inspect, print, copy or persist real secret values, QR material, pairing codes, credentials or real chat text in tools, fixtures, logs or reports. Never start real pairing or send a real message without explicit owner authorization.
- Keep credentials encrypted with no plaintext fallback. Secrets enter the dedicated process through its private stdin pipe. Its stdout is only the readiness JSON line; dependency console logging remains suppressed.
- Preserve the encrypted message archive independently from operational journal retention. History remains context and never becomes live activation or authorization. Keep cursor queries scoped to one account/chat.
- Preserve durable event cursors, stable outbound provider IDs and idempotency. Uncertain delivery must not cause a blind resend. Own API echoes, history, edits, deletes and forwards must not silently become fresh user commands.
- Only authenticated provider metadata establishes PN/LID aliases or owner identity. Never silently move a host binding when identities conflict.
- Keep API authentication, loopback binding and exact Host/Origin checks. A workspace path or prompt guideline does not isolate an agent.
- You are not alone in the codebase. Preserve unrelated changes and coordinate file ownership before parallel edits.
- Validate with Node.js 24 or newer: `npm run validate`. `npm run format:check` verifies formatting. Tests must never contact WhatsApp.

Production Baileys execution belongs in the dedicated CLI process because transitive Signal code may bypass the configured logger. The HTTP client is safe to embed in another application. Publication, provider account changes and live pairing are separate externally visible operations.
