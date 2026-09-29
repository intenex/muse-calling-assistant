/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from "cloudflare:workers";
import {
  SELF,
  reset,
  runInDurableObject,
  evictDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  CallBriefSchema,
  ownerPrincipal,
  voiceInstructions,
  reservation,
  estimatedCost,
  explicitVoicemailInvitation,
  recipientRequestsHangup,
  assistantFarewell,
} from "../src/domain";
import { parseIvr, selectIvrOption, validateKeypad } from "../src/ivr";
import { calculate } from "../src/calculation";
import { dial } from "../src/providers/telnyx";
import { CallingClient } from "../packages/client/index";
import { Playback, AudioFrames } from "../src/playback";
import {
  contextChunks,
  connectLive,
  modelContext,
} from "../src/providers/openai";
import {
  hmac,
  mediaToken,
  verifyMedia,
  verifyTelnyx,
  to64,
  readBody,
} from "../src/security";
const testEnv: any = env;
const inDO: (
  stub: any,
  fn: (instance: any, state: DurableObjectState) => any,
) => Promise<any> = runInDurableObject as any;
const brief = () =>
  CallBriefSchema.parse({
    version: "1",
    destination: { number: "+14155550100", business: "Test Business" },
    caller: {
      name: "Test Owner",
      introduction: "AI assistant on behalf of Test Owner",
    },
    objective: "Ask about availability",
    successCriteria: ["Confirm availability"],
    origin: { agent: "test" },
    simulation: { durationSeconds: 480, questionAfterSeconds: 180 },
  });
const request = (
  path: string,
  body?: unknown,
  token = "test-owner-key",
  key: string = crypto.randomUUID(),
) =>
  SELF.fetch(`https://example.com${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function create(
  b = brief(),
  token = "test-owner-key",
  key = crypto.randomUUID(),
) {
  const r = await request("/v1/calls", b, token, key);
  const c: any = await r.json();
  expect(r.status, JSON.stringify(c)).toBe(201);
  return c;
}
async function decision(id: string) {
  const stub = testEnv.CALLS.getByName(id);
  await inDO(stub as DurableObjectStub, (instance: any) => {
    instance.s.createdAt = Date.now() - 181000;
    instance.save();
  });
  await runDurableObjectAlarm(stub as DurableObjectStub);
  const s = await stub.snapshot();
  return s.decisions[0];
}
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});
describe("public API and authority", () => {
  it("rejects unauthenticated API access and cross-origin mutations", async () => {
    expect((await request("/v1/calls", undefined, "bad")).status).toBe(401);
    const r = await SELF.fetch("https://example.com/v1/calls", {
      method: "POST",
      headers: {
        origin: "https://evil.test",
        authorization: "Bearer test-owner-key",
      },
      body: JSON.stringify(brief()),
    });
    expect(r.status).toBe(403);
  });
  it("validates without creating a call or charging providers", async () => {
    const r = await request("/v1/calls/validate", brief());
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).maximumEstimatedCents).toBe(0);
    expect(
      (await testEnv.OWNER.getByName("owner").inspect()).activeCalls,
    ).toEqual([]);
  });
  it("rejects live mode until credentials and rollout checks pass", async () => {
    expect(
      (await request("/v1/calls", { ...brief(), mode: "live" })).status,
    ).toBe(503);
  });
  it("creates one durable call for duplicate idempotency keys", async () => {
    const key = crypto.randomUUID(),
      b = brief();
    const replies = await Promise.all([
      request("/v1/calls", b, undefined, key),
      request("/v1/calls", b, undefined, key),
    ]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 201]);
    const values = await Promise.all(
      replies.map((r) => r.json() as Promise<any>),
    );
    expect(values[0].id).toBe(values[1].id);
    expect(
      (await testEnv.OWNER.getByName("owner").inspect()).activeCalls,
    ).toHaveLength(1);
    expect(
      (
        await request(
          "/v1/calls",
          { ...b, objective: "Different" },
          undefined,
          key,
        )
      ).status,
    ).toBe(409);
  });
  it("serializes concurrent distinct calls", async () => {
    const responses = await Promise.all([
      request("/v1/calls", brief()),
      request("/v1/calls", brief()),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  });
  it("binds visibility, destinations and commitment authority to credentials", async () => {
    const owner = testEnv.OWNER.getByName("owner");
    const agent = await owner.issue({
      name: "limited",
      scopes: ["calls:create", "calls:read"],
      destinations: ["+14155550100"],
    });
    const c = await create(brief(), agent.token);
    const other = await owner.issue({ name: "other", scopes: ["calls:read"] });
    expect(
      (await request(`/v1/calls/${c.id}`, undefined, other.token)).status,
    ).toBe(404);
    expect(
      (await request(`/v1/calls/${c.id}/transcript`, undefined, agent.token))
        .status,
    ).toBe(403);
    expect(
      (
        await request(
          "/v1/calls/validate",
          {
            ...brief(),
            authorizedCommitments: [
              {
                id: "book",
                description: "Book",
                terms: { price: 100 },
                maxAmountCents: 100,
              },
            ],
          },
          agent.token,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          "/v1/calls/validate",
          {
            ...brief(),
            destination: { number: "+12125550100", business: "Other" },
          },
          agent.token,
        )
      ).status,
    ).toBe(403);
  });
  it("does not leak transcript batches through event polling", async () => {
    const agent = await testEnv.OWNER.getByName("owner").issue({
      name: "status-only",
      scopes: ["calls:create", "calls:read"],
    });
    const c = await create(brief(), agent.token);
    await inDO(testEnv.CALLS.getByName(c.id), (instance) => {
      instance.event("transcript.batch", {
        fragments: [{ text: "private conversation" }],
      });
    });
    const limited: any = await (
      await request(`/v1/calls/${c.id}/events`, undefined, agent.token)
    ).json();
    const full: any = await (await request(`/v1/calls/${c.id}/events`)).json();
    expect(full.events.some((e: any) => e.type === "transcript.batch")).toBe(
      true,
    );
    expect(limited.events.some((e: any) => e.type === "transcript.batch")).toBe(
      false,
    );
    expect(limited.nextSeq).toBe(full.nextSeq);
  });
  it("never issues duplicate credentials after an ambiguous response", async () => {
    const key = crypto.randomUUID(),
      body = { name: "Muse", scopes: ["calls:read"] };
    const first = await request("/v1/admin/credentials", body, undefined, key);
    expect(first.status).toBe(201);
    expect(
      (await request("/v1/admin/credentials", body, undefined, key)).status,
    ).toBe(409);
    const state = await testEnv.OWNER.getByName("owner").inspect();
    expect(state.credentials.length).toBe(1);
  });
  it("upgrades an existing vault key atomically without changing its secret or expiration", async () => {
    const owner = testEnv.OWNER.getByName("owner");
    const agent = await owner.issue({
      name: "Muse",
      scopes: ["calls:create", "calls:read"],
    });
    const expires = (await owner.inspect()).credentials[0].expires;
    const body = {
      name: "Muse live",
      scopes: ["calls:create", "calls:read"],
      live: true,
      destinations: [],
      allowFirstPerson: true,
      allowCommitments: true,
      maxCommitmentCents: 0,
      expectedRevision: 1,
    };
    const path = `/v1/admin/credentials/${agent.id}`;
    const forbidden = await request(path, body, agent.token);
    expect(forbidden.status).toBe(403);
    await forbidden.json();
    const notDrained = await request(path, body);
    expect(notDrained.status).toBe(409);
    await notDrained.json();
    await owner.control({ draining: true });
    const key = crypto.randomUUID();
    const changed: any = await (
      await request(path, body, undefined, key)
    ).json();
    expect(changed.expires).toBe(expires);
    expect(changed.token).toBeUndefined();
    expect(changed.principal).toMatchObject({
      live: true,
      destinations: [],
      owner: false,
      credentialRevision: 2,
    });
    await evictDurableObject(owner, { webSockets: "close" });
    const me: any = await (
      await request("/v1/me", undefined, agent.token)
    ).json();
    expect(me.principal).toEqual(changed.principal);
    const later = { ...body, live: false, expectedRevision: 2 };
    expect((await request(path, later)).status).toBe(200);
    expect((await request(path, body, undefined, key)).status).toBe(200);
    expect((await owner.authenticate(agent.token)).live).toBe(false);
    expect(
      (await request(path, { ...body, name: "different" }, undefined, key))
        .status,
    ).toBe(409);
    expect((await request(path, body)).status).toBe(409);
    await owner.revoke(agent.id);
    expect(
      (await request(path, { ...later, expectedRevision: 3 })).status,
    ).toBe(404);
  });
  it("refuses a credential edit during a call and rejects an in-flight old principal after editing", async () => {
    const owner = testEnv.OWNER.getByName("owner");
    const agent = await owner.issue({
      name: "Muse",
      scopes: ["calls:create", "calls:read"],
    });
    const call = await create(brief(), agent.token);
    const body = {
      name: "Muse live",
      scopes: ["calls:create", "calls:read"],
      live: true,
      expectedRevision: 1,
    };
    await owner.control({ draining: true });
    expect(
      (await request(`/v1/admin/credentials/${agent.id}`, body)).status,
    ).toBe(409);
    await testEnv.CALLS.getByName(call.id).stop("cancelled", "Test complete");
    expect(
      (await request(`/v1/admin/credentials/${agent.id}`, body)).status,
    ).toBe(200);
    await owner.control({ draining: false });
    await inDO(owner, async (instance) => {
      await expect(
        instance.create(agent.principal, brief(), crypto.randomUUID(), "hash"),
      ).rejects.toThrow("Credential changed");
    });
    expect(await owner.activeCredential(agent.id, 1)).toBe(false);
    expect(await owner.activeCredential(agent.id, 2)).toBe(true);
    expect((await request("/v1/calls", brief(), agent.token)).status).toBe(201);
  });
  it("allows personal and business recipients across US numbers while preserving financial and region limits", async () => {
    const owner = testEnv.OWNER.getByName("owner");
    const agent = await owner.issue({
      name: "Muse live",
      scopes: ["calls:create"],
      live: true,
      destinations: [],
      allowFirstPerson: true,
      allowCommitments: true,
      maxCommitmentCents: 0,
    });
    for (const number of ["+14155550100", "+12125550100", "+16285550100"]) {
      expect(
        (
          await request(
            "/v1/calls/validate",
            {
              ...brief(),
              mode: "live",
              destination: { number, business: "Friend or business" },
              caller: { name: "Test Owner", persona: "first_person" },
            },
            agent.token,
          )
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await request(
          "/v1/calls/validate",
          {
            ...brief(),
            mode: "live",
            authorizedCommitments: [
              {
                id: "purchase",
                description: "Buy",
                terms: { price: 1 },
                maxAmountCents: 100,
              },
            ],
          },
          agent.token,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          "/v1/calls/validate",
          {
            ...brief(),
            mode: "live",
            destination: { number: "+19005550100", business: "Premium" },
          },
          agent.token,
        )
      ).status,
    ).toBe(422);
  });
  it("revokes a spoken commitment permit when the business corrects its terms", async () => {
    const c = await create();
    await inDO(testEnv.CALLS.getByName(c.id), (instance) => {
      instance.s.operations.push({
        id: "permit",
        kind: "spoken_commitment_authorization",
        revision: 1,
        at: Date.now(),
        status: "succeeded",
      });
      instance.onVoice({
        type: "session.input_transcript.delta",
        delta: "Actually, the cost has changed.",
      });
      expect(
        instance.s.operations.find((o: any) => o.id === "permit").status,
      ).toBe("failed");
    });
  });
  it("revocation stops active work and invalidates the key", async () => {
    const owner = testEnv.OWNER.getByName("owner"),
      agent = await owner.issue({
        name: "Muse",
        scopes: ["calls:create", "calls:read"],
      });
    const c = await create(brief(), agent.token);
    await owner.revoke(agent.id);
    expect(
      (await request(`/v1/calls/${c.id}`, undefined, agent.token)).status,
    ).toBe(401);
    expect((await testEnv.CALLS.getByName(c.id).snapshot()).status).toBe(
      "cancelled",
    );
  });
});
describe("durable decisions and recovery", () => {
  it("persists context and its replay receipt even if the voice socket fails", async () => {
    const c = await create(),
      stub = testEnv.CALLS.getByName(c.id);
    await inDO(stub, (instance) => {
      instance.liveReady = true;
      instance.live = {
        send() {
          throw new Error("Synthetic socket failure");
        },
        close() {},
      };
    });
    const key = crypto.randomUUID(),
      body = {
        expectedRevision: 1,
        facts: [
          { id: "reference", text: "Reference A734", visibility: "shareable" },
        ],
      };
    const response = await request(
      `/v1/calls/${c.id}/context`,
      body,
      undefined,
      key,
    );
    expect(response.status).toBe(200);
    await evictDurableObject(stub);
    const replay = await request(
      `/v1/calls/${c.id}/context`,
      body,
      undefined,
      key,
    );
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as any).revision).toBe(2);
    expect((await stub.snapshot()).revision).toBe(2);
  }, 20000); // Eviction waits for the bounded 15-second voice-close cleanup.
  it("answers once and rejects stale answers after a correction", async () => {
    const c = await create(),
      d = await decision(c.id);
    expect(d.status).toBe("pending");
    const key = crypto.randomUUID(),
      body = {
        decisionId: d.id,
        expectedRevision: d.revision,
        answer: "Morning",
      };
    expect(
      (await request(`/v1/calls/${c.id}/answers`, body, undefined, key)).status,
    ).toBe(200);
    expect(
      (await request(`/v1/calls/${c.id}/answers`, body, undefined, key)).status,
    ).toBe(200);
    expect(
      (
        await request(`/v1/calls/${c.id}/answers`, {
          ...body,
          answer: "Afternoon",
        })
      ).status,
    ).toBe(409);
    const s = await testEnv.CALLS.getByName(c.id).snapshot();
    expect(s.revision).toBe(2);
  });
  it("corrections supersede pending questions and stale context", async () => {
    const c = await create(),
      d = await decision(c.id);
    expect(
      (
        await request(`/v1/calls/${c.id}/context`, {
          expectedRevision: 1,
          facts: [
            { id: "name", text: "Corrected name", visibility: "shareable" },
          ],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/v1/calls/${c.id}/answers`, {
          decisionId: d.id,
          expectedRevision: 1,
          answer: "Morning",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/v1/calls/${c.id}/context`, {
          expectedRevision: 1,
          facts: [],
        })
      ).status,
    ).toBe(409);
  });
  it("expires a decision across an actual Durable Object eviction", async () => {
    const c = await create(),
      d = await decision(c.id),
      stub = testEnv.CALLS.getByName(c.id);
    await inDO(stub as DurableObjectStub, (i: any) => {
      i.s.decisions[0].deadline = Date.now() - 1;
      i.save();
    });
    await evictDurableObject(stub as DurableObjectStub);
    await runDurableObjectAlarm(stub as DurableObjectStub);
    const state = await stub.snapshot();
    expect(state.decisions[0].status).toBe("expired");
    expect(state.status).toBe("completed");
    expect(state.result?.outcome).toBe("unsuccessful");
    expect(
      (
        await request(`/v1/calls/${c.id}/answers`, {
          decisionId: d.id,
          expectedRevision: 1,
          answer: "Morning",
        })
      ).status,
    ).toBe(409);
  });
  it("continues only under the explicit collect-information fallback", async () => {
    const b = brief();
    b.escalation.fallback = "collect_information";
    const c = await create(b);
    await decision(c.id);
    const stub = testEnv.CALLS.getByName(c.id);
    await inDO(stub as DurableObjectStub, (i: any) => {
      i.s.decisions[0].deadline = Date.now() - 1;
      i.save();
    });
    await runDurableObjectAlarm(stub as DurableObjectStub);
    expect((await stub.snapshot()).status).toBe("active");
    expect((await stub.snapshot()).decisions[0].status).toBe("expired");
  });
  it("returns incremental events without replaying old sequences", async () => {
    const c = await create();
    await decision(c.id);
    const stub = testEnv.CALLS.getByName(c.id),
      first = await stub.events(0),
      second = await stub.events(first.nextSeq);
    expect(first.events.some((e: any) => e.type === "decision.requested")).toBe(
      true,
    );
    expect(second.events).toEqual([]);
  });
  it("kill switch stops active work and blocks future calls", async () => {
    const c = await create();
    await testEnv.OWNER.getByName("owner").control({
      kill: true,
      terminateActive: true,
    });
    expect((await testEnv.CALLS.getByName(c.id).snapshot()).status).toBe(
      "cancelled",
    );
    expect((await request("/v1/calls", brief())).status).toBe(423);
  });
  it("purges transcript and its event copies after retention", async () => {
    const c = await create(),
      stub = testEnv.CALLS.getByName(c.id);
    await inDO(stub as DurableObjectStub, (i: any) => {
      i.pendingTranscript.push({
        speaker: "business",
        text: "private transcript",
        at: Date.now(),
        startMs: 0,
        endMs: 10,
        delivery: "heard",
      });
      i.flushTranscript();
    });
    await stub.cancel(crypto.randomUUID());
    await inDO(stub as DurableObjectStub, (i: any) => {
      i.s.retainUntil = Date.now() - 1;
      i.save();
    });
    await runDurableObjectAlarm(stub as DurableObjectStub);
    expect((await stub.transcript()).fragments).toEqual([]);
    expect(JSON.stringify(await stub.events(0))).not.toContain(
      "private transcript",
    );
  });
});
describe("paid operations and audio safety", () => {
  it("never exposes private facts in voice instructions or public events", async () => {
    const b = brief();
    b.facts = [
      {
        id: "private",
        text: "secret negotiation ceiling 987654",
        visibility: "private",
      },
    ];
    expect(voiceInstructions(b)).not.toContain("987654");
    const c = await create(b);
    expect(
      JSON.stringify(await testEnv.CALLS.getByName(c.id).events(0)),
    ).not.toContain("987654");
  });
  it("does not count marks returned by clear as delivered audio", () => {
    const sent: any[] = [];
    const p = new Playback(32000, (e) => sent.push(e));
    p.enqueue(to64(new Uint8Array(1280)));
    p.tick();
    const first = sent.find((e) => e.event === "mark").mark.name;
    p.clear();
    p.mark(first);
    expect(p.snapshot().playedBytes).toBe(0);
    p.enqueue(to64(new Uint8Array(640)));
    p.tick();
    p.mark(sent.at(-1).mark.name);
    expect(p.snapshot().playedBytes).toBe(640);
    expect(p.snapshot().clearedBytes).toBe(1280);
  });
  it("bounds output queues and context appends", () => {
    const p = new Playback(32000, () => {});
    expect(() => p.enqueue(to64(new Uint8Array(65000)))).toThrow(
      "audio_backpressure",
    );
    const content = "😀".repeat(4000);
    const chunks = contextChunks(content);
    expect(chunks.join("")).toBe(content);
    for (const c of chunks)
      expect(new TextEncoder().encode(c).length).toBeLessThanOrEqual(480);
  });
  it("keeps large supporting records in the backend without losing essential voice instructions", async () => {
    const b = brief();
    b.facts = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      text: "Supporting detail ".repeat(150),
      visibility: "shareable" as const,
    }));
    const prompt = voiceInstructions(b);
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(16000);
    expect(prompt).toContain("Do not speak acceptance until the backend");
    expect(JSON.parse(modelContext(b, [], 1)).facts).toHaveLength(20);
    b.caller.requiredDisclosures = Array(5).fill("界".repeat(4000));
    const response = await request("/v1/calls/validate", {
      ...b,
      mode: "live",
      facts: [],
    });
    expect(response.status).toBe(422);
    expect(
      (await testEnv.OWNER.getByName("owner").inspect()).activeCalls,
    ).toEqual([]);
  });
  it("replaces cumulative usage instead of summing updates", async () => {
    const c = await create(),
      stub = testEnv.CALLS.getByName(c.id);
    await inDO(stub as DurableObjectStub, (i: any) => {
      i.onVoice({ type: "session.usage.updated", usage: { seconds: 12 } });
      i.onVoice({ type: "session.usage.updated", usage: { seconds: 15 } });
      i.save();
    });
    expect((await stub.snapshot()).usage.liveSeconds).toBe(15);
  });
  it("deduplicates carrier events", async () => {
    const c = await create(),
      stub = testEnv.CALLS.getByName(c.id);
    const e = {
      id: "carrier-event",
      event_type: "call.initiated",
      payload: { call_control_id: "carrier-call" },
    };
    expect(await stub.webhook(e)).toEqual({ accepted: true });
    expect(await stub.webhook(e)).toEqual({ duplicate: true });
    expect(
      (await stub.events(0)).events.filter(
        (e: any) => e.type === "carrier.event",
      ),
    ).toHaveLength(1);
  });
  it("does not resend the same IVR digits after a repeated delegation or runtime eviction", async () => {
    const c = await create(),
      stub = testEnv.CALLS.getByName(c.id);
    const carrier = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ data: { result: "ok" } }));
    await inDO(stub, async (instance) => {
      instance.s.telnyxId = "synthetic-carrier";
      instance.s.brief.mode = "live";
      instance.s.brief.ivr = { mode: "assisted" };
      instance.s.status = "active";
      instance.publishIvr("Press 2 for appointments.");
      instance.pendingTranscript.push({
        speaker: "business",
        text: "Press 2 for appointments.",
        at: Date.now(),
        startMs: 0,
        endMs: 1000,
        delivery: "heard",
      });
      instance.flushTranscript();
      await instance.applyReasoning(
        {
          action: "dtmf",
          digits: "2",
          evidenceQuotes: ["Press 2 for appointments."],
        },
        "first-delegation",
      );
      await instance.applyReasoning(
        {
          action: "dtmf",
          digits: "2",
          evidenceQuotes: ["Press 2 for appointments."],
        },
        "repeated-delegation",
      );
    });
    await evictDurableObject(stub);
    await inDO(stub, async (instance) => {
      await instance.applyReasoning(
        {
          action: "dtmf",
          digits: "2",
          evidenceQuotes: ["Press 2 for appointments."],
        },
        "after-restart",
      );
    });
    expect(carrier).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(carrier.mock.calls[0][1]?.body)).digits).toBe("2");
  });
  it("rejects a model attempt to authorize unapproved terms", async () => {
    const c = await create(),
      stub = testEnv.CALLS.getByName(c.id);
    await inDO(stub as DurableObjectStub, async (i: any) => {
      await i.applyReasoning(
        {
          action: "commit",
          commitmentId: "invented",
          terms: [{ key: "price", value: "999" }],
          evidenceQuotes: ["invented quote"],
        },
        "delegation",
      );
    });
    expect((await stub.snapshot()).operations).toEqual([]);
    expect((await stub.snapshot()).decisions).toHaveLength(1);
  });
  it("binds media tokens to a call, nonce and deadline", async () => {
    const token = await mediaToken(env, "call-a", "nonce", Date.now() + 60000);
    expect(await verifyMedia(env, "call-a", "nonce", token)).toBe(true);
    expect(await verifyMedia(env, "call-b", "nonce", token)).toBe(false);
    expect(await verifyMedia(env, "call-a", "different", token)).toBe(false);
  });
  it("verifies signed webhooks and rejects replayed timestamps", async () => {
    const keys = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const pub = to64(
      new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
    );
    const body = '{"data":{}}',
      ts = String(Math.floor(Date.now() / 1000));
    const signature = to64(
      new Uint8Array(
        await crypto.subtle.sign(
          "Ed25519",
          keys.privateKey,
          new TextEncoder().encode(`${ts}|${body}`),
        ),
      ),
    );
    const req = new Request("https://example.com", {
      headers: {
        "telnyx-timestamp": ts,
        "telnyx-signature-ed25519": signature,
      },
    });
    expect(
      await verifyTelnyx(req, body, { ...env, TELNYX_PUBLIC_KEY: pub }),
    ).toBe(true);
    expect(
      await verifyTelnyx(req, body + " ", { ...env, TELNYX_PUBLIC_KEY: pub }),
    ).toBe(false);
  });
});

describe("reservation and restart invariants", () => {
  it("carries a boundary-spanning call into the new budget period", async () => {
    const owner = testEnv.OWNER.getByName("owner");
    const now = new Date(),
      month = now.toISOString().slice(0, 7),
      day = now.toISOString().slice(0, 10);
    await inDO(owner, (instance) => {
      instance.db.put("call:boundary", {
        id: "boundary",
        principalId: "owner",
        status: "completed",
        mode: "live",
        createdAt: now.getTime() - 3600000,
        month: "2026-01",
        day: "2026-01-31",
        reserved: 0,
        charged: 4900,
        minutes: 45,
        settled: true,
        final: false,
      });
    });
    await owner.settle("boundary", 4900, 45, false, "completed", now.getTime());
    const status = await owner.inspect();
    expect(status.spentCents).toBe(4900);
    expect(status.finalizingCalls).toContain("boundary");
    const entry = (await owner.list(ownerPrincipal))[0];
    expect(entry.billingMonths).toContain(month);
    expect(entry.usageDays).toContain(day);
    expect((await request("/v1/calls", brief())).status).toBe(402);
  });
  it("blocks monthly overspend before dialing", async () => {
    const owner = testEnv.OWNER.getByName("owner");
    await inDO(owner, (i: any) => {
      i.db.put("call:prior", {
        id: "prior",
        principalId: "owner",
        status: "completed",
        mode: "live",
        createdAt: Date.now(),
        month: new Date().toISOString().slice(0, 7),
        day: "earlier-day",
        reserved: 0,
        charged: 5001,
        minutes: 0,
        settled: true,
        final: true,
      });
    });
    expect((await request("/v1/calls", brief())).status).toBe(402);
  });
  it("holds provisional costs until actual receipts replace them", async () => {
    const c = await create(),
      stub = testEnv.CALLS.getByName(c.id),
      owner = testEnv.OWNER.getByName("owner");
    await inDO(owner, (i: any) => {
      const e = i.db.get("call:" + c.id);
      e.reserved = 300;
      i.db.put("call:" + c.id, e);
    });
    await owner.settle(c.id, 30, 2, false, "completed");
    await owner.settle(c.id, 31, 2, false, "completed");
    expect((await owner.inspect()).spentCents).toBe(300);
    await owner.reconcile(c.id, 32);
    expect((await owner.inspect()).spentCents).toBe(32);
    await stub.cancel(crypto.randomUUID());
  });
  it("retains concurrency during an unknown dial outcome and bounds recovery alarms", async () => {
    const c = await create(),
      stub = testEnv.CALLS.getByName(c.id);
    await inDO(stub, (i: any) => {
      i.s.brief.mode = "live";
      i.s.status = "dialing";
      i.s.operations = [
        {
          id: c.id,
          kind: "dial",
          status: "uncertain",
          revision: 1,
          at: Date.now(),
        },
      ];
      i.s.maxEndAt = Date.now() - 121000;
      i.save();
    });
    await stub.stop("uncertain", "Ambiguous carrier timeout");
    await inDO(stub, (i: any) => {
      i.s.nextRecoveryAt = Date.now() - 1;
      i.save();
    });
    await runDurableObjectAlarm(stub);
    expect((await stub.snapshot()).status).toBe("ending");
    expect((await request("/v1/calls", brief())).status).toBe(409);
    const alarm = await inDO(stub, (_i: any, state: DurableObjectState) =>
      state.storage.getAlarm(),
    );
    expect(alarm).toBeNull();
  });
  it("replays an answer receipt across eviction without applying it twice", async () => {
    const c = await create(),
      d = await decision(c.id),
      stub = testEnv.CALLS.getByName(c.id),
      key = crypto.randomUUID(),
      a = { decisionId: d.id, expectedRevision: 1, answer: "Morning" };
    await request(`/v1/calls/${c.id}/answers`, a, undefined, key);
    await evictDurableObject(stub);
    expect(
      (await request(`/v1/calls/${c.id}/answers`, a, undefined, key)).status,
    ).toBe(200);
    expect((await stub.snapshot()).revision).toBe(2);
  });
  it("cannot expand the original credential authority through a live answer", async () => {
    const agent = await testEnv.OWNER.getByName("owner").issue({
      name: "information-only",
      scopes: ["calls:create", "calls:read", "calls:answer"],
    });
    const c = await create(brief(), agent.token),
      d = await decision(c.id);
    const r = await request(
      `/v1/calls/${c.id}/answers`,
      {
        decisionId: d.id,
        expectedRevision: 1,
        answer: "Morning",
        authorization: {
          id: "buy",
          description: "Purchase",
          terms: { price: "100" },
          maxAmountCents: 100,
        },
      },
      agent.token,
    );
    expect(r.status).toBe(403);
    expect((await testEnv.CALLS.getByName(c.id).snapshot()).revision).toBe(1);
  });
});

describe("startup buffering and administrative retries", () => {
  it("keeps earlier reference numbers despite hundreds of transcript deltas", () => {
    const fragments = Array.from({ length: 200 }, (_, i) => ({
      speaker: "business" as const,
      text: i === 0 ? "Reference A735. " : "word ",
      startMs: i * 200,
      endMs: (i + 1) * 200,
      at: i * 200,
      delivery: "heard" as const,
    }));
    const context = JSON.parse(modelContext(brief(), fragments, 1));
    expect(context.transcript).toHaveLength(1);
    expect(context.transcript[0].text).toContain("Reference A735.");
    expect(context.transcriptTruncated).toBe(false);
    const bounded = JSON.parse(modelContext(brief(), fragments, 1, [], 100));
    expect(bounded.transcript[0].text.length).toBe(100);
    expect(bounded.transcriptTruncated).toBe(true);
  });
  it("removes startup audio delay before the continuous live stream", () => {
    const frames = new AudioFrames(640);
    for (let i = 0; i < 80; i++)
      frames.enqueue(to64(new Uint8Array(640).fill(i)), true);
    expect(frames.snapshot().queuedMs).toBe(1600);
    frames.startLive();
    expect(frames.snapshot().queuedMs).toBe(60);
    expect(frames.next()).toBe(to64(new Uint8Array(640).fill(77)));
    expect(frames.next()).toBe(to64(new Uint8Array(640).fill(78)));
    expect(frames.next()).toBe(to64(new Uint8Array(640).fill(79)));
    expect(frames.snapshot().queuedMs).toBe(0);
  });
  it("bounds startup pre-roll while retaining strict steady-state backpressure", () => {
    const frames = new AudioFrames(640);
    const sample = to64(new Uint8Array(640));
    for (let i = 0; i < 160; i++) frames.enqueue(sample, true);
    expect(frames.next()).toBe(sample);
    const steady = new AudioFrames(640);
    for (let i = 0; i < 100; i++) steady.enqueue(sample);
    expect(() => steady.enqueue(sample)).toThrow("input_audio_backpressure");
  });
  it("does not let an old control retry undo a newer pause", async () => {
    const key = crypto.randomUUID();
    expect(
      (await request("/v1/admin/control", { kill: false }, undefined, key))
        .status,
    ).toBe(200);
    await request("/v1/admin/control", { kill: true });
    await request("/v1/admin/control", { kill: false }, undefined, key);
    expect((await testEnv.OWNER.getByName("owner").inspect()).kill).toBe(true);
    expect(
      (await request("/v1/admin/control", { kill: true }, undefined, key))
        .status,
    ).toBe(409);
  });
});

it("calculates decimal prices exactly and rejects unbounded or invalid operands", () => {
  expect(calculate("add", "0.1", "0.2")).toBe("0.3");
  expect(calculate("multiply", "19.99", "3")).toBe("59.97");
  expect(calculate("divide", "-2", "3")).toBe("-0.666667");
  expect(() => calculate("divide", "1", "0")).toThrow("division_by_zero");
  expect(() => calculate("add", "Infinity", "1")).toThrow("invalid_operand");
});

it("disarms the connection deadline after a successful WebSocket upgrade", async () => {
  vi.useFakeTimers();
  try {
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      signal = init?.signal ?? undefined;
      return { status: 101, webSocket: { accept() {} } } as unknown as Response;
    });
    await connectLive({ OPENAI_API_KEY: "test" } as Env);
    await vi.advanceTimersByTimeAsync(9000);
    expect(signal?.aborted).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("requires explicit first-person authority while defaulting to assistant mode", async () => {
  const b = brief();
  expect(b.caller.persona).toBe("assistant");
  const agent = await testEnv.OWNER.getByName("owner").issue({
    name: "Muse",
    scopes: ["calls:create"],
  });
  const firstPerson = { ...b, caller: { ...b.caller, persona: "first_person" } };
  expect(
    (await request("/v1/calls/validate", firstPerson, agent.token)).status,
  ).toBe(403);
  expect((await request("/v1/calls/validate", firstPerson)).status).toBe(200);
});
it("bounds chunked bodies before buffering the entire request", async () => {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(40000));
      c.enqueue(new Uint8Array(40000));
      c.close();
    },
  });
  const req = new Request("https://example.test", {
    method: "POST",
    body: stream,
  });
  await expect(readBody(req)).rejects.toThrow("body_too_large");
});

it("does not confuse an automated IVR greeting with voicemail", async () => {
  const c = await create();
  const stub = testEnv.CALLS.getByName(c.id);
  await inDO(stub, async (instance) => {
    await instance.applyWebhook({
      event_type: "call.machine.detection.ended",
      payload: { result: "machine" },
    });
    expect(instance.s.status).toBe("active");
  });
});

it("ends on an explicit voicemail invitation without waiting for model delegation", async () => {
  const c = await create();
  await inDO(testEnv.CALLS.getByName(c.id), async (instance) => {
    for (const delta of [
      "Hey, the person you're trying to reach isn't available right now, ",
      "but you can leave a message after the ",
      "beep",
    ]) {
      instance.onVoice({ type: "session.input_transcript.delta", delta });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.s.status).toBe("completed");
    expect(instance.s.modelRequests).toBe(0);
    expect(
      (await instance.events(0)).events.filter(
        (e: any) => e.type === "voicemail.explicit_invitation",
      ),
    ).toHaveLength(1);
  });
});

it("does not reopen a finished call when voice closure races with carrier settlement", async () => {
  const c = await create();
  await inDO(testEnv.CALLS.getByName(c.id), async (instance) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settle = vi
      .spyOn(instance, "settle")
      .mockImplementation(() => pending);
    const first = instance.finish("completed", "Carrier stopped");
    const second = instance.stop("uncertain", "Voice socket closed");
    const third = instance.finish("failed", "Repeated carrier notification");
    expect(instance.s.status).toBe("completed");
    expect(instance.s.result.summary).toContain("Carrier stopped");
    expect(
      (await instance.events(0)).events.filter(
        (e: any) => e.type === "call.ended",
      ),
    ).toHaveLength(1);
    release();
    await Promise.all([first, second, third]);
    settle.mockRestore();
  });
});

it("handles an explicit recipient hangup request without waiting for a voice delegation", async () => {
  for (const phrase of [
    "End the call",
    "Please hang up now.",
    "Could you end this call?",
  ])
    expect(recipientRequestsHangup(phrase)).toBe(true);
  for (const phrase of [
    "Don't hang up.",
    "To end the call press 2.",
    "Should I end the call?",
    "End the call tomorrow.",
  ])
    expect(recipientRequestsHangup(phrase)).toBe(false);
  const c = await create();
  await inDO(testEnv.CALLS.getByName(c.id), async (instance) => {
    const close = vi
      .spyOn(instance, "gracefulHangup")
      .mockResolvedValue(undefined);
    instance.onVoice({
      type: "session.input_transcript.delta",
      delta: "End the ",
    });
    instance.onVoice({
      type: "session.input_transcript.delta",
      delta: "call.",
    });
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(close).toHaveBeenCalledExactlyOnceWith(false, 1500);
    expect(instance.s.modelRequests).toBe(0);
  });
});

it("closes after a finished farewell but cancels it when the recipient resumes speaking", async () => {
  expect(assistantFarewell("All set. Thanks for testing. Talk soon!")).toBe(
    true,
  );
  expect(assistantFarewell("Should I say goodbye?")).toBe(false);
  const c = await create();
  await inDO(testEnv.CALLS.getByName(c.id), async (instance) => {
    const close = vi
      .spyOn(instance, "gracefulHangup")
      .mockResolvedValue(undefined);
    instance.onVoice({
      type: "session.output_transcript.delta",
      delta: "All set. Thanks for testing.",
    });
    instance.onVoice({
      type: "session.input_transcript.delta",
      delta: "Wait, one more thing.",
    });
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(close).not.toHaveBeenCalled();
    instance.onVoice({
      type: "session.output_transcript.delta",
      delta: "Goodbye!",
    });
    await new Promise((resolve) => setTimeout(resolve, 850));
    expect(close).toHaveBeenCalledExactlyOnceWith(true, 500);
  });
});

it("preserves authorized voicemail messages and ignores IVR or negated message instructions", async () => {
  for (const text of [
    "Please say your name and why you're calling.",
    "To leave a message after the beep, press 2.",
    "Please do not leave a message after the beep.",
    "Welcome to our business. Please hold.",
  ]) {
    expect(explicitVoicemailInvitation(text)).toBe(false);
  }
  const c = await create({
    ...brief(),
    voicemail: { action: "leave_message", message: "Please call me back." },
  });
  await inDO(testEnv.CALLS.getByName(c.id), async (instance) => {
    instance.onVoice({
      type: "session.input_transcript.delta",
      delta: "Please leave a message after the beep.",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(instance.s.status).toBe("active");
  });
});

it("allows farewell audio to finish and defers closing for renewed conversation", async () => {
  const c = await create();
  await inDO(testEnv.CALLS.getByName(c.id), async (instance) => {
    instance.lastAssistantTextAt = Date.now();
    const first = instance.gracefulHangup();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(instance.s.status).toBe("active");
    instance.s.conversationRevision =
      (instance.s.conversationRevision ?? 0) + 1;
    await first;
    expect(instance.s.status).toBe("active");
    instance.lastAssistantTextAt = Date.now();
    const started = Date.now();
    instance.playback = {
      checkpoint: () => ({ generation: 0, throughBytes: 640 }),
      acknowledged: () => Date.now() - started >= 1600,
      clear() {},
      snapshot: () => ({}),
    };
    await instance.gracefulHangup();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1600);
    expect(instance.s.status).toBe("completed");
  });
});

it("waits for a playback checkpoint without waiting for later continuous audio", () => {
  const sent: any[] = [];
  const playback = new Playback(32000, (event) => sent.push(event));
  playback.enqueue(to64(new Uint8Array(1280)));
  const checkpoint = playback.checkpoint();
  playback.tick();
  playback.mark(sent[1].mark.name);
  expect(playback.acknowledged(checkpoint)).toBe(false);
  playback.tick();
  playback.enqueue(to64(new Uint8Array(640)));
  playback.tick();
  expect(playback.acknowledged(checkpoint)).toBe(false);
  playback.mark(sent[3].mark.name);
  expect(playback.acknowledged(checkpoint)).toBe(true);
  expect(playback.snapshot().pendingMarks).toBe(1);
  playback.clear();
  expect(playback.acknowledged(checkpoint)).toBe(false);
});

describe("agent supervision transport", () => {
  it("does not report completion while the ended call's summary is pending", async () => {
    const c = await create(),
      stub = testEnv.CALLS.getByName(c.id);
    await stub.cancel(crypto.randomUUID());
    await inDO(stub, (instance) => {
      instance.s.result.finalized = false;
      instance.save();
    });
    expect((await stub.events(0)).terminal).toBe(false);
    const client = new CallingClient("https://example.com", (req) => {
      const headers = new Headers(req.headers);
      headers.set("authorization", "Bearer test-owner-key");
      return SELF.fetch(new Request(req, { headers }));
    });
    const result = await client.supervise(c.id, { timeoutMs: 100 });
    expect(result.terminal).toBe(false);
    expect(result.status).toBe("supervision_window_elapsed");
  });
  it("finalizes an interrupted summary as uncertain after runtime eviction", async () => {
    const c = await create(),
      stub = testEnv.CALLS.getByName(c.id);
    await stub.cancel(crypto.randomUUID());
    await inDO(stub, (instance) => {
      instance.s.result.finalized = false;
      instance.s.endedAt = Date.now() - 21000;
      instance.s.operations.push({
        id: "summary-interrupted",
        kind: "summary",
        status: "intent",
        revision: 1,
        at: Date.now() - 21000,
      });
      instance.save();
    });
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    const state = await stub.snapshot();
    expect(state.result.finalized).toBe(true);
    expect(state.result.outcome).toBe("uncertain");
    expect(
      state.operations.find((o: any) => o.id === "summary-interrupted").status,
    ).toBe("uncertain");
    expect((await stub.events(0)).terminal).toBe(true);
  });
  it("recovers a pending decision even after its event cursor was consumed", async () => {
    const c = await create(),
      d = await decision(c.id);
    const client = new CallingClient("https://example.com", (req) => {
      const headers = new Headers(req.headers);
      headers.set("authorization", "Bearer test-owner-key");
      return SELF.fetch(new Request(req, { headers }));
    });
    const batch = await client.events(c.id);
    const resumed = await client.supervise(c.id, {
      since: batch.nextSeq,
      timeoutMs: 1000,
    });
    expect(resumed.decisions[0].id).toBe(d.id);
    expect(resumed.terminal).toBe(false);
  });
  it("includes stalled HTTP requests in the total supervision deadline", async () => {
    let aborted = 0;
    const client = new CallingClient(
      "https://example.com",
      (req) =>
        new Promise((_resolve, reject) => {
          req.signal.addEventListener(
            "abort",
            () => {
              aborted++;
              reject(req.signal.reason);
            },
            { once: true },
          );
        }),
    );
    const started = Date.now();
    const result = await client.supervise(crypto.randomUUID(), {
      timeoutMs: 60,
    });
    expect(result.status).toBe("supervision_window_elapsed");
    expect(Date.now() - started).toBeLessThan(500);
    expect(aborted).toBe(2);
  });
  it("preserves explicit caller cancellation instead of returning a window timeout", async () => {
    const controller = new AbortController();
    const client = new CallingClient(
      "https://example.com",
      (req) =>
        new Promise((_resolve, reject) => {
          req.signal.addEventListener(
            "abort",
            () => reject(req.signal.reason),
            { once: true },
          );
        }),
    );
    const promise = client.supervise(crypto.randomUUID(), {
      signal: controller.signal,
    });
    controller.abort(new Error("Caller stopped supervising"));
    await expect(promise).rejects.toThrow("Caller stopped supervising");
  });
});

describe("carrier recordings", () => {
  it("defaults new briefs to recording and preserves voice behavior", () => {
    const b = { ...brief(), mode: "live" as const };
    expect(b.recording).toBe("on");
    expect(voiceInstructions(b)).toBe(
      voiceInstructions({ ...b, recording: "off" }),
    );
    expect(
      reservation({ ...b, limits: { ...b.limits, maxMinutes: 10 } }) -
        reservation({
          ...b,
          recording: "off",
          limits: { ...b.limits, maxMinutes: 10 },
        }),
    ).toBe(2);
  });
  it("requests bounded dual-channel MP3 without adding beeps, speech or paid transcription", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        data: { call_control_id: "test", recording_id: "recording" },
      }),
    );
    const state: any = {
      id: crypto.randomUUID(),
      mediaNonce: "test",
      brief: { ...brief(), mode: "live" },
    };
    await dial(testEnv, state);
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      record: "record-from-answer",
      record_channels: "dual",
      record_format: "mp3",
      record_track: "both",
      record_max_length: 900,
      record_timeout_secs: 0,
    });
    expect(body.play_beep).toBeUndefined();
    expect(body.transcription).toBeUndefined();
    expect(body.tts).toBeUndefined();
    state.brief.recording = "off";
    await dial(testEnv, state);
    expect(
      JSON.parse(String(fetch.mock.calls[1][1]?.body)).record,
    ).toBeUndefined();
  });
  it("keeps simulation recording off and processes a late saved webhook without storing signed URLs", async () => {
    const c = await create();
    const stub = testEnv.CALLS.getByName(c.id);
    expect((await stub.snapshot()).recording.status).toBe("off");
    await inDO(stub, async (instance: any) => {
      instance.s.recording = { status: "requested" };
      instance.s.status = "completed";
      instance.s.ownerSettled = true;
      instance.s.brief.mode = "live";
      instance.s.telnyxId = "test-control";
      instance.s.endedAt = Date.now();
      instance.save();
      const event = {
        id: "recording-event",
        event_type: "call.recording.saved",
        payload: {
          call_control_id: "test-control",
          recording_id: "test-recording",
          recording_started_at: new Date(instance.s.createdAt).toISOString(),
          recording_ended_at: new Date().toISOString(),
          recording_urls: { mp3: "https://secret.example/signed" },
        },
      };
      await instance.webhook(event);
      const queued = instance.db.get("webhook:recording-event");
      if (queued)
        expect(JSON.stringify(queued)).not.toContain("secret.example");
      await instance.applyQueuedWebhook("webhook:recording-event");
      expect(instance.s.recording.status).toBe("saved");
      expect(instance.s.recording.id).toBe("test-recording");
      expect(await instance.webhook(event)).toEqual({ duplicate: true });
    });
  });
  it("reserves recording costs but does not add them to legacy calls or reconciled bills", () => {
    const now = Date.now(),
      state: any = {
        brief: { ...brief(), mode: "live" },
        liveSeconds: 600,
        liveFinal: true,
        startedAt: now - 600000,
        endedAt: now,
        backendCents: 0,
        backendReservedCents: 0,
        carrierCostCents: 15,
      };
    expect(estimatedCost(state)).toBe(65);
    state.recording = { status: "requested", startedAt: now - 600000 };
    expect(estimatedCost(state)).toBe(67);
    state.reconciledCents = 5;
    expect(estimatedCost(state)).toBe(5);
  });
});

describe("IVR navigation", () => {
  const menu = (prompt: string) => ({
    id: crypto.randomUUID(),
    prompt,
    ...parseIvr(prompt)!,
    revision: 1,
    observedAt: Date.now(),
    expiresAt: Date.now() + 30000,
    status: "pending" as const,
  });
  it("parses the actual stalled menu and selects other inquiries without a model call", () => {
    const m = menu(
      "For guarantor account balance inquiry, and to make a payment using our secure automated phone payment system, press one. For other inquiries, please press two",
    );
    expect(m.options.map((o) => o.digits)).toEqual(["1", "2"]);
    expect(
      selectIvrOption(m, {
        ...brief(),
        objective: "Request a self-pay discount review and hold",
      }),
    ).toBe("2");
    expect(() => validateKeypad(m, "1", brief())).toThrow(/commitment/);
    expect(() => validateKeypad(m, "2", brief())).not.toThrow();
  });
  it("supports key-first menus, star/hash and ambiguous choices without guessing", () => {
    const m = menu(
      "Press one for sales. Press 2 for appointments. Press star to repeat. Press pound to return.",
    );
    expect(m.options.map((o) => o.digits)).toEqual(["1", "2", "*", "#"]);
    expect(
      selectIvrOption(m, {
        ...brief(),
        ivr: { mode: "auto", goal: "appointments" },
      }),
    ).toBe("2");
    expect(
      selectIvrOption(m, { ...brief(), objective: "Ask a question" }),
    ).toBeUndefined();
    expect(
      parseIvr("Thank you for holding. Someone will be with you shortly."),
    ).toBeUndefined();
    expect(parseIvr("The reference number is 12345.")).toBeUndefined();
  });
  it("protects numeric entry, terminators and commitment keys", () => {
    const b = {
      ...brief(),
      facts: [
        { id: "ref", text: "6204", visibility: "shareable" as const },
        { id: "secret", text: "9999", visibility: "private" as const },
      ],
    };
    const m = menu("Enter your reference number then press pound.");
    expect(m.kind).toBe("input");
    expect(() => validateKeypad(m, "6204#", b, "ref")).not.toThrow();
    for (const [digits, id] of [
      ["9999#", "secret"],
      ["6205#", "ref"],
      ["1234#", undefined],
    ])
      expect(() => validateKeypad(m, digits!, b, id)).toThrow();
    expect(() =>
      validateKeypad(menu("Enter your reference number."), "6204#", b, "ref"),
    ).toThrow(/terminator/);
    expect(() =>
      validateKeypad(menu("To confirm your purchase, press one."), "1", b),
    ).toThrow(/commitment/);
    expect(() =>
      validateKeypad(menu("For appointments, press two."), "9", b),
    ).toThrow(/offer/);
  });
  it("runs the public two-stage synthetic API with replay receipts and no paid fetch", async () => {
    const b = brief();
    b.simulation = {
      scenario: "ivr",
      durationSeconds: 120,
      questionAfterSeconds: 90,
    };
    b.ivr = { mode: "assisted" };
    b.facts = [{ id: "ref", text: "6204", visibility: "shareable" }];
    const c = await create(b);
    const stub = testEnv.CALLS.getByName(c.id);
    await runDurableObjectAlarm(stub);
    const first = await stub.snapshot();
    expect(first.ivr.kind).toBe("menu");
    const client = new CallingClient("https://example.com", (req) => {
      const h = new Headers(req.headers);
      h.set("authorization", "Bearer test-owner-key");
      return SELF.fetch(new Request(req, { headers: h }));
    });
    expect((await client.supervise(c.id, { timeoutMs: 1000 })).ivr?.id).toBe(
      first.ivr.id,
    );
    const paid = vi.spyOn(globalThis, "fetch");
    const body = {
      expectedRevision: first.revision,
      menuId: first.ivr.id,
      digits: "2",
    };
    const r = await request(
      `/v1/calls/${c.id}/dtmf`,
      body,
      "test-owner-key",
      "ivr-first-key",
    );
    expect(r.status).toBe(200);
    const a: any = await r.json();
    expect(a.simulated).toBe(true);
    const replay = await request(
      `/v1/calls/${c.id}/dtmf`,
      body,
      "test-owner-key",
      "ivr-first-key",
    );
    expect(await replay.json()).toEqual(a);
    expect(
      (
        await request(
          `/v1/calls/${c.id}/dtmf`,
          { ...body, digits: "1" },
          "test-owner-key",
          "ivr-first-key",
        )
      ).status,
    ).toBe(409);
    expect((await request(`/v1/calls/${c.id}/dtmf`, body)).status).toBe(409);
    const second = await stub.snapshot();
    expect(second.ivr.kind).toBe("input");
    const r2 = await request(`/v1/calls/${c.id}/dtmf`, {
      expectedRevision: second.revision,
      menuId: second.ivr.id,
      digits: "6204#",
      factId: "ref",
    });
    expect(r2.status).toBe(200);
    const end = await stub.snapshot();
    expect(end.status).toBe("completed");
    expect(end.result.outcome).toBe("completed");
    expect(end.usage.costCents).toBe(0);
    expect(
      paid.mock.calls.filter(([url]) => /telnyx|openai/.test(String(url))),
    ).toHaveLength(0);
  });
  it("serializes carrier requests and refuses stale keys, private digits and uncertain retries", async () => {
    const c = await create();
    const stub = testEnv.CALLS.getByName(c.id);
    await inDO(stub, (i) => {
      i.s.status = "active";
      i.s.brief.mode = "live";
      i.s.brief.ivr = { mode: "assisted" };
      i.s.telnyxId = "synthetic";
      i.publishIvr("Press 2 for appointments.");
    });

    const first = await stub.snapshot();
    const paid = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return Response.json({ data: { result: "ok" } });
    });
    const body = { expectedRevision: 1, menuId: first.ivr.id, digits: "2" };
    await inDO(stub, async (i) => {
      const results = await Promise.allSettled([
        i.keypad(body, "one-send"),
        i.keypad(body, "one-send"),
        i.keypad(body, "different-key"),
      ]);

      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("fulfilled");
      expect(results[2].status).toBe("rejected");
    });

    await inDO(stub, async (_i, ctx) => {
      await ctx.storage.deleteAlarm();
    });
    await evictDurableObject(stub);

    expect((await stub.keypad(body, "one-send")).status).toBe("succeeded");
    expect(paid).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(paid.mock.calls[0][1]?.body));
    expect(payload.digits).toBe("2");
    expect(payload.duration_millis).toBe(200);
    await inDO(stub, (i) => i.publishIvr("For billing, press three."));

    const next = await stub.snapshot();
    paid.mockRejectedValue(new Error("timeout"));
    const failed = await stub.keypad(
      { expectedRevision: 1, menuId: next.ivr.id, digits: "3" },
      "timeout-key",
    );

    expect(failed.status).toBe("uncertain");

    await inDO(stub, async (_i, ctx) => {
      await ctx.storage.deleteAlarm();
    });
    await evictDurableObject(stub);

    expect(
      (
        await stub.keypad(
          { expectedRevision: 1, menuId: next.ivr.id, digits: "3" },
          "timeout-key",
        )
      ).status,
    ).toBe("uncertain");
    expect(paid).toHaveBeenCalledTimes(2);
  }, 25000);
  it("rejects expired, revised, disabled and revoked keypad requests", async () => {
    const c = await create();
    const stub = testEnv.CALLS.getByName(c.id);
    await inDO(stub, (i) => {
      i.s.status = "active";
      i.s.brief.ivr = { mode: "assisted" };
      i.publishIvr("For billing, press two.");
      i.s.ivr.expiresAt = Date.now() - 1;
      i.save();
    });
    let m = (await stub.snapshot()).ivr;
    await inDO(stub, async (i) => {
      await expect(
        i.keypad({ expectedRevision: 1, menuId: m.id, digits: "2" }, "expired"),
      ).rejects.toThrow(/menu/);
    });
    await inDO(stub, (i) => {
      i.s.ivr.expiresAt = Date.now() + 30000;
      i.s.revision = 2;
      i.save();
    });
    await inDO(stub, async (i) => {
      await expect(
        i.keypad(
          { expectedRevision: 1, menuId: m.id, digits: "2" },
          "stale-task",
        ),
      ).rejects.toThrow(/menu/);
    });
    await inDO(stub, (i) => {
      i.s.revision = 1;
      i.s.brief.ivr = { mode: "off" };
      i.save();
    });
    await inDO(stub, async (i) => {
      await expect(
        i.keypad(
          { expectedRevision: 1, menuId: m.id, digits: "2" },
          "disabled",
        ),
      ).rejects.toThrow(/disabled/);
    });
    await request("/v1/admin/control", { kill: true });
    await inDO(stub, async (i) => {
      await expect(
        i.keypad({ expectedRevision: 1, menuId: m.id, digits: "2" }, "killed"),
      ).rejects.toThrow(/stopped/);
    });
  });
  it("uses observed menus despite transcript punctuation differences and does not expose digits in events", async () => {
    const c = await create();
    const stub = testEnv.CALLS.getByName(c.id);
    await inDO(stub, async (i) => {
      i.s.status = "active";
      i.s.brief.ivr = { mode: "assisted" };
      i.publishIvr("For appointments please press two");
      i.requestDecision("Which menu option?", "IVR", []);
      await i.applyReasoning(
        {
          action: "dtmf",
          digits: "2",
          factIds: [],
          evidenceQuotes: ["For appointments, please press two."],
        },
        "model",
      );
    });
    const snap = await stub.snapshot();
    expect(snap.ivr.status).toBe("sent");
    expect(
      snap.decisions.filter((d: any) => d.status === "pending"),
    ).toHaveLength(0);
    const es = (await stub.events(0)).events.filter((e: any) =>
      e.type.startsWith("ivr.keypad"),
    );
    expect(es.length).toBe(2);
    expect(es.every((e: any) => !("digits" in e.data))).toBe(true);
  });
  it("expires a silent supervisor menu without an unrelated simulation question", async () => {
    const b = brief();
    b.simulation = {
      scenario: "ivr",
      durationSeconds: 120,
      questionAfterSeconds: 5,
    };
    const c = await create(b);
    const stub = testEnv.CALLS.getByName(c.id);
    await runDurableObjectAlarm(stub);
    await inDO(stub, (i) => {
      i.s.ivr.expiresAt = Date.now() - 1;
      i.s.createdAt = Date.now() - 6000;
      i.save();
    });
    await runDurableObjectAlarm(stub);
    const snap = await stub.snapshot();
    expect(snap.ivr.status).toBe("expired");
    expect(snap.decisions).toHaveLength(1);
    expect(snap.decisions[0].question).toMatch(/menu timed out/);
    await stub.answer(
      {
        decisionId: snap.decisions[0].id,
        expectedRevision: snap.revision,
        answer: "Acknowledged; wait for another menu",
      },
      "ack-only",
    );
    await inDO(stub, (i) => {
      i.s.maxEndAt = Date.now() - 1;
      i.save();
    });
    await runDurableObjectAlarm(stub);
    expect((await stub.snapshot()).result.outcome).toBe("unsuccessful");
  });
});

it("hears a fragmented IVR and sends a real carrier command without a voice-model delegation", async () => {
  const c = await create(),
    stub = testEnv.CALLS.getByName(c.id);
  const carrier = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ data: { result: "ok" } }));
  await inDO(stub, async (i) => {
    i.s.status = "active";
    i.s.brief.mode = "live";
    i.s.brief.ivr = { mode: "auto", goal: "appointments" };
    i.s.telnyxId = "synthetic-carrier";
    i.onVoice({
      type: "session.input_transcript.delta",
      delta: "For sales, press one. For appointments, ",
    });
    i.onVoice({ type: "session.input_transcript.delta", delta: "press two." });
    await vi.waitFor(() => expect(i.s.ivr?.status).toBe("sent"), {
      timeout: 3000,
    });
    expect(i.s.operations.filter((o: any) => o.kind === "dtmf")).toHaveLength(
      1,
    );
    expect(i.s.modelRequests).toBe(0);
    i.onVoice({
      type: "session.input_transcript.delta",
      delta:
        "For new appointments, press three. For all other matters, press four.",
    });
    await vi.waitFor(
      () =>
        expect(
          i.s.operations.filter((o: any) => o.kind === "dtmf"),
        ).toHaveLength(2),
      { timeout: 3000 },
    );
    await vi.waitFor(() => expect(i.s.ivr?.status).toBe("sent"), {
      timeout: 1000,
    });
    expect(i.s.ivr.options.map((o: any) => o.digits)).toEqual(["3", "4"]);
  });
  expect(carrier).toHaveBeenCalledTimes(2);
  expect(String(carrier.mock.calls[0][0])).toContain("send_dtmf");
});
it("invalidates a pending menu immediately on recipient corrections and bounds keypad commands", async () => {
  const c = await create(),
    stub = testEnv.CALLS.getByName(c.id);
  await inDO(stub, async (i) => {
    i.s.status = "active";
    i.s.brief.ivr = { mode: "assisted" };
    i.publishIvr("For billing, press two.");
    const old = i.s.ivr.id;
    i.observeIvr("Correction, that option is unavailable.");
    await expect(
      i.keypad({ expectedRevision: 1, menuId: old, digits: "2" }, "correction"),
    ).rejects.toThrow(/menu/);
    clearTimeout(i.ivrTimer);
    i.ivrTimer = undefined;
    i.publishIvr("For a representative, press zero.");
    for (let n = 0; n < 20; n++)
      i.s.operations.push({
        id: String(n),
        kind: "dtmf",
        status: "succeeded",
        revision: 1,
        at: Date.now(),
      });
    await expect(
      i.keypad(
        { expectedRevision: 1, menuId: i.s.ivr.id, digits: "0" },
        "limit-test",
      ),
    ).rejects.toThrow(/20 keypad/);
  });
});
it("recognizes any-key test prompts without allowing commitment prompts", () => {
  expect(
    parseIvr("Please press any key to test your keypad.")?.options.map(
      (o) => o.digits,
    ),
  ).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  expect(parseIvr("Press any key to confirm this purchase.")).toBeUndefined();
});
