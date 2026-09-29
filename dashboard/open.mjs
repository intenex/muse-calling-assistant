import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDataDir } from "./server.mjs";
const port = Number(process.env.DASHBOARD_PORT ?? 8790),
  url = `http://127.0.0.1:${port}`;
async function ready() {
  try {
    const r = await fetch(url + "/api/health", {
      signal: AbortSignal.timeout(500),
    });
    return r.ok && (await r.json()).app === "calling-assistant-local";
  } catch {
    return false;
  }
}
if (!(await ready())) {
  fs.mkdirSync(defaultDataDir, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(defaultDataDir, "server.log"), "a", 0o600);
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./server.mjs", import.meta.url))],
    { detached: true, stdio: ["ignore", log, log], env: process.env },
  );
  child.unref();
  fs.closeSync(log);
  for (let i = 0; i < 50 && !(await ready()); i++)
    await new Promise((r) => setTimeout(r, 200));
}
if (!(await ready()))
  throw new Error(
    "Dashboard could not start. Check the local configuration or whether port 8790 is occupied.",
  );
console.log("Call dashboard: " + url);
if (process.platform === "darwin" && !process.argv.includes("--no-open"))
  spawn("open", [url], { stdio: "ignore" }).unref();
