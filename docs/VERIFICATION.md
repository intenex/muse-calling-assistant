# Verification and release boundaries

Public export prepared September 28, 2026. All work below used the separate public checkout; no production deployment, number purchase or paid phone/model evaluation was performed for this publication.

## This public edition

| Check | Result |
|---|---|
| Clean `npm ci` from the lockfile | Passed |
| TypeScript `npm run check` | Passed |
| Worker-runtime suite | 73 passed; provider credentials replaced with empty/fake values |
| Local dashboard suite | 10 passed; fake API/carrier transport |
| Setup/transport/credential suite | 4 passed; local fake service, secret-output and file-mode assertions |
| `npm run build` | Passed (Wrangler dry-run only) |
| Production dependency audit | No known vulnerabilities reported by `npm audit --omit=dev` at release time |
| Interactive setup | Completed with no provider credentials; private keys generated locally, not printed |
| Local HTTP IVR journey | Two successful simulated DTMF operations; finalized completed outcome; 1.88 seconds active fixture time; 0 provider cents |
| Scoped-key HTTP journey | Issued and authenticated simulation-only key; no commitment authority; secret saved privately |
| Live disabled | Local HTTP request to create a live call rejected with `live_disabled` |
| Public template/privacy audit | No private source keys, source deployment hostname, personal phone destinations, recordings or local caches in publication files |

The pattern audit (`npm run audit:public`) supplements manual review and an exact comparison against private source configuration. It is not a general guarantee that every possible secret pattern can be detected. The repository starts with fresh history; it does not include commits from the private deployment.

Expected-negative Workers tests can log exceptions for rejected requests (stale revision, revoked credentials, exhausted budget, etc.). The assertion/test-run exit status determines pass/fail.

## Inherited source experience, not a new public-account test

The source implementation had real outbound voice evaluations and actual Muse vault integration, including active-task supervision. A two-stage IVR test through the actual Muse connector completed in about 7.2 seconds at zero provider cost. Its first attempt exposed a flat-response parsing error; the helper was corrected and the second passed. Those private raw records are deliberately excluded from this repository.

These observations explain the design; they do not certify your account, your Muse version, your carrier route or a new deployment. The complete fresh setup flow has not been run on a second user's paid provider accounts as part of publication.

## Still requires real-path verification

- Actual carrier DTMF tone delivery and recipient readback for the new IVR path.
- End-to-end latest recording retrieval/playback from a newly recorded live call.
- New adopter's provider account permissions, number/profile settings and live-model session access.
- Sustained supervision in that adopter's actual Muse version/vault connector.
- Latency percentiles, noisy audio, long holds, restart interruption and broader multilingual IVR coverage.
- Actual provider receipts/invoices; application provisional costs are not invoice proof.

## Acceptance procedure for an adopter

Start with the local simulator and hosted simulation, then run Muse's connector simulation using its actual credential helper. Stop supervision once and verify the timeout ends without an unresolved commitment; a late answer must conflict. Test stale context/revisions, key revocation and the kill switch synthetically.

Only after explicit authorization, call a separate controlled number with a two-minute / 50-cent / 10-cent backend cap. Listen to overlap, interrupted speech, a corrected name/reference, voicemail and the complete goodbye. For keypad verification use an owner-controlled IVR or specifically authorized public echo line, and require an actual changed prompt/readback after a carrier command. If recording is enabled, verify both captured sides and actual playback in the local dashboard.

Measure speech-end to audible useful response, backend timing, call success and billed/provisional usage separately. Initial targets are median ordinary response <700 ms, p95 <1.5 seconds, and p95 backend-assisted useful response <3 seconds excluding external service delays. They remain targets until measured. Never mark an end-to-end path passed solely from a convincing transcript or accepted carrier command.
