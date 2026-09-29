# System writeup: a phone for an agent

## The problem and design

A capable personal agent knows the user's task, but it is not necessarily a good low-latency telephone agent. A phone call needs continuous listening, interruption handling, menus, hold time, exact numbers, quick responses, and a reliable end. At the same time, a booking or purchase must remain within the user's authority, and a slow originating agent must not stall every conversational turn.

The implementation divides those responsibilities into three layers: GPT-Live for conversation, a durable application controller for authority and tools, and the originating agent for occasional missing context or new decisions. Direct owner calls work without Muse. Muse uses exactly the same API as other clients.

OpenAI describes GPT-Live as the conversational layer with backend delegation for reasoning and tools. This implementation chooses **client delegation** to keep task state, model routing, deadlines, permissions, and returned context under application control. [GPT-Live architecture](https://developers.openai.com/api/docs/guides/live).

## Components and ownership

| Component | Responsibility |
|---|---|
| Worker (`src/index.ts`) | Authentication, request validation, OpenAPI, static console, webhook routing |
| Owner Durable Object (`src/owner.ts`) | Credential scope/revocation, call index, one-call concurrency, monthly/daily reservations, kill/drain state |
| Call Durable Object (`src/call.ts`) | Per-call state, media relay, transcript batches, decisions, IVR, operation intents, finalization and recovery |
| SQLite store (`src/storage.ts`) | Durable state, event ordering, receipts and webhook inbox |
| OpenAI provider | GPT-Live session plus bounded Responses reasoning and summaries |
| Telnyx provider | Dial, media stream, actual DTMF, hangup and status reconciliation |
| Local dashboard | Manual history sync, search, recording resolution/cache/playback/import |
| Client/MCP | Thin adapters over the same authorization and call logic |

This is one owner per deployment, not a multi-tenant SaaS. Each agent sees its own accessible calls; the owner can inspect all calls. Static assets contain no call data. The local dashboard keeps provider keys on the local server side, not in browser responses.

## End-to-end call lifecycle

1. The agent submits a versioned brief with destination, identity, objective, success criteria, shareable/private facts, limits, authorized terms, voicemail policy and timeout fallback.
2. Validation checks schema, supported US number, caller authority and conservative maximum cost. Validation never dials; final admission still checks concurrency, live readiness and available budget.
3. Owner state reserves money and daily minutes before accepting the task. A stable creation key maps to the same call; a changed body with that key is a conflict.
4. The call controller persists its intent and dials Telnyx using a stable carrier command ID. Ambiguous outcomes hold concurrency and funds until reconciled.
5. Signed webhooks associate carrier events with the call. A short-lived one-use media token authenticates the stream. Audio travels between the carrier and the GPT-Live socket.
6. GPT-Live manages ordinary conversation. Backend requests use timestamped transcripts and current verified state. Code checks tool permissions and the task revision before acting.
7. Missing personal facts or new authority produce a durable decision with a deadline. Muse, another agent or the owner answers through the API. Expired/superseded answers cannot revive it.
8. Hangup drains audible goodbye playback within a bound, closes provider resources and reconciles carrier state. Summary readiness, real-world outcome and billing finality remain separate.

## Audio and latency

The primary path uses Telnyx bidirectional L16 PCM at 16 kHz, matching the voice session, with PCMU at 8 kHz as a compatibility option. Native speech-to-speech avoids a separate transcription → text model → speech pipeline. Telephone route quality can still limit bandwidth.

`src/playback.ts` and the controller pace input continuously, bound audio buffers, keep playback short and clear queued output during interruptions. Outbound pacing is 50 frames/second; inbound carrier processing has a 120-message/second bound. Generated text, queued audio, carrier marks and actually heard sound are distinct evidence. Clearing audio cannot mark its text as delivered.

The service remains connected during ordinary holds so it can hear someone return. That preserves responsiveness but costs money for active-session minutes. Socket loss or a Durable Object restart can interrupt audio: recovery restores durable task/operation context but is not promised to be seamless. [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).

The initial targets are ordinary responses under 700 ms median / 1.5 s p95 and routine backend-assisted responses under 3 s p95, excluding external delays. These are evaluation goals, **not measured release guarantees**.

## Reasoning and task authority

Routine reasoning uses GPT-5.6 Terra, difficult/conflicting work can escalate to GPT-6 Astra, and final extraction/summaries use GPT-5.6 Luna. Exact arithmetic and straightforward menu selection run in code. Model names and bounds are explicit configuration; changing a model requires reviewing its pricing and request compatibility.

The backend receives a bounded context assembled from current transcripts, facts and task state. A delegation event is a signal to consult that state, not a complete utterance/task request. A result from an obsolete revision is discarded. The IVR path has a narrow same-current-menu check for safe applicability when transcript timing changes.

Private facts and negotiation ceilings stay in application state. They are excluded from speech and reasoning prompts. Code can compare constraints without revealing the secret ceiling. Session thinking/commentary appends carry concise verified context in bounded chunks; neither is a secret channel. [Delegation and context](https://developers.openai.com/api/docs/guides/live-delegation).

An agent credential supplies the maximum permission envelope. The brief chooses a task inside it. Commitments require exact authorized terms and matching evidence of the current offer. Statements from a recipient are data, never permission to expand access. A best-effort spoken-commitment monitor adds protection, but no prompt or monitor proves that a probabilistic voice model cannot say something unauthorized.

The included tools cover fact lookup, calculations, consultation, commitment checks, DTMF and hangup. There is no unrestricted browser, arbitrary shell, payment API, calendar integration or web-search tool hidden behind the reasoning model. Such tools would need separate implementation and authority rules.

## IVR: real telephone keys

The controller watches incoming transcript fragments independently of model delegation. After a 1.2-second settling interval it parses English menu/input prompts, publishes a revision-bound menu with a 30-second expiry, and suppresses conversational filler while a selection is pending.

- **Auto** selects an unambiguous offered option from the objective/IVR goal in code; ambiguous choices use the bounded reasoning path.
- **Assisted** exposes the menu to the originating agent through the snapshot and events.
- **Off** disables keypad actions.

`POST /dtmf` accepts the current menu ID, task revision and digits. It persists an operation intent and replay receipt before calling Telnyx. A 200 ms tone is sent by the carrier—saying “two” is not a key press. At most 20 commands with at most 24 digits each are allowed per call. Replays return the original operation without retransmission. Ambiguous delivery is never blindly retried with a fresh key.

For account/reference input, a named shareable fact must contain exactly the numeric value (format separators are allowed); a final pound sign is allowed only when requested. Private data, arbitrary guesses, stale menus and keys that themselves accept payments/agreements/cancellations are rejected. New recipient speech invalidates a pending menu before delayed reasoning can act on it.

The current parser is English-focused and heuristic. Repeated menus, corrections, multilingual prompts, speech-only IVRs, and long announcements can still need intervention. Carrier acceptance proves submission, not successful menu traversal; changed prompts or explicit readback provide stronger evidence.

## Two-way agent interaction

Muse's observed connector supports custom HTTPS with a Secure Vault bearer key and polling during an active task. It reported no inbound callback that wakes the conversation and no arbitrary custom MCP registration. Treat these as version-dependent observations, not a public Meta contract.

The supervisor polls in code, typically every five seconds, and calls an LLM only when action is needed. Each resume checks a fresh snapshot as well as the event cursor, preventing missed pending questions. A decision includes relevant context, choices, revision, deadline and permitted fallback. A 60-second default allows slower agent consultation without making Muse responsible for normal speech.

During a wait, the voice agent can ask an independent useful question or request a short hold; for an electronic menu it waits silently. If the origin disappears, only the explicit fallback can proceed. No answer means no new permission. SSE and verified signed callbacks exist for capable clients, while polling remains the Muse baseline.

The [Muse prompt](../prompts/CONNECT-MUSE.md) instructs the actual app to create a connector using its available helper, run a simulation and preserve the user's per-call approval preferences. It does not invent a credential API or promise overnight/background supervision.

## Durability, failure and billing

State survives socket/process lifetimes. The controller persists task revisions, pending decisions, webhook inbox entries, operation intents and idempotency receipts. The owner object reserves worst-case costs before dialing and before model work. Unresolved operations are reconciled before retry; duplicate webhooks do not duplicate actions.

The API distinguishes call termination from a finalized result, and a finalized result from final invoices. Outcomes are completed, partially completed, unsuccessful or uncertain. Provider usage can be provisional; cumulative updates replace prior totals rather than adding the same usage repeatedly. Unresolved receipts keep conservative reservations instead of silently freeing money.

Deployment drains admission and refuses active or unresolved calls. A kill switch blocks new paid work and can terminate active calls. Carrier hard duration limits form another bound. No cron, automatic redial, paid CI, automatic model retry or provider plan change is configured.

## History, recording and privacy

The hosted console supports direct call creation and live decisions. The separate Node history dashboard binds loopback, verifies browser origin for mutations, keeps credentials server-side, bounds and deduplicates synchronization, supports ranged MP3/WAV playback, and caches outside the checkout.

Call recording defaults on for the inherited feature set, with a per-brief off switch. The dial request asks Telnyx for dual-channel MP3 from answer with the same duration cap. The controller stores recording metadata and discards signed download URLs from durable events. The dashboard resolves available recordings using the local Telnyx credential and offers local imports for existing files. It cannot reconstruct unrecorded historical audio.

The calling agent controls wording and any required disclosures; enabling transport capture does not add an announcement. Decide the permitted recording/identity behavior for each deployment and call. OpenAI session storage is disabled by default. Transcripts expire after 30 days; summaries/decisions remain until deletion. Local audio and provider-held recordings have separate lifecycles: deleting a call record does not promise deletion everywhere.

## Deliberate tradeoffs and next work

The media bridge gives control over playback and recovery at the cost of an always-active relay during calls. Direct SIP may reduce that work later, but outbound dialing and the carrier leg still need coordination. Cloudflare minimizes infrastructure administration while socket restarts remain an operational reality.

Code-first clear menu navigation reduces latency and model cost, but English heuristics do not cover every IVR. Native voice quality does not replace evidence of actual task completion. The next useful work is measured end-to-end latency, real DTMF readback, recording retrieval, long-hold/restart tests, and broader IVR-language evaluation—not adding more unbounded tools.

See [verification](VERIFICATION.md) for tested boundaries and [costs](COSTS.md) for operating estimates.
