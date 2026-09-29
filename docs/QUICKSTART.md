# Set up your own service

## 1. Try the local simulator

Install Node.js 22.12+ and clone this repository. Run `npm ci`, then `npm run setup`. The wizard creates random owner/media/callback keys, hides provider input, writes `.dev.vars` with private permissions, and configures your Worker name and URL. Existing values are preserved when you press Enter. It makes no network requests.

For local-only simulation, leave provider fields empty and keep the placeholder URL. Start `npm run dev`, open `http://localhost:8787`, and sign in using the owner key from your local file. Run `CALLING_API_URL=http://127.0.0.1:8787 npm run test:ivr` in another terminal. No OpenAI or Telnyx credentials are needed for that fixture.

The wizard can be rerun before activation to add providers. It refuses to reset a configuration already marked live. Never commit `.dev.vars` or `.local/`.

## 2. Prepare the accounts

| Account | Required configuration |
|---|---|
| OpenAI | Project API key and access to `gpt-live-1`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra` |
| Cloudflare | Workers plus SQLite-backed Durable Objects; account allowance/headroom review |
| Telnyx | Outbound-capable verified account, API v2 key, webhook public key, owned/authorized calling number, Voice API application, outbound voice profile |

If a model is unavailable, verify the current API documentation and change the configured model only after checking request format, reasoning options, and the pricing bounds in `src/providers/openai.ts`. A model string alone does not make an incompatible model work. Model visibility checks are not session-access proof.

Log in with `npx wrangler login`. Find your Workers subdomain in the Cloudflare dashboard. Choose a fresh Worker name such as `my-calling-assistant`, and use `https://my-calling-assistant.YOUR_SUBDOMAIN.workers.dev` for `PUBLIC_BASE_URL`. Keep this URL consistent with the actual deployed name. Custom domains also work after you configure them.

## 3. Configure Telnyx once

In Telnyx's portal, create a **Voice API / Call Control application**, not a TeXML application. Configure:

1. API v2 webhooks to `https://YOUR_WORKER_HOST/webhooks/telnyx`.
2. An outbound voice profile assigned to that application. Allow US routes, one concurrent call, a transport-rate ceiling of $0.01/minute and a daily carrier spend threshold appropriate to your budget (the reference setup uses $2). Do not enable automatic top-ups or remove carrier limits just to make a rejected route work.
3. Your own Telnyx number as the outbound caller ID; connect it to the application. Acquiring a number is a separate, user-approved purchase.
4. Call-cost events enabled so the service receives carrier usage. The service also handles answer, hangup, recording, and streaming events.
5. Copy the application's connection ID and the account's **Ed25519 webhook public key**. This is not the API key.

The dial request sets bidirectional media streaming automatically; you do not need to build a second streaming server or transcription service. Profile-wide recording can remain disabled because the brief chooses per-call recording.

Official references: [Voice API application configuration](https://support.telnyx.com/en/articles/4374050-configuring-call-control-texml-applications-voice-api), [outbound profiles](https://support.telnyx.com/en/articles/4320411-more-about-outbound-voice-profiles). Account verification and eligibility must be completed by the account owner.

Rerun `npm run setup` with your HTTPS URL and provider configuration. Keep the generated owner/media keys. All local dev activation flags remain false even after production is activated.

## 4. First deployment

```sh
npm run deploy -- --bootstrap
npm run secrets -- --bootstrap
npm run doctor
npm run test:ivr
```

`--bootstrap` is only for a genuinely new simulation-only Worker. The first command runs TypeScript, all tests, a dry build, and deploys your service. The second uploads an explicit allowlist of secret fields via stdin; it does not upload local activation overrides. It can upload the owner/media keys alone for a hosted simulator. Neither command creates a call.

After this first bootstrap, use plain `npm run deploy`. It requires authenticated remote state, pauses admission, refuses to deploy across active or unresolved calls, and restores the previous admission state. A network failure is not permission to bypass drain checks.

`npm run doctor` checks local configuration, your deployed owner authentication, model listings and Telnyx application metadata. It makes no completions, purchases, or calls. Some checks require provider keys; local simulation intentionally leaves them missing. Fix `CHECK` items relevant to live service before continuing.

If secret upload failed after bootstrap, retry the same secret upload; do not deploy over a Worker whose state you cannot inspect. Do not use bootstrap for an existing service with live-call history.

## 5. Controlled telephone test, then activation

The software ships with `LIVE_ENABLED`, `ACCOUNT_HEADROOM_VERIFIED`, and `ROLLOUT_VERIFIED` all false. Do not copy somebody else's true flags.

First review your accounts' existing usage using [cost controls](COSTS.md). Then authorize one call to a **separate number you control**. Caller and destination cannot be the same number. In `wrangler.jsonc` only, set:

- `CONTROLLED_TEST_NUMBER` to that exact number.
- `CONTROLLED_TEST_UNTIL` to Unix milliseconds at most one hour in the future.

Deploy with `npm run deploy`. Copy `examples/controlled-call.json` to ignored `.local/controlled-call.json`, replace the fictional destination and caller name, choose recording/disclosures, and review the 2-minute / 50-cent / 10-cent backend limits. Validate, then explicitly create the one call:

```sh
npm run pca -- post /v1/calls/validate .local/controlled-call.json validation-test-1
npm run pca -- post /v1/calls .local/controlled-call.json controlled-test-1
```

Reuse `controlled-test-1` if the creation response is ambiguous; a new key may create a second call. Listen for correct numbers, corrections, interruptions, and a complete goodbye. Inspect events, provisional usage and the actual recording if enabled. The controlled exception is owner-only and never applies to a Muse key.

Clear both controlled-test fields immediately after evaluation and deploy. Once provider behavior, required call wording, account headroom and authority are acceptable, set the three activation flags to `"true"` in `wrangler.jsonc` and deploy again. `/v1/me` should report `liveReady:true`.

The files containing a real phone number stay ignored. Do not commit a temporary test number or activation audit with account identifiers.

## 6. Connect Muse

For a fresh live credential:

```sh
npm run agent:key -- --live
```

Or omit `--live` to test a simulation-only credential first. The key is saved in `.local/muse-api-key.txt`; a secret-free prompt with your host is saved in `.local/muse-connect.md`. The command will not overwrite an existing key or mint another after an ambiguous issuance. Follow [Muse connection and key promotion](MUSE.md).

Default agent permissions allow making calls, reading its own history/transcripts, supplying context/answers, and sending permitted keypad input. They allow **no financial or other commitments and no first-person identity mode**. Broader permissions are an explicit owner decision through the existing credential API; a brief cannot grant them to itself.

## 7. Open the history dashboard

```sh
npm run dashboard:open
```

Visit `http://127.0.0.1:8790`. macOS opens it automatically; other systems can use the printed link. Click Refresh after calls. See [storage and recording details](../dashboard/README.md). Your service API is hosted for carrier/Muse access; this history dashboard remains local.
