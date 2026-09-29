import { z } from "zod";
import {
  CallBriefSchema,
  AnswerSchema,
  ContextSchema,
  CredentialSchema,
  ApiError,
  authorizeBrief,
  requireScope,
  reservation,
} from "./domain";
import {
  authenticate,
  assertOwner,
  digest,
  idempotency,
  liveReady,
  readJson,
  readBody,
  verifyTelnyx,
} from "./security";
import { KeypadSchema } from "./ivr";
import { openapi } from "./openapi";
export { CallController } from "./call";
export { OwnerController } from "./owner";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers });
function method(req: Request, expected: string) {
  if (req.method !== expected)
    throw new ApiError(405, "method_not_allowed", `Use ${expected}`);
}
export default {
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      const url = new URL(req.url),
        path = url.pathname,
        owner = env.OWNER.getByName("owner");
      if (path === "/health")
        return json({
          ok: true,
          version: "0.1.0",
          liveEnabled: liveReady(env),
        });
      if (path === "/openapi.json") return json(openapi(env.PUBLIC_BASE_URL));
      if (path === "/webhooks/telnyx") {
        method(req, "POST");
        const raw = await readBody(req, 131072);
        if (!(await verifyTelnyx(req, raw, env)))
          throw new ApiError(
            401,
            "invalid_signature",
            "Invalid webhook signature",
          );
        const body = JSON.parse(raw),
          e = body.data;
        if (!e?.id || typeof e.event_type !== "string" || !e.payload)
          throw new ApiError(400, "invalid_webhook", "Invalid event envelope");
        let id = "";
        try {
          id = atob(e.payload.client_state ?? "");
        } catch {}
        if (!uuid.test(id)) return json(await owner.controlledHook(e));
        return json(await env.CALLS.getByName(id).webhook(e));
      }
      if (path.startsWith("/media/")) {
        const id = path.slice(7);
        if (!uuid.test(id)) throw new ApiError(404, "not_found", "Not found");
        return env.CALLS.getByName(id).fetch(req);
      }
      if (!path.startsWith("/v1/")) {
        const response = await env.ASSETS.fetch(req);
        const h = new Headers(response.headers);
        h.set(
          "content-security-policy",
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        );
        h.set("referrer-policy", "no-referrer");
        h.set("x-content-type-options", "nosniff");
        return new Response(response.body, {
          status: response.status,
          headers: h,
        });
      }
      if (req.headers.get("origin") && req.headers.get("origin") !== url.origin)
        throw new ApiError(
          403,
          "origin_denied",
          "Cross-origin browser API requests are disabled",
        );
      const p = await authenticate(req, env);
      await owner.throttle(p.id);
      if (path === "/v1/me") {
        method(req, "GET");
        return json({ principal: p, liveReady: liveReady(env) });
      }
      if (path === "/v1/calls/validate") {
        method(req, "POST");
        const b = CallBriefSchema.parse(await readJson(req));
        authorizeBrief(p, b);
        return json({
          valid: reservation(b) <= b.limits.maxCostCents,
          maximumEstimatedCents: reservation(b),
          missingEssentials: [],
          liveReady: liveReady(env),
          warnings: [
            ...(b.mode === "live" && !liveReady(env)
              ? ["Live activation checks are incomplete"]
              : []),
            ...(reservation(b) > b.limits.maxCostCents
              ? ["Increase budget or reduce maximum duration/backend allowance"]
              : []),
            ...(b.missingInformation.length
              ? ["Unresolved facts may require a live decision"]
              : []),
          ],
        });
      }
      if (path === "/v1/calls") {
        if (req.method === "GET") {
          requireScope(p, "calls:read");
          return json({ calls: await owner.list(p) });
        }
        method(req, "POST");
        const key = idempotency(req),
          b = CallBriefSchema.parse(await readJson(req));
        authorizeBrief(p, b);
        const accepted = await owner.create(
          p,
          b,
          key,
          await digest(JSON.stringify(b)),
        );
        const call = await env.CALLS.getByName(accepted.id).initialize(
          accepted.id,
          b,
          p,
        );
        return json(call, accepted.replay ? 200 : 201);
      }
      if (path.startsWith("/v1/admin/")) {
        assertOwner(p);
        if (path === "/v1/admin/status") {
          method(req, "GET");
          return json(await owner.inspect());
        }
        if (path === "/v1/admin/credentials") {
          method(req, "POST");
          const key = idempotency(req);
          return json(
            await owner.issue(CredentialSchema.parse(await readJson(req)), key),
            201,
          );
        }
        const revoke = path.match(
          /^\/v1\/admin\/credentials\/([^/]+)\/revoke$/,
        );
        if (revoke) {
          method(req, "POST");
          const key = idempotency(req);
          return json(await owner.revoke(revoke[1], key));
        }
        const update = path.match(
          /^\/v1\/admin\/credentials\/([0-9a-f-]{36})$/,
        );
        if (update) {
          method(req, "POST");
          return json(
            await owner.updateCredential(
              update[1],
              await readJson(req),
              idempotency(req),
            ),
          );
        }
        if (path === "/v1/admin/control") {
          method(req, "POST");
          const key = idempotency(req);
          return json(
            await owner.control(
              z
                .object({
                  kill: z.boolean().optional(),
                  draining: z.boolean().optional(),
                  terminateActive: z.boolean().optional(),
                })
                .strict()
                .parse(await readJson(req)),
              key,
            ),
          );
        }
        if (path === "/v1/admin/callbacks") {
          method(req, "POST");
          const key = idempotency(req);
          const body = z
            .object({
              id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
              url: z.url().max(2000),
            })
            .strict()
            .parse(await readJson(req));
          return json(await owner.registerCallback(body.id, body.url, key));
        }
        throw new ApiError(404, "not_found", "Unknown administrative endpoint");
      }
      const match = path.match(
        /^\/v1\/calls\/([^/]+)(?:\/(events|answers|context|dtmf|cancel|transcript|reconcile))?$/,
      );
      if (!match || !uuid.test(match[1]))
        throw new ApiError(404, "not_found", "Endpoint not found");
      const call = env.CALLS.getByName(match[1]);
      await call.access(p);
      const action = match[2];
      if (!action) {
        if (req.method === "DELETE") {
          assertOwner(p);
          idempotency(req);
          return json(await call.erase());
        }
        method(req, "GET");
        requireScope(p, "calls:read");
        return json(await call.snapshot());
      }
      if (action === "events") {
        method(req, "GET");
        requireScope(p, "calls:read");
        const since = Number(
          url.searchParams.get("since_seq") ??
            req.headers.get("last-event-id") ??
            0,
        );
        if (!Number.isSafeInteger(since) || since < 0)
          throw new ApiError(
            400,
            "invalid_cursor",
            "Use a nonnegative integer sequence",
          );
        if (req.headers.get("accept")?.includes("text/event-stream")) {
          let cancelled = false;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              ctx.waitUntil(
                (async () => {
                  let cursor = since;
                  controller.enqueue(
                    new TextEncoder().encode("retry: 2000\n\n"),
                  );
                  try {
                    for (let i = 0; i < 12 && !cancelled; i++) {
                      if (
                        !(await owner.activeCredential(
                          p.id,
                          p.credentialRevision ?? 1,
                        ))
                      )
                        break;
                      const batch = await call.events(
                        cursor,
                        p.owner || p.scopes.includes("transcript:read"),
                      );
                      for (const e of batch.events) {
                        controller.enqueue(
                          new TextEncoder().encode(
                            `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
                          ),
                        );
                        cursor = e.seq;
                      }
                      cursor = batch.nextSeq;
                      if (batch.terminal) break;
                      controller.enqueue(
                        new TextEncoder().encode(": keepalive\n\n"),
                      );
                      await new Promise((r) => setTimeout(r, 2000));
                    }
                  } catch {
                  } finally {
                    if (!cancelled) controller.close();
                  }
                })(),
              );
            },
            cancel() {
              cancelled = true;
            },
          });
          return new Response(stream, {
            headers: {
              ...headers,
              "content-type": "text/event-stream",
              connection: "keep-alive",
            },
          });
        }
        return json(
          await call.events(
            since,
            p.owner || p.scopes.includes("transcript:read"),
          ),
        );
      }
      if (action === "transcript") {
        method(req, "GET");
        requireScope(p, "transcript:read");
        return json(await call.transcript());
      }
      method(req, "POST");
      const key = idempotency(req);
      if (action === "answers") {
        requireScope(p, "calls:answer");
        return json(
          await call.answer(AnswerSchema.parse(await readJson(req)), key),
        );
      }
      if (action === "dtmf") {
        requireScope(p, "calls:context");
        return json(
          await call.keypad(KeypadSchema.parse(await readJson(req)), key),
        );
      }
      if (action === "context") {
        requireScope(p, "calls:context");
        return json(
          await call.context(ContextSchema.parse(await readJson(req)), key),
        );
      }
      if (action === "cancel") {
        requireScope(p, "calls:cancel");
        return json(await call.cancel(key));
      }
      if (action === "reconcile") {
        assertOwner(p);
        const body = z
          .object({
            confirmedStopped: z.literal(true),
            costCents: z.number().int().nonnegative().max(100000),
          })
          .strict()
          .parse(await readJson(req));
        return json(
          await call.reconcile(body.confirmedStopped, body.costCents, key),
        );
      }
      throw new ApiError(404, "not_found", "Endpoint not found");
    } catch (e) {
      if (e instanceof z.ZodError)
        return json(
          {
            error: {
              code: "validation_error",
              message: "Request validation failed",
              issues: e.issues.map((i) => ({
                path: i.path,
                message: i.message,
              })),
            },
          },
          422,
        );
      const msg = e instanceof Error ? e.message : "";
      const encoded = msg.match(/^\[(\d{3}):([a-z_]+)\] (.*)$/s);
      if (e instanceof ApiError)
        return json(
          {
            error: {
              code: e.code,
              message: e.message.replace(/^\[.*?\] /, ""),
            },
          },
          e.status,
        );
      if (encoded)
        return json(
          { error: { code: encoded[2], message: encoded[3] } },
          Number(encoded[1]),
        );
      return json(
        {
          error: {
            code: "internal_error",
            message:
              "Request failed. Retry reads safely; reuse the same idempotency key for writes.",
          },
        },
        500,
      );
    }
  },
} satisfies ExportedHandler<Env>;
