import http from "node:http";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const assets = fileURLToPath(new URL("./public/", import.meta.url));
const UUID = /^[0-9a-f-]{36}$/i;
const RETENTION = 30 * 86400000;
const MAX_AUDIO = 100 * 1024 * 1024;
const ended = (c) =>
  ["completed", "cancelled", "failed", "uncertain"].includes(c.status);
export const defaultDataDir = process.env.CALLING_DASHBOARD_DATA_DIR || path.join(
  process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support")
    : process.platform === "win32" ? (process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"))
    : (process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")),
  "Muse Calling Assistant", "dashboard",
);
const fail = (status, message) => Object.assign(new Error(message), { status });

export function rangeFor(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]))
    throw fail(416, "Invalid audio range");
  let start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  let end =
    match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start > end ||
    start >= size
  )
    throw fail(416, "Audio range unavailable");
  return { start, end, partial: true };
}

export function audioType(buffer) {
  if (
    buffer.subarray(0, 4).toString() === "RIFF" &&
    buffer.subarray(8, 12).toString() === "WAVE"
  )
    return "wav";
  if (
    buffer.subarray(0, 3).toString() === "ID3" ||
    (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
  )
    return "mp3";
  throw fail(415, "Choose an actual WAV or MP3 recording.");
}

export async function createDashboard({
  dataDir = defaultDataDir,
  base,
  ownerKey,
  telnyxKey,
  connectionId,
  fetchImpl = fetch,
  requestIntervalMs = 450,
} = {}) {
  if (!ownerKey || !base)
    throw new Error(
      "The local .dev.vars owner key and service URL are required.",
    );
  if (!base.startsWith("https://"))
    throw new Error("The calling service must use HTTPS.");
  await fs.mkdir(path.join(dataDir, "audio"), { recursive: true, mode: 0o700 });
  const cacheFile = path.join(dataDir, "history.json");
  let state = {
    version: 1,
    syncedAt: null,
    calls: [],
    recordings: [],
    warnings: [],
  };
  try {
    const saved = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    if (saved.version === 1) state = saved;
  } catch (e) {
    if (e.code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
  }
  let syncPromise,
    lastAttempt = 0;
  let writes = Promise.resolve();
  function scrub() {
    for (const c of state.calls)
      if (c.createdAt < Date.now() - RETENTION)
        c.transcript = { fragments: [], purged: true };
  }
  function persist() {
    scrub();
    const serialized = JSON.stringify(state);
    writes = writes
      .catch(() => {})
      .then(async () => {
        await fs.writeFile(cacheFile + ".tmp", serialized, { mode: 0o600 });
        await fs.rename(cacheFile + ".tmp", cacheFile);
      });
    return writes;
  }
  async function remote(url, key) {
    const r = await fetchImpl(url, {
      headers: { authorization: "Bearer " + key },
      signal: AbortSignal.timeout(12000),
      redirect: "error",
    });
    if (!r.ok)
      throw fail(
        502,
        `History service returned ${r.status}. Saved history remains available.`,
      );
    return r.json();
  }
  let nextRequestAt = 0;
  const api = async (p) => {
    // Stay below the service's shared owner-credential limit of 30 reads / 10 s.
    const wait = Math.max(0, nextRequestAt - Date.now());
    nextRequestAt = Date.now() + wait + requestIntervalMs;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    return remote(base.replace(/\/$/, "") + p, ownerKey);
  };
  const carrier = (p) => remote("https://api.telnyx.com/v2" + p, telnyxKey);
  async function sync() {
    if (syncPromise) return syncPromise;
    if (Date.now() - lastAttempt < 15000) return state;
    lastAttempt = Date.now();
    syncPromise = (async () => {
      const deadline = Date.now() + 180000;
      const index = await api("/v1/calls");
      if (!Array.isArray(index.calls))
        throw fail(502, "Unexpected history response.");
      const warnings = [];
      if (index.calls.length >= 100)
        warnings.push(
          "The service returns the latest 100 calls. Earlier locally saved calls are also shown.",
        );
      const previous = new Map(state.calls.map((c) => [c.id, c]));
      const calls = [];
      // At most two requests in flight, with a fixed 200-request ceiling per manual refresh.
      for (const entry of index.calls.slice(0, 100)) {
        if (!UUID.test(entry.id)) continue;
        const cached = previous.get(entry.id);
        if (Date.now() > deadline) {
          calls.push(
            cached ?? {
              ...entry,
              destination: { business: "Call details not loaded", number: "" },
              loadError: true,
            },
          );
          warnings.push(
            "Refresh reached its three-minute limit. Refresh again to load remaining details.",
          );
          continue;
        }
        if (
          cached &&
          !cached.loadError &&
          cached.recording?.status !== "requested" &&
          ended(cached) &&
          cached.result?.finalized !== false &&
          cached.status === entry.status &&
          cached.usage?.costCents === entry.charged &&
          cached.usage?.final === entry.final
        ) {
          calls.push(cached);
          continue;
        }
        try {
          const [call, transcript] = await Promise.all([
            api("/v1/calls/" + entry.id),
            api("/v1/calls/" + entry.id + "/transcript"),
          ]);
          calls.push({ ...call, transcript });
        } catch (e) {
          calls.push(
            cached ?? {
              ...entry,
              destination: { business: "Call details unavailable", number: "" },
              transcript: { fragments: [] },
              loadError: true,
            },
          );
          warnings.push(
            "Some call details could not refresh. Try Refresh again.",
          );
        }
      }
      // A short complete index is authoritative, so remotely deleted calls disappear.
      if (index.calls.length >= 100)
        for (const c of state.calls)
          if (!calls.some((x) => x.id === c.id)) calls.push(c);
      let recordings = state.recordings;
      if (telnyxKey && connectionId) {
        try {
          const found = [];
          for (let page = 1; page <= 20; page++) {
            const response = await carrier(
              `/recordings?filter[connection_id]=${encodeURIComponent(connectionId)}&page[size]=100&page[number]=${page}`,
            );
            for (const r of response.data ?? []) {
              if (r.connection_id !== connectionId || !UUID.test(r.id))
                continue;
              const call = calls.find(
                (c) =>
                  c.providerRefs?.telnyxCallControlId === r.call_control_id,
              );
              if (!call) continue; // Never associate a recording by a guessed phone number/time.
              const old = state.recordings.find((x) => x.id === r.id);
              found.push({
                id: r.id,
                callId: call.id,
                durationMs: r.duration_millis,
                format: r.download_urls?.mp3 ? "mp3" : "wav",
                source: "telnyx",
                createdAt: r.recording_started_at,
                localFile: old?.localFile,
              });
            }
            if (page >= (response.meta?.total_pages ?? 1)) break;
            if (page === 20)
              warnings.push("Recording lookup reached its 2,000-item bound.");
          }
          recordings = [
            ...found,
            ...state.recordings.filter(
              (r) =>
                r.source === "import" ||
                (r.localFile && !found.some((x) => x.id === r.id)),
            ),
          ];
        } catch {
          warnings.push(
            "Carrier recordings could not refresh. Local audio is still available.",
          );
        }
      }
      state = {
        ...state,
        calls: calls.sort((a, b) => b.createdAt - a.createdAt),
        recordings,
        syncedAt: Date.now(),
        warnings: [...new Set(warnings)],
      };
      await persist();
      return state;
    })().finally(() => {
      syncPromise = null;
    });
    return syncPromise;
  }
  function publicHistory() {
    scrub();
    return {
      ...state,
      calls: state.calls.map(({ providerRefs, operations, ...c }) => c),
      recordings: state.recordings.map(({ localFile, ...r }) => ({
        ...r,
        format: localFile?.split(".").at(-1) ?? r.format,
        availableLocally: !!localFile,
      })),
      localOnly: true,
      refreshing: !!syncPromise,
    };
  }
  const downloads = new Map();
  async function ensureAudio(recording) {
    if (recording.localFile)
      return path.join(dataDir, "audio", path.basename(recording.localFile));
    if (downloads.has(recording.id)) return downloads.get(recording.id);
    const work = (async () => {
      const { data } = await carrier("/recordings/" + recording.id);
      const call = state.calls.find((c) => c.id === recording.callId);
      if (
        !call ||
        data.connection_id !== connectionId ||
        data.call_control_id !== call.providerRefs?.telnyxCallControlId
      )
        throw fail(404, "Recording does not belong to this call.");
      const url = new URL(data.download_urls?.mp3 ?? data.download_urls?.wav);
      // Only vendor recording hosts; never relay credentials to signed media URLs.
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !(
          url.hostname === "telnyx.com" ||
          url.hostname.endsWith(".telnyx.com") ||
          url.hostname.endsWith(".telnyxcloudstorage.com") ||
          /(?:^|\.)s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)
        )
      )
        throw fail(502, "The carrier returned an unsupported recording host.");
      const r = await fetchImpl(url, {
        signal: AbortSignal.timeout(60000),
        redirect: "error",
      });
      if (!r.ok || !r.body)
        throw fail(
          502,
          "Recording download is unavailable. Refresh and retry.",
        );
      const bytes = await boundedBody(r.body, MAX_AUDIO);
      return saveAudio(recording, bytes);
    })().finally(() => downloads.delete(recording.id));
    downloads.set(recording.id, work);
    return work;
  }
  async function saveAudio(recording, bytes) {
    const ext = audioType(bytes);
    const file = recording.id + "." + ext;
    const dest = path.join(dataDir, "audio", file);
    await fs.writeFile(dest + ".tmp", bytes, { mode: 0o600 });
    await fs.rename(dest + ".tmp", dest);
    recording.localFile = file;
    if (!state.recordings.some((x) => x.id === recording.id))
      state.recordings.push(recording);
    // The refresh may have replaced the recording object during a download.
    const current = state.recordings.find((x) => x.id === recording.id);
    current.localFile = file;
    await persist();
    return dest;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    function json(value, status = 200) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    }
    try {
      const port = server.address()?.port;
      const expected = `127.0.0.1:${port}`;
      if (req.headers.host !== expected)
        throw fail(403, "Open the dashboard using its 127.0.0.1 address.");
      if (req.headers.origin && req.headers.origin !== `http://${expected}`)
        throw fail(403, "Cross-origin access denied.");
      if (
        req.headers["sec-fetch-site"] &&
        !["same-origin", "none"].includes(req.headers["sec-fetch-site"])
      )
        throw fail(403, "Cross-site access denied.");
      const url = new URL(req.url, `http://${expected}`);
      if (url.pathname === "/api/health" && req.method === "GET")
        return json({ app: "calling-assistant-local", version: 1 });
      if (url.pathname === "/api/history" && req.method === "GET")
        return json(publicHistory());
      if (url.pathname === "/api/sync" && req.method === "POST") {
        if (req.headers["x-dashboard-action"] !== "1")
          throw fail(403, "Dashboard action header required.");
        await sync();
        return json(publicHistory());
      }
      const transcript = /^\/api\/calls\/([0-9a-f-]{36})\/transcript.txt$/.exec(
        url.pathname,
      );
      if (transcript && req.method === "GET") {
        scrub();
        const call = state.calls.find((c) => c.id === transcript[1]);
        if (!call) throw fail(404, "Call not found.");
        const turns = [];
        for (const f of call.transcript?.fragments ?? []) {
          const previous = turns.at(-1);
          if (
            previous &&
            previous.speaker === f.speaker &&
            f.at - previous.lastAt < 8000
          ) {
            previous.text += f.text;
            previous.lastAt = f.at;
          } else turns.push({ ...f, lastAt: f.at });
        }
        const content = [
          call.destination?.business,
          call.destination?.number,
          new Date(call.createdAt).toISOString(),
          ...(turns.length
            ? turns.map(
                (t) =>
                  `${t.speaker === "assistant" ? "Assistant (generated; playback unverified)" : "Recipient"}: ${t.text}`,
              )
            : [
                call.transcript?.purged
                  ? "Transcript expired under the 30-day retention policy."
                  : "No transcript was captured.",
              ]),
        ].join("\n\n");
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="call-${call.id}.txt"`,
        });
        return res.end(content);
      }
      const imp = /^\/api\/calls\/([0-9a-f-]{36})\/recordings$/.exec(
        url.pathname,
      );
      if (imp && req.method === "POST") {
        if (req.headers["x-dashboard-action"] !== "1")
          throw fail(403, "Dashboard action header required.");
        if (!state.calls.some((c) => c.id === imp[1]))
          throw fail(404, "Call not found.");
        if (Number(req.headers["content-length"]) > MAX_AUDIO)
          throw fail(413, "Recordings must be under 100 MB.");
        const bytes = await boundedBody(req, MAX_AUDIO);
        await saveAudio(
          {
            id: randomUUID(),
            callId: imp[1],
            source: "import",
            createdAt: Date.now(),
          },
          bytes,
        );
        return json(publicHistory(), 201);
      }
      const audio = /^\/api\/recordings\/([0-9a-f-]{36})\/audio$/.exec(
        url.pathname,
      );
      if (audio && ["GET", "HEAD"].includes(req.method)) {
        const recording = state.recordings.find((r) => r.id === audio[1]);
        if (!recording || !state.calls.some((c) => c.id === recording.callId))
          throw fail(404, "Recording not found.");
        const file = await ensureAudio(recording),
          stat = await fs.stat(file);
        let range;
        try {
          range = rangeFor(req.headers.range, stat.size);
        } catch (e) {
          res.setHeader("Content-Range", `bytes */${stat.size}`);
          throw e;
        }
        const headers = {
          "Content-Type": file.endsWith(".wav") ? "audio/wav" : "audio/mpeg",
          "Content-Length": range.end - range.start + 1,
          "Accept-Ranges": "bytes",
        };
        if (range.partial)
          headers["Content-Range"] =
            `bytes ${range.start}-${range.end}/${stat.size}`;
        res.writeHead(range.partial ? 206 : 200, headers);
        if (req.method === "HEAD") return res.end();
        await pipeline(
          createReadStream(file, { start: range.start, end: range.end }),
          res,
        );
        return;
      }
      const files = {
        "/": "index.html",
        "/app.js": "app.js",
        "/style.css": "style.css",
      };
      if (req.method === "GET" && files[url.pathname]) {
        const file = files[url.pathname];
        res.setHeader(
          "Content-Type",
          file.endsWith(".html")
            ? "text/html; charset=utf-8"
            : file.endsWith(".css")
              ? "text/css"
              : "text/javascript",
        );
        return res.end(await fs.readFile(path.join(assets, file)));
      }
      throw fail(404, "Not found");
    } catch (e) {
      if (res.headersSent) return res.destroy();
      json(
        {
          error: e.status
            ? e.message
            : "The local request failed. Try Refresh; saved history remains available.",
        },
        e.status ?? 500,
      );
    }
  });
  server.requestTimeout = 65000;
  server.headersTimeout = 10000;
  await persist();
  return { server, sync, history: publicHistory };
}

async function boundedBody(stream, limit) {
  const chunks = [];
  let count = 0;
  for await (const chunk of stream) {
    count += chunk.length;
    if (count > limit) throw fail(413, "Recording exceeds the 100 MB limit.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Resolve configuration relative to this project, even when launched from Finder.
  const text = await fs.readFile(path.join(root, ".dev.vars"), "utf8");
  const env = Object.fromEntries(
    text
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => {
        const i = l.indexOf("=");
        return [
          l.slice(0, i),
          l
            .slice(i + 1)
            .trim()
            .replace(/^['"]|['"]$/g, ""),
        ];
      }),
  );
  const config = JSON.parse(
    await fs.readFile(path.join(root, "wrangler.jsonc"), "utf8"),
  );
  const { server } = await createDashboard({
    base: config.vars.PUBLIC_BASE_URL,
    ownerKey: env.OWNER_API_KEY,
    telnyxKey: env.TELNYX_API_KEY,
    connectionId: env.TELNYX_CONNECTION_ID,
  });
  const port = Number(process.env.DASHBOARD_PORT ?? 8790);
  server.listen(port, "127.0.0.1", () =>
    console.log(`Call dashboard: http://127.0.0.1:${port}`),
  );
  server.on("error", (e) => {
    console.error(
      e.code === "EADDRINUSE"
        ? "Dashboard port already in use. Run npm run dashboard:open."
        : "Unable to start local dashboard.",
    );
    process.exitCode = 1;
  });
}
