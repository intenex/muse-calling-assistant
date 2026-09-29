# Contributing

Use Node.js 22.12+ and `npm ci`. Start with the local simulator and fictional data. Run `npm run check`, `npm test`, and `npm run build` before submitting a change. The Workers tests explicitly replace paid credentials; never add a real-provider test to the default suite.

Describe the concrete behavior changed, relevant verification and untested real-world paths. Include regression coverage for authority, cost, durable operations, audio accounting or privacy changes. Avoid tests that only mirror static implementation text.

Do not submit keys, personal phone numbers, account identifiers, transcripts, recordings or private deployment evidence. A clean example should use reserved fictional destinations and fake provider responses. The project has no automatic CI/deploy workflow; keep paid integrations and phone evaluations manual.

The core source is MIT licensed. Generated runtime types retain their own notices; dependencies retain their respective licenses. This project is independently maintained and does not claim affiliation with the service vendors.
