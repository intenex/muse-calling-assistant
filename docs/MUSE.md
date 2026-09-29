# Connect Meta Muse

## Easiest path

1. Complete [setup and activation](QUICKSTART.md).
2. Run `npm run agent:key -- --live` (or omit `--live` for simulation-only setup).
3. Paste `.local/muse-connect.md` into Muse. It contains your service URL and instructions, **no key**.
4. When Muse opens its real Secure Vault credential dialog, enter the scoped key from `.local/muse-api-key.txt`. Allow only your service host.
5. Let Muse run the two-stage free simulation and a consultation simulation. Confirm its reported results before asking for a real call.

The unfilled [connection prompt](../prompts/CONNECT-MUSE.md) can also be copied manually; replace `YOUR_CALLING_API_URL` once throughout.

This is an observed custom-HTTPS integration, not an official one-click Meta plug-in. The source app successfully used a vault-generated helper and code polling. A different Muse version may expose different names or require another setup action. Ask that app to use its documented generated helper; do not fabricate a credential method or place a secret in its model context. If custom HTTPS access is unavailable, this integration needs another supported transport.

Muse reported no inbound webhook that wakes a conversation and no arbitrary custom MCP server support. HTTPS polling during an active task is the tested approach. A connected credential does not prove sustained supervision or authorize a real call by itself.

## What the helper must do

Use [OpenAPI](API.md) on the configured host and the real credential transport. Create a brief, validate it, persist a unique stable creation key, create the call, and save its returned ID. Every request has a 10-second timeout. Unknown creation responses are retried only with the exact same body/key.

Poll events with `since_seq` about every five seconds in code. Read current state at the beginning of each supervision window and regularly while polling. Save the next cursor. The TypeScript `CallingClient.supervise` performs both snapshot and event reads; an equivalent helper may batch snapshot checks but must not miss already-pending questions on resume.

Return control for:

- A pending decision whose absolute deadline is in the future.
- An assisted, pending, unexpired IVR menu (`body.ivr.mode === 'assisted'`).
- A terminal result once `result.finalized !== false`.
- A bounded supervision timeout, so the agent can deliberately resume.

Automatic IVR menus stay in the backend. There is no need for the originating agent to race it. The response structure is flat; reading `body.snapshot.ivr` silently misses every menu.

A decision answer is `{decisionId, expectedRevision, answer}`. Answer only within authorized bounds. Expiration, correction or conflicting updates can produce 409; refetch instead of repackaging the same answer with a new revision. An absent agent cannot grant permission by timing out.

## Free connector test

Use [examples/ivr-simulation.json](../examples/ivr-simulation.json) through Muse's real vault transport:

1. Create once with a saved idempotency key.
2. Read the current menu, select `2` using `/dtmf` with its menu ID and task revision.
3. Refetch, then send `6204#` with `factId: test-reference` for the numeric input prompt.
4. Check two accepted simulated commands and finalized outcome `completed` at zero provider cost.

The smoke helper `npm run test:ivr` is useful for your ordinary local CLI but **does not prove Muse's vault transport**. Muse needs to execute the same requests itself. Also run [consultation.json](../examples/consultation.json); choose an allowed answer only when its synthetic question arrives.

Start with short tests. Long active-task supervision (for example 8 or 45 minutes) is optional and manual, not required just to install the connector. Such simulations do not call paid telephony/OpenAI providers, but Muse's own subscription/tool usage and your hosting still apply. A historical 45-minute success does not guarantee every future Muse task stays awake.

## Live use

A suitable user request is: “Call the shop and ask whether they have a service appointment on Friday. Collect options but don't book anything. If they need another date, ask me.” Muse supplies the actual authorized number, facts and brief; no hardcoded private destination ships with the project.

The generated key allows supported US recipients without a per-number allowlist, up to $5/call, but no commitments and no first-person requests. To authorize those, change the credential separately and then authorize exact terms in the brief. Never treat an API key's presence as permission to invent the user's intent.

Preserve the user's own per-call approval rules. If Muse requires a direct owner confirmation in that app, a helper agent must not impersonate that confirmation. During ordinary conversation the voice service works independently; Muse participates only when needed.

Default recording is on; a call can opt out. The originating agent supplies required disclosure/identity wording. The telephony transport does not insert a separate announcement.

## Promote or rotate the key

A simulation-only key remains simulation-only after server activation. To promote it without changing the vault secret:

1. Read `.local/muse-credential.json` for its ID and owner `/v1/admin/status` for its current credential revision.
2. Pause admission with `examples/pause.json` through the owner API; wait for active/finalizing calls to empty.
3. POST the full permission configuration with `live:true` and `expectedRevision` to `/v1/admin/credentials/{id}`. Use the generated defaults, omitting `expiresInDays` (updates preserve expiry). Keep no commitments/first-person permission unless deliberately authorizing them.
4. Resume the prior admission state. Ask Muse to refresh `/v1/me`.

Issuance returns a secret once; updates preserve it. The default key expires in 30 days (API allows up to 90). To replace it, revoke the old ID, archive/remove the old local key and issuance-intent files, then rerun `agent:key` and update the vault. If issuance failed ambiguously, inspect owner status and revoke the unresolved credential before minting another. Never place owner credentials in Muse.
