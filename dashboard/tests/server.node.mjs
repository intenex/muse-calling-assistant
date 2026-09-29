import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createDashboard, rangeFor } from "../server.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const ownerKey = "test-owner-secret",
  telnyxKey = "test-carrier-secret";
function wav() {
  const b = Buffer.alloc(44 + 16000);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(16000, 40);
  return b;
}
async function setup(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "call-dashboard-test-"));
  const requests = [];
  const call = {
    id,
    createdAt: Date.now(),
    mode: "live",
    status: "completed",
    destination: { business: "Test recipient", number: "+12025550100" },
    providerRefs: { telnyxCallControlId: "control" },
    usage: { costCents: 3, final: false, liveSeconds: 15 },
    result: { finalized: true, summary: "Test outcome" },
  };
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    assert.equal(options.method, undefined, "upstream is read-only");
    if (overrides.fetch) return overrides.fetch(url, options);
    if (String(url).includes("api.telnyx.com"))
      return Response.json({ data: [], meta: { total_pages: 0 } });
    if (String(url).endsWith("/transcript"))
      return Response.json({
        fragments: [{ speaker: "business", text: "Hello", at: Date.now() }],
      });
    if (String(url).endsWith("/v1/calls"))
      return Response.json({
        calls: [{ id, status: "completed", charged: 3, final: false }],
      });
    return Response.json(call);
  };
  const dashboard = await createDashboard({
    dataDir: dir,
    base: "https://calls.example",
    ownerKey,
    telnyxKey,
    connectionId: "connection",
    fetchImpl,
    requestIntervalMs: 0,
  });
  await new Promise((r) => dashboard.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + dashboard.server.address().port;
  t.after(async () => {
    await new Promise((r) => dashboard.server.close(r));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { ...dashboard, dir, base, requests, call };
}

test("history sync uses owner authorization, strips control IDs and keeps keys off disk/browser", async (t) => {
  const d = await setup(t);
  await d.sync();
  const r = await fetch(d.base + "/api/history"),
    body = await r.text();
  assert.equal(r.status, 200);
  assert.match(body, /Test recipient/);
  assert.match(body, /Hello/);
  assert(!body.includes(ownerKey));
  assert(!body.includes("telnyxCallControlId"));
  assert.equal(
    d.requests[0].options.headers.authorization,
    "Bearer " + ownerKey,
  );
  const disk = await fs.readFile(path.join(d.dir, "history.json"), "utf8");
  assert(!disk.includes(ownerKey));
  assert(!disk.includes(telnyxKey));
  assert.equal(r.headers.get("cache-control"), "no-store");
});
test("loopback dashboard rejects remote Host, cross-origin and cross-site requests, and API mutations", async (t) => {
  const d = await setup(t);
  for (const headers of [
    { host: "evil.example" },
    { origin: "https://evil.example" },
    { "sec-fetch-site": "cross-site" },
  ]) {
    const status = await new Promise((resolve, reject) =>
      http
        .get(d.base + "/api/history", { headers }, (r) => {
          r.resume();
          resolve(r.statusCode);
        })
        .on("error", reject),
    );
    assert.equal(status, 403, JSON.stringify(headers));
  }
  assert.equal(
    (await fetch(d.base + "/api/sync", { method: "POST" })).status,
    403,
  );
  assert.equal(
    (await fetch(d.base + "/v1/calls", { method: "POST" })).status,
    404,
  );
  assert.equal(d.requests.length, 0);
});
test("parallel and repeated refresh requests share bounded upstream work", async (t) => {
  const d = await setup(t);
  await Promise.all([d.sync(), d.sync(), d.sync()]);
  await d.sync();
  assert.equal(d.requests.length, 4);
});
test("local import supports seekable Range, suffix requests, HEAD and no upstream upload", async (t) => {
  const d = await setup(t);
  await d.sync();
  const requestCount = d.requests.length;
  const r = await fetch(d.base + `/api/calls/${id}/recordings`, {
    method: "POST",
    headers: { "x-dashboard-action": "1" },
    body: wav(),
  });
  assert.equal(r.status, 201);
  const saved = await r.json();
  const rid = saved.recordings[0].id;
  assert.equal(saved.recordings[0].source, "import");
  assert(!("localFile" in saved.recordings[0]));
  const audio = d.base + `/api/recordings/${rid}/audio`;
  const range = await fetch(audio, { headers: { range: "bytes=0-11" } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 12);
  assert.equal(range.headers.get("content-type"), "audio/wav");
  const suffix = await fetch(audio, { headers: { range: "bytes=-8" } });
  assert.equal((await suffix.arrayBuffer()).byteLength, 8);
  const head = await fetch(audio, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(wav().length));
  assert.equal(
    (await fetch(audio, { headers: { range: "bytes=99999999-" } })).status,
    416,
  );
  assert.equal(d.requests.length, requestCount);
});
test("invalid file imports and unknown calls never create recording entries", async (t) => {
  const d = await setup(t);
  await d.sync();
  const bad = await fetch(d.base + `/api/calls/${id}/recordings`, {
    method: "POST",
    headers: { "x-dashboard-action": "1" },
    body: "<script>not audio</script>",
  });
  assert.equal(bad.status, 415);
  assert.equal(d.history().recordings.length, 0);
});
test("recording listing follows provider pagination and matches only exact call identity", async (t) => {
  let page = 0;
  const d = await setup(t, {
    fetch: async (url) => {
      if (String(url).includes("api.telnyx.com")) {
        page++;
        return Response.json({
          data: [
            {
              id:
                (page === 1 ? "22222222" : "33333333") +
                "-1111-4111-8111-111111111111",
              connection_id: "connection",
              call_control_id: page === 1 ? "unrelated" : "control",
              download_urls: { mp3: "https://secret.signed.example" },
            },
          ],
          meta: { total_pages: 2 },
        });
      }
      if (String(url).endsWith("/v1/calls"))
        return Response.json({ calls: [{ id }] });
      if (String(url).endsWith("/transcript"))
        return Response.json({ fragments: [] });
      return Response.json({
        id,
        createdAt: Date.now(),
        status: "completed",
        providerRefs: { telnyxCallControlId: "control" },
      });
    },
  });
  await d.sync();
  assert.equal(page, 2);
  assert.equal(d.history().recordings.length, 1);
  assert(!JSON.stringify(d.history()).includes("signed.example"));
});
test("saved history works offline and expired transcripts are removed", async (t) => {
  const d = await setup(t);
  await d.sync();
  const file = path.join(d.dir, "history.json");
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  state.calls[0].createdAt = Date.now() - 31 * 86400000;
  await fs.writeFile(file, JSON.stringify(state));
  const offline = await createDashboard({
    dataDir: d.dir,
    base: "https://calls.example",
    ownerKey,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  await assert.rejects(offline.sync());
  assert.equal(offline.history().calls.length, 1);
  assert.equal(offline.history().calls[0].transcript.purged, true);
  assert.deepEqual(offline.history().calls[0].transcript.fragments, []);
});
test("range parser rejects malformed or inverted ranges", () => {
  for (const value of [
    "bytes=",
    "bytes=2-1",
    "bytes=0-1,2-3",
    "bytes=-0",
    "items=0-1",
  ])
    assert.throws(() => rangeFor(value, 10));
  assert.deepEqual(rangeFor("bytes=2-99", 10), {
    start: 2,
    end: 9,
    partial: true,
  });
});

test("transcript export is a private real attachment without provider IDs", async (t) => {
  const d = await setup(t);
  await d.sync();
  const r = await fetch(d.base + `/api/calls/${id}/transcript.txt`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /attachment/);
  const text = await r.text();
  assert.match(text, /Recipient: Hello/);
  assert(!text.includes("telnyxCallControlId"));
  assert(!text.includes(ownerKey));
});

test("carrier audio downloads only on demand, keeps credentials off the media request and reuses local bytes", async (t) => {
  const rid = "22222222-1111-4111-8111-111111111111";
  let mediaReads = 0;
  const recording = {
    id: rid,
    connection_id: "connection",
    call_control_id: "control",
    download_urls: {
      wav: "https://recordings.s3.amazonaws.com/private-audio?signature=test-only",
    },
  };
  const d = await setup(t, {
    fetch: async (url, options) => {
      const u = String(url);
      if (u.includes("s3.amazonaws.com")) {
        mediaReads++;
        assert.equal(options.headers, undefined);
        return new Response(wav());
      }
      if (u.includes("/v2/recordings/" + rid))
        return Response.json({ data: recording });
      if (u.includes("api.telnyx.com"))
        return Response.json({ data: [recording], meta: { total_pages: 1 } });
      if (u.endsWith("/v1/calls")) return Response.json({ calls: [{ id }] });
      if (u.endsWith("/transcript")) return Response.json({ fragments: [] });
      return Response.json({
        id,
        createdAt: Date.now(),
        status: "completed",
        providerRefs: { telnyxCallControlId: "control" },
      });
    },
  });
  await d.sync();
  assert.equal(mediaReads, 0);
  for (let i = 0; i < 2; i++) {
    const r = await fetch(d.base + `/api/recordings/${rid}/audio`, {
      headers: { range: "bytes=0-11" },
    });
    assert.equal(r.status, 206);
    assert.equal((await r.arrayBuffer()).byteLength, 12);
  }
  assert.equal(mediaReads, 1);
  assert(!JSON.stringify(d.history()).includes("signature="));
  assert.equal(d.history().recordings[0].format, "wav");
});
