import { CallingClient, bearerTransport } from "../packages/client/index";
const [id, since = "0"] = process.argv.slice(2),
  base = process.env.CALLING_API_URL,
  token = process.env.CALLING_API_KEY;
if (!id || !base || !token)
  throw new Error(
    "Usage: CALLING_API_URL=... CALLING_API_KEY=<injected by secret manager> npm run supervise -- CALL_ID [SINCE_SEQ]",
  );
const client = new CallingClient(base, bearerTransport(token));
console.log(
  JSON.stringify(
    await client.supervise(id, { since: Number(since), timeoutMs: 55000 }),
  ),
);
