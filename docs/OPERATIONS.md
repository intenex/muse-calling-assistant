# Operations and troubleshooting

## Deployment

Use `npm run deploy`. After the initial `--bootstrap`, deployment must read authenticated owner state, drain admission and wait for active/finalizing/unresolved calls. It runs check, test and dry build before upload and restores prior admission state. Do not deploy with raw Wrangler over live calls or treat an unavailable API as an empty account.

No repository workflow starts a deployment or paid evaluation. No schedule is removed because none is installed.

## Control commands

The local `pca` helper uses the owner key in `.dev.vars` unless a scoped `CALLING_API_KEY` is securely injected. It prints API data, so use a private terminal and never attach raw transcripts/status to public issues.

```sh
npm run pca -- get /v1/admin/status
npm run pca -- post /v1/admin/control examples/pause.json pause-2026-01
npm run pca -- post /v1/admin/control examples/resume.json resume-2026-01
npm run pca -- post /v1/admin/control examples/kill.json emergency-stop-2026-01
```

Use a new unique key for each new intent; reuse the exact key for retries of that intent. Resuming drain does not clear `kill`. To clear the kill switch after investigation, create a reviewed local JSON file with `{"kill":false}` and submit a new control intent.

## Secrets

Secrets are local `.dev.vars` and remote Wrangler secrets. The public files contain none. The setup wizard hides input and preserves existing keys. `npm run secrets` uploads only named secret fields via stdin. On an established installation pause admission and wait for every call to finish before uploading; resume afterward. For owner-key rotation, use an authenticated old-key session to drain first, then upload the replacement and verify it before resuming. Do not print old/new keys into logs.

Agent keys are scoped, revocable and expiring. See [Muse](MUSE.md) for promotion/rotation. The server returns a new secret only once. The helper saves its issuance intent first and refuses silent reissuance after an ambiguous failure.

## Data lifecycle

The hosted database retains summaries/decision records until owner deletion, transcripts for 30 days and minimal billing/idempotency tombstones even after content deletion. Deleting content does not erase spend or permit replay of a dial. Calls must settle before deletion.

The local dashboard cache is separate. Audio imports/downloads remain local until deleted; carrier recordings also have their own lifecycle. A transcript retention period does not delete every provider recording or backup. Keep private exports outside Git and manage backups deliberately.

## Common failures

| Symptom | Check |
|---|---|
| `liveReady:false` | All three activation flags, provider fields, HTTPS URL; local dev intentionally overrides live flags |
| Muse still simulation-only | `/v1/me` principal.live and Muse's own instructions; promote key while drained and preserve owner approval rules |
| Telnyx rejects dial | Account verification, outbound profile assignment, allowed route/rate, available balance, caller ID; no blind retries |
| Call cannot reach same number | Use a different recipient from the outbound caller ID |
| Signature failures | Ed25519 public key, exact webhook body/signature headers, timestamps, configured application |
| No audio / cut-off | Carrier/media/session events and playback marks; listen to actual output; session loss is not seamless |
| Assistant talks to IVR | Current menu parse, English prompt, ivr mode, transcript fragments and current revision; use assisted mode for debugging |
| Keypad 409 | Menu expired/changed/handled or body conflicts; refetch and reconsider; never resend unknown tones with a new key |
| Numeric input rejected | Exact shareable fact ID/text and requested pound terminator; private or guessed values are forbidden |
| No recording in dashboard | Recording enabled on that call, `recording.saved` event, local Telnyx key and connection ID, manual Refresh |
| Budget blocked despite small estimated bill | Unfinalized reservations; reconcile verified receipts instead of clearing state |
| Deployment refuses | Active, unresolved or finalizing call; inspect carrier/owner state, then wait or reconcile |
| Model not found | Check account/model access and current provider API; do not silently substitute incompatible models |

## Recovery

Call state survives socket lifetimes; live audio may not. On a provider timeout, inspect the persisted operation. `intent`/`uncertain` is not permission to retry a consequential action with a fresh ID. Hangup has bounded retries and carrier-status reconciliation. If the carrier remains unknown after its hard duration and recovery window, manually verify termination and use the owner reconciliation endpoint with actual bill evidence.

Monitor actual outcomes and audible delivery as well as text. Do not claim a booking, keypress or goodbye succeeded solely because it appears in generated transcript text.
