# Build your own calling assistant — complete prompt

Copy everything below the line into a capable coding agent with a local workspace. It is a self-contained implementation request; the reference repository is optional. Replace the bracketed choices if you already know them. Never paste secret values into the prompt.

---

Build and verify a complete personal calling assistant in this workspace. Implement it, not just a plan. It should accept tasks directly from me or another agent such as Meta Muse, call ordinary US personal/business phone numbers on my behalf, conduct a natural full-duplex conversation, navigate IVRs with real keypad commands, ask its originating agent for missing information during a call, and return evidence-based results. Include a local call-history dashboard with transcripts and optional actual recording playback.

My starting choices: Node.js 22.12+ / TypeScript; Cloudflare Workers plus SQLite-backed Durable Objects; Telnyx Voice API; OpenAI GPT-Live-1; one owner, one concurrent call, roughly 100–300 monthly minutes. Budget ceilings: $50/month, $5/call, $1 backend/call, 45 minutes/call, 90 connected minutes/day. No automatic redial, campaigns, inbound receptionist, payment integration or background paid jobs. Use my existing provider accounts only after I configure credentials securely. Do not purchase a number, upgrade plans, enable overages or place test calls merely because keys exist.

Work autonomously on code, documentation, local fixtures and mocked-provider tests. Ask only for genuinely missing account setup, exact controlled-test destination/authorization or decisions that cannot be inferred. Keep secrets in ignored local files or provider secret stores; ask for locations/setup status, not secret values in chat. Keep the implementation inspectable and give concise progress updates.

## 1. Verify current provider contracts

Read primary documentation before implementing network adapters. Start with:

- https://developers.openai.com/api/docs/guides/live
- https://developers.openai.com/api/docs/guides/live-delegation
- https://developers.openai.com/api/docs/guides/voice-websockets?api=live
- https://developers.openai.com/api/docs/models/gpt-live-1
- https://developers.telnyx.com/docs/voice/programmable-voice
- https://support.telnyx.com/en/articles/4374050-configuring-call-control-texml-applications-voice-api
- https://developers.cloudflare.com/durable-objects/

Verify session creation/events, audio formats, delegation appends, carrier streaming and DTMF, signature verification, model availability and pricing. Do not substitute generic Realtime events for GPT-Live events. If a documented model is unavailable to my account, explain the blocker and verify a compatible alternative before changing it. Do not fabricate provider APIs or report a stub as a working integration.

## 2. Separate conversation, reasoning and authority

GPT-Live owns listening, speaking, backchannels, interruptions and ordinary clarification. Keep native continuous speech-to-speech; do not insert an unnecessary speech-to-text → text-model → text-to-speech chain. Use client delegation so the application owns context, tool execution, permission checks, deadlines and model routing.

The application owns exact lookups/calculations, authorization, task state and durable tool operations. Use a fast bounded reasoning model (initially GPT-5.6 Terra with low reasoning), a cheaper extraction/summary model (GPT-5.6 Luna), and a stronger model (GPT-6 Astra with medium reasoning) only when justified. Verify prices/compatibility. Clear IVR options and exact arithmetic should not need a paid model request.

The originating agent supplies task context and occasional choices; never require it for every spoken turn. Direct owner tasks must work without Muse. Private facts and negotiation ceilings remain in application state, excluded from voice and model prompts. Return concise verified context to the voice model in documented bounded thinking/commentary appends (currently 500 tokens each); neither channel is a secret vault.

## 3. Durable controllers and audio

Use a Worker for auth/routes/static control console, an owner-level Durable Object for credentials/admission/budgets/call indexing, and one Durable Object per call for media and durable call state. Persist task revisions, transcript batches, ordered events, pending decisions, operation intents, provider identifiers, usage reservations and replay receipts.

Bridge Telnyx bidirectional L16 PCM at 16 kHz to the supported GPT-Live format, with PCMU/8 kHz as an explicitly tested fallback. Continuously pace input and bound message rates, queues and buffers. Process audio and control separately. Track generated text separately from carrier playback marks and actual audible delivery. Clear interrupted playback without counting cleared audio as delivered. Drain goodbye audio within a bound before hangup; handle voicemail and direct recipient requests to end.

Verify Telnyx Ed25519 webhook signatures and replay windows. Authenticate media with short-lived one-use tokens; never log credentials or signed media URLs. Persist webhook inbox/operation state before effects. Use provider command IDs for deduplication. Unknown external outcomes must be reconciled before retry. On runtime/socket restart restore verified state but do not promise seamless audio recovery. Deployment must drain and refuse active/unresolved calls.

## 4. Rich brief and API

Define versioned strict schemas for:

- CallBrief: simulation/live mode; E.164 destination and recipient label; caller name/persona/language; objective; success criteria; shareable/private facts with IDs/sources; preferences; alternatives; prohibited actions; exact authorized commitments and monetary limits; missing information; escalation deadline/fallback; duration/cost limits; voicemail; recording; origin; IVR policy.
- DecisionRequest: ID, current task revision, question, relevant context, choices/schema, absolute deadline and authorized fallback.
- CallResult: finalized flag; completed/partially_completed/unsuccessful/uncertain outcome; confirmed details, unresolved questions, evidence references and provisional/final cost.

Expose OpenAPI, a typed client and a thin stdio MCP adapter over the same rules:

POST /v1/calls/validate
POST /v1/calls
GET /v1/calls
GET /v1/calls/{id}
GET /v1/calls/{id}/events?since_seq=N
POST /v1/calls/{id}/answers
POST /v1/calls/{id}/context
POST /v1/calls/{id}/dtmf
POST /v1/calls/{id}/cancel
GET /v1/calls/{id}/transcript
GET /v1/me

Add owner-only credential issuance/revocation/update, status, drain/kill, verified callback registration, content deletion and invoice/termination reconciliation. Keep owner and agent authentication separate. Agent credentials define maximum scopes, destinations, call spend, commitment amount, first-person permission and expiry. A brief cannot grant itself more authority. First-person wording is not permission to lie when asked whether the caller is automated.

Creation and consequential mutations require durable idempotency keys. Changed bodies with reused keys conflict. Every answer/context/keypad action checks current revision and pending state; reject expired/superseded answers with 409. Do not silently patch old answers to new questions. Use integer cents and absolute millisecond timestamps. Keep results, termination and billing finality separate. Deletion must not erase spending history or allow an old dial key to execute again.

## 5. IVR is an application feature

Detect menu/input prompts from incoming transcript fragments independently of voice delegation. Settle fragments with a short debounce, publish a current menu with options, revision, mode and expiry, and invalidate pending selections immediately on new recipient speech. Listen silently to electronics; do not greet a recording, ask it to hold, or say a digit instead of sending a tone.

Modes: auto (default), assisted and off. Auto can select only a clear offered option using the task/IVR goal; otherwise use bounded reasoning or consult the origin. Assisted exposes the menu promptly. Numeric entry requires an exact matching shareable fact ID; a pound suffix is permitted only if requested. Never enter private facts or guessed values. Navigation does not authorize payment, agreement, purchase or cancellation; block those consequential keypad options and seek a representative.

Persist a DTMF operation intent and receipt before Telnyx I/O. Use stable command IDs, bounded digit count and command count (24 digits / 20 commands per call is a starting point), and an 8-second request timeout. A successful HTTP receipt proves submission only. Verify changed prompts/readback to claim traversal. Ambiguous delivery is not permission to resend with another key. Expired menus cannot be revived by late answers.

Implement a free two-stage synthetic IVR fixture: press 2 for scheduling, then enter synthetic shareable reference 6204 followed by pound. The fixture must fail if the right keypad operations never happen; a generic answered consultation cannot falsely mark it successful. Keep simulated and real carrier evidence separate.

## 6. Live consultation and Muse

Start with a configurable 60-second decision deadline (45–90 seconds). During waits, ask another useful question or request a brief hold; electronic menus get silence. If the origin disappears, continue only under an explicit allowed fallback, otherwise end without the unresolved commitment. Do not fill a long wait with repetitive chatter.

Implement incremental events, optional SSE and signed verified callbacks for capable hosts. Muse's current observed baseline is a custom HTTPS connector with a Secure Vault bearer key and active-task polling; do not assume a wakeup webhook or arbitrary remote MCP registration. Use the actual installed Muse version's credential helper and tool permissions. Never pretend another agent's message is a direct owner approval.

Provide a copy-and-paste Muse onboarding prompt plus reusable supervision logic. Poll unchanged state in code about every five seconds with 10-second request bounds; return to the model only for decisions, assisted IVR, completion or a bounded timeout. Persist call ID, creation key, operation keys and event cursor. Check a fresh snapshot on each resume, including already-pending decisions. A flat response must be read as body.ivr, not body.snapshot.ivr.

First test through Muse's actual vault connector using short consultation and two-stage IVR simulations. Long 8/45-minute active-task tests are optional, explicitly initiated evaluations. They must never become hidden paid telephone tests or recurring jobs. Do not assume one successful supervision run proves universal background availability.

## 7. User interfaces, recording and privacy

Provide an authenticated hosted console for task creation, live transcript, decision cards, context, cancellation, outcome and spending. Add a separate Node dashboard bound to 127.0.0.1 for full call history, transcript search and playback of actual available recordings/imports. Keep provider/owner keys server-side, validate browser origin on local mutations, use private file permissions, range requests and bounded/cached manual sync. Store cache/audio outside the repo and outside shared directories by default.

Make recording an explicit per-brief on/off setting and document its default. Use bounded dual-channel carrier recording when enabled. The originating agent controls call wording and required disclosures; transport capture must not silently rewrite the opening. Do not claim unrecorded historical calls can be reconstructed. Do not persist signed recording-download URLs in public/durable logs. Explain provider/local retention separately.

Default to a male conversational voice (Cedar if supported), a generic personal assistant identity and no unnecessary name announcement. Caller name is supplied by the user, not hardcoded. Answer direct automation questions truthfully and honor caller.requiredDisclosures. Keep OpenAI session storage disabled, transcripts at 30-day retention, and summaries/decision records until deletion. Private data does not belong in public examples or test reports.

## 8. Cost and deployment controls

Reserve worst-case call cost before dialing and model cost before each backend request. Bound tokens, tool loops (initially 30 model requests/call), retries, provider timeouts and callback delivery. Retain reservations after ambiguous failures. Replace cumulative usage snapshots rather than double-counting them. Provisional application spend is not the provider invoice. Add a kill switch and provider hard call-duration cap.

Use a restricted Telnyx outbound profile with US routes, one concurrent call, an appropriate daily spend guard and verified per-minute route ceiling. Do not infer every +1 number is a permitted US destination. No automatic redial or route-limit increases. Verify current pricing for live duration, carrier transport, Voice API/streaming, recording, number rent, models and hosting.

Before enabling hosted/recurring/AI work, inventory triggers, concurrency, fan-out, retry paths and paid downstream operations. Demonstrate normal account-wide usage at or below 50% of applicable free allowances; otherwise keep the expensive path disabled/manual or ask for a bounded budget decision. Investigate 70%, stop/manual-only at 90%. Do not enable overages or upgrade plans automatically. No automatic CI, cron or Git deployment is needed initially.

Ship simulation-only defaults, hidden-input setup, secure secret upload, read-only connection checks, scoped-agent key issuance and an idempotent free smoke test. First bootstrap is only for a genuinely new simulation-only service. Every later deploy must verify/drain existing state, run checks/tests/build, refuse active/unresolved calls and restore the prior admission setting.

For real evaluation obtain one exact owner-controlled destination, a maximum one-hour test exception and a 2-minute / 50-cent total / 10-cent backend cap. Clear the exception afterward. Do not call a real number just to demonstrate installation. General live activation is an explicit owner action after headroom and controlled-path verification.

## 9. Acceptance and deliverables

Use the real Workers local runtime with paid credentials removed and provider transport mocked. Cover schema/scope violations, unauthorized commitments, revocation, exhausted budgets, duplicate webhooks, simultaneous idempotent actions, conflicting keys, operation ambiguity, revisions, expired/late answers, origin disappearance, timeout fallback, runtime restart, audio clears/playback accounting, voicemail, goodbye and IVR corrections/input privacy. Test dashboard auth boundaries, secret/signed-URL redaction and audio ranges. Test fresh setup and credential issuance without printing secrets.

Run a clean local install and real HTTP simulation journey. Then, only when authorized and configured, separately evaluate actual phone audio: numbers/names, noisy speech, overlap, corrections, holds, IVR tone readback, voicemail, complete goodbye and recording retrieval. Ordinary-response targets start at median <700 ms / p95 <1.5 s and backend-useful-response p95 <3 s excluding external delays; label these as targets until measured.

Produce:

1. Complete source, pinned lockfile, generic examples and MIT license if appropriate.
2. A clear README and quickstart that honestly lists account/number prerequisites.
3. A comprehensive architecture and tradeoff writeup.
4. API/OpenAPI, typed client, MCP and Muse onboarding prompt/helper contract.
5. Cost/authority/privacy/operations/recovery guidance.
6. Test results distinguishing local mocks, actual agent integration, actual telephone audio and final bills.
7. A final concise explanation of what works, how to start it and what remains unverified.

Never ship another user's keys, private transcript, recording, phone numbers, account IDs, deployed endpoint or Git history. If publishing, build a clean allowlisted copy with fresh history and audit it before making it public. Optional reference implementation: https://github.com/intenex/muse-calling-assistant . You must still verify current providers and this account's actual setup.
