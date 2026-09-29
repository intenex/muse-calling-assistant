# Costs and bounded operation

All installation, deployment and evaluation commands are manual. There are no GitHub Actions workflows, cron triggers, automatic deployments, automatic redials, number purchases, top-ups or plan upgrades. The application still incurs paid OpenAI/Telnyx usage when you explicitly request a live call.

## Planning estimates

GPT-Live-1 is listed at **$0.05 per active session minute**, billed per second. Connected silence, hold time and waiting for reasoning count; backend tokens are separate. [OpenAI model pricing](https://developers.openai.com/api/docs/models/gpt-live-1).

At 100–300 connected minutes/month that voice layer alone is $5–$15. Illustrative US carrier/Voice API/streaming cost near $0.0105/minute adds about $1.05–$3.15; recording at $0.002/minute adds $0.20–$0.60. Number rent, backend models, taxes, route-specific rates, failed attempts and extras are additional. Verify your route and account at [Telnyx pricing](https://telnyx.com/pricing/voice-api); these are estimates, not a quote or measured bills.

A light workload with roughly $1–$10 backend spend and about $1 number rent can fit around $9–$30/month before extras. No code guarantees that bill: provider rates/access, holding time, task complexity and other account usage matter. The reference application ceiling is $50, not permission to spend $50 on every test.

The code uses more conservative carrier reservations (1.5 cents/minute), adds recording when enabled, backend allowance and a fixed safety margin. Review `RATE` in `src/domain.ts` and `modelRate` / output limits in `src/providers/openai.ts` before substituting models or routes. A carrier rate ceiling is a provider setting, not automatically provisioned by this repository.

## Enforced bounds

| Work | Bound |
|---|---|
| Live admission | One concurrent call; unresolved calls retain the slot |
| Monthly app ledger | 5,000 cents, with configured fixed-cost allowance reserved |
| Individual task | At most 500 cents, 100 backend cents, 45 minutes |
| Daily connected time | 90 minutes; explicit reservation before dial |
| Model requests | At most 30/call; bounded tokens/timeouts; no automatic retry |
| DTMF | 20 commands/call, 24 digits/command, 8-second carrier request deadline |
| Supervision | About 5-second code polling; bounded windows, 10-second requests |
| IVR parsing | 1.2-second settling debounce in an active call; 30-second menu validity |
| Controlled phone exception | Exact owner-authorized number; ≤1-hour expiry; 2 min / 50 cents / 10 backend cents |
| Deployment | Manual; checks/tests/build; refuse active or unresolved calls |
| Dashboard | Manual bounded/cached sync; local playback; no scheduled AI or calls |

Reservation is not final billing. Failed/ambiguous requests retain conservative reservations, and cumulative usage does not get summed twice. Reconcile only from verified provider receipts. An exhausted provisional ledger may stop new calls even when the final invoice will be smaller; do not erase its accounting to resume work.

## Cloudflare headroom must be checked per account

Free Durable Objects currently include 100,000 requests/day, 13,000 GB-seconds/day, 5 million row reads/day, 100,000 row writes/day and 5 GB total SQLite storage. Incoming WebSocket messages receive the documented 20:1 request accounting adjustment. [Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/). Workers have separate shared-account limits; verify those too.

For a normal workload of 300 minutes spread over a month, a conservative 120 carrier + 100 voice messages/second produces about 198,000 billable socket requests/month, averaging 6,600/day. Reserving another 5,000 daily control/RPC/alarm requests gives about 11,600/day. Active duration at 128 MiB is about 2,250 GiB-seconds/month. Plan up to 10,000 row writes and 250,000 row reads per active day while the index is small, plus about 100 MB stored initially. These are workload projections, not an account audit; clustered traffic changes daily peaks.

The 90-minute emergency daily maximum at those assumed message rates alone reaches roughly 59,400 socket requests/day, above half the free request allowance. That ceiling is not the normal usage assumption. Keep normal account-wide usage at or below 50% of each applicable allowance; investigate at 70% and stop/manual-only at 90%. Measure actual voice event rates, SQL writes, index growth, existing workloads and account plan before setting `ACCOUNT_HEADROOM_VERIFIED=true`. If you cannot demonstrate headroom, keep live activation disabled or obtain a bounded budget decision. Never silently enable paid overages.

## Kill and pause

POST `{"draining":true}` to `/v1/admin/control` to stop new admission. POST `{"kill":true,"terminateActive":true}` to block paid work and request active termination. The controller checks owner permission/kill state during its bounded control loop; provider hard duration limits provide another stop. If termination is ambiguous, inspect the carrier and reconcile rather than redialing.

The ledger caps this application's planned usage, not unrelated provider-account spending or every possible provider fee. Configure independent provider budgets and disable unwanted top-ups as part of account setup.
