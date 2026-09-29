# API and client guide

The deployed `/openapi.json` is generated from the actual schemas. All `/v1/*` requests need bearer authentication. Use a stable `Idempotency-Key` for creation and every consequential mutation. Timestamps are Unix milliseconds, money is cents, and call IDs are UUIDs. The HTTP response from `GET /v1/calls/{id}` is **flat**: `body.ivr`, `body.decisions`, `body.revision`—not `body.snapshot`.

## Task briefs

See runnable [consultation](../examples/consultation.json), [IVR simulation](../examples/ivr-simulation.json) and [controlled call](../examples/controlled-call.json) examples. Real destinations and personal data belong in ignored local files.

`CallBrief` version `1` includes mode, destination, caller, language, objective, success criteria, facts, preferences, alternatives, prohibited actions, authorized commitments, missing information, escalation, limits, voicemail, origin, IVR and recording.

- `mode` defaults to `simulation`; use `live` only for an authorized real call.
- `destination.business` is the recipient label, including a friend; the legacy field name does not restrict purposes to businesses.
- `caller.name` is required in this public edition. `caller.persona` is `assistant` (default, assistant named Dave if a name is useful) or `first_person` (requires owner authority or `allowFirstPerson`). Both use the supplied caller name; first-person wording is not permission to falsely claim to be human.
- `caller.requiredDisclosures` supplies call-specific required statements; `introduction` is optional.
- Facts have `id`, `text`, `visibility: shareable|private`, optional `source`. Private facts remain backend-only.
- Each `authorizedCommitments` entry supplies an ID, description, exact `terms` map and `maxAmountCents`. Credential authority is the outer limit.
- `escalation.deadlineSeconds` is 45–90 (default 60). Fallback is `end_without_commitment`, `collect_information`, or `use_explicit_alternative` with an explicit alternative.
- `ivr.mode` is `auto|assisted|off`; `goal` can clarify the department or menu objective.
- `recording` is `on|off`, default on. It changes capture, not opening speech.
- Defaults: 15 call minutes, 500-cent total limit, 100-cent backend allowance. Global maximum is 45 minutes; budget reservation may require a shorter duration for a small cap.
- `voicemail.action` defaults to hangup. `leave_message` requires exact authorized text.

The public edition renames the original owner's persona enum values to generic terms. It is a fresh installation, not a drop-in database migration for the private deployment.

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/me` | Current principal and live readiness |
| POST | `/v1/calls/validate` | Schema/authority/cost checks; never dials |
| POST | `/v1/calls` | Create or replay a task |
| GET | `/v1/calls` | Accessible call list |
| GET | `/v1/calls/{id}` | Flat state, decisions, menu, result, usage |
| GET | `/v1/calls/{id}/events?since_seq=N` | Ordered incremental events; SSE supported |
| POST | `/v1/calls/{id}/answers` | Answer a current decision |
| POST | `/v1/calls/{id}/context` | New facts/instructions/approved terms |
| POST | `/v1/calls/{id}/dtmf` | Actual keypad input against a current menu |
| POST | `/v1/calls/{id}/cancel` | Stop and reconcile the call |
| GET | `/v1/calls/{id}/transcript` | Fragments plus playback evidence |
| DELETE | `/v1/calls/{id}` | Owner deletes settled call content |
| POST | `/v1/calls/{id}/reconcile` | Owner records verified termination/bill |
| GET | `/v1/admin/status` | Owner ledger, credentials, active calls, controls |
| POST | `/v1/admin/control` | Owner drain/kill/termination control |
| POST | `/v1/admin/credentials` | Issue scoped key (secret returned once) |
| POST | `/v1/admin/credentials/{id}` | Update permission revision while drained |
| POST | `/v1/admin/credentials/{id}/revoke` | Revoke key and stop its active calls |
| POST | `/v1/admin/callbacks` | Register and verify callback receiver |

For exact bodies, consult OpenAPI. Agent scopes: `calls:create`, `calls:read`, `calls:answer`, `calls:context`, `calls:cancel`, `transcript:read`. DTMF uses `calls:context`. No agent key inherits owner administration.

## Decisions and stale results

```json
{"decisionId":"CURRENT_DECISION_ID","expectedRevision":3,"answer":"The morning appointment is preferable; do not book yet."}
```

Send only for a pending decision before its deadline. A `409` means state changed, a deadline passed or an idempotency body conflicts; fetch again and reconsider. Do not attach a new revision to an old question. Optional `authorization` supplies exact terms within the credential's envelope. Context updates also require the current task revision.

A terminal status means the call stopped, not necessarily that the objective succeeded. Wait for `result.finalized` before interpreting the outcome; `result.cost.final` is independent and may remain false pending provider receipts.

## IVR

```json
{"expectedRevision":3,"menuId":"CURRENT_MENU_UUID","digits":"2"}
```

Numeric entry also supplies `factId`. For synthetic fact `{ "id":"test-reference", "text":"6204", "visibility":"shareable" }`, `6204#` is permitted only when the current input prompt requests pound/hash. Menu commands are bounded to offered options; numeric inputs must exactly match shareable facts. Never guess missing digits, resend uncertain commands with a new key, or treat keypad acceptance as proof the recipient understood.

Auto menus run independently. Assisted menus should return control to the originating agent promptly; they expire after 30 seconds. There is no manual tone override around expired-menu/authority checks.

## Typed client

```ts
import { CallingClient, bearerTransport } from '../packages/client/index';
const client = new CallingClient(apiUrl, bearerTransport(secretFromYourHost));
const call = await client.create(brief, stableCreationKey);
const next = await client.supervise(call.id, { since: savedCursor, timeoutMs: 55_000 });
// Persist next.nextSeq. Handle decisions or assisted IVR, then resume.
```

The client accepts an injectable `AuthenticatedFetch`: adapt Muse's actual vault helper instead of extracting its secret into model text. It applies 10-second request bounds. `supervise` checks snapshots on resume and returns pending decisions, assisted IVR, completion or a bounded timeout.

## MCP

Configure a local stdio MCP server whose command is your absolute Node/npm path, working directory is this checkout, and arguments are `run mcp`. Inject `CALLING_API_URL` and a scoped `CALLING_API_KEY` using the host's secret settings. Alternatively use the absolute `node_modules/.bin/tsx` path with the absolute `packages/mcp/index.ts` path. Keep actual secrets out of committed configuration.

Tools include brief validation, creation, state/events, answers, context, cancellation, transcript and `send_keypad`. They share the HTTP service's authorization. Instinct and arbitrary other hosts have not been independently verified; use their documented HTTPS or MCP capabilities.
