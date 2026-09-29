# Development instructions

- Preserve durable revisions, idempotency, operation intents, budget reservations, scope/revocation checks and recovery behavior.
- Run `npm run check`, `npm test`, `npm run build` for relevant changes. Tests must have paid credentials removed; actual phone tests are explicit manual work with bounded destinations, duration and budgets.
- Follow docs/COSTS.md before adding hosted, recurring, AI or deployment work. Keep normal account-wide usage at or below 50% of applicable free allowances; do not enable overages, upgrades or automatic paid work without an explicit owner decision.
- Deploy with `npm run deploy`; never bypass active/unresolved-call drain checks. Bootstrap is only for a genuinely new simulation-only Worker.
- Keep keys in .dev.vars/remote secrets, private briefs and evidence in ignored .local/, recordings outside the repository. Never commit personal destinations, transcripts, account IDs, auth links or production URLs belonging to another installation.
- Public defaults are simulation-only and generic caller identities. Preserve truthful direct automation answers and configurable required disclosures. Recording is a transport option, not permission to rewrite call opening instructions.
- Do not add automatic GitHub Actions, cron, redial or provider purchases. Reconcile ambiguous external outcomes before retry.
- Keep local/synthetic, actual Muse, phone/audio and provider-invoice evidence distinct.
