import { z } from "zod";
import {
  CallBriefSchema,
  AnswerSchema,
  ContextSchema,
  CredentialSchema,
  CredentialUpdateSchema,
} from "./domain";
import { KeypadSchema } from "./ivr";
export function openapi(base: string) {
  const schema = (v: z.ZodType) => z.toJSONSchema(v, { io: "input" });
  const response = {
    description: "JSON response; see typed client",
    content: { "application/json": { schema: { type: "object" } } },
  };
  const id = {
    name: "id",
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
  };
  const key = {
    name: "Idempotency-Key",
    in: "header",
    required: true,
    schema: { type: "string", minLength: 8, maxLength: 128 },
  };
  const op = (
    operationId: string,
    summary: string,
    body?: string,
    params: unknown[] = [],
    result?: string,
  ) => ({
    operationId,
    summary,
    security: [{ bearerAuth: [] }],
    parameters: params,
    ...(body
      ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: `#/components/schemas/${body}` },
              },
            },
          },
        }
      : {}),
    responses: {
      "200": result
        ? {
            description: "Success",
            content: {
              "application/json": {
                schema: { $ref: `#/components/schemas/${result}` },
              },
            },
          }
        : response,
      "201": result
        ? {
            description: "Created",
            content: {
              "application/json": {
                schema: { $ref: `#/components/schemas/${result}` },
              },
            },
          }
        : response,
      "401": { description: "Invalid credential" },
      "403": { description: "Outside granted authority" },
      "409": {
        description: "Stale revision, concurrency or idempotency conflict",
      },
      "422": { description: "Invalid request" },
      "503": { description: "Live calling disabled" },
    },
  });
  return {
    openapi: "3.1.0",
    info: {
      title: "Personal Calling Assistant",
      version: "1.0.0",
      description:
        "Versioned briefs, live consultation and durable results. All costs are cents. All timestamps are Unix milliseconds. Calls default to simulation. Owner-only routes use an owner credential or Cloudflare Access.",
    },
    servers: [{ url: base }],
    paths: {
      "/v1/me": {
        get: op("getIdentity", "Read effective credential permissions"),
      },
      "/v1/calls/validate": {
        post: op(
          "validateCall",
          "Validate without dialing",
          "CallBrief",
          [],
          "Validation",
        ),
      },
      "/v1/calls": {
        post: op(
          "createCall",
          "Create or replay a call",
          "CallBrief",
          [key],
          "CallSnapshot",
        ),
        get: op("listCalls", "List accessible calls"),
      },
      "/v1/calls/{id}": {
        delete: op(
          "deleteCall",
          "Owner deletes retained content after all operations and costs are reconciled",
          undefined,
          [id, key],
        ),
        get: op(
          "getCall",
          "Read status, decisions, result and costs",
          undefined,
          [id],
          "CallSnapshot",
        ),
      },
      "/v1/calls/{id}/reconcile": {
        post: op(
          "reconcileCall",
          "Owner confirms carrier stopped and records verified final cents",
          "Reconciliation",
          [id, key],
          "CallSnapshot",
        ),
      },
      "/v1/calls/{id}/events": {
        get: {
          ...op(
            "getEvents",
            "Ordered incremental events; Accept: text/event-stream enables bounded reconnectable SSE",
            undefined,
            [
              id,
              {
                name: "since_seq",
                in: "query",
                schema: { type: "integer", minimum: 0 },
              },
            ],
          ),
          responses: {
            "200": {
              description: "Event batch or SSE",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/EventBatch" },
                },
                "text/event-stream": { schema: { type: "string" } },
              },
            },
          },
        },
      },
      "/v1/calls/{id}/answers": {
        post: op(
          "answerDecision",
          "Answer a pending decision at its expected revision",
          "DecisionAnswer",
          [id, key],
          "CallSnapshot",
        ),
      },
      "/v1/calls/{id}/context": {
        post: op(
          "updateContext",
          "Revise facts within existing authority",
          "ContextUpdate",
          [id, key],
          "CallSnapshot",
        ),
      },
      "/v1/calls/{id}/dtmf": {
        post: op(
          "sendKeypad",
          "Send real keypad tones for the current offered IVR menu or shareable numeric fact. Requires calls:context. No automatic retry of uncertain commands.",
          "KeypadRequest",
          [id, key],
        ),
      },
      "/v1/calls/{id}/cancel": {
        post: op(
          "cancelCall",
          "Stop safely and reconcile underway work",
          undefined,
          [id, key],
          "CallSnapshot",
        ),
      },
      "/v1/calls/{id}/transcript": {
        get: op(
          "getTranscript",
          "Read timestamped fragments and separate playback evidence",
          undefined,
          [id],
          "Transcript",
        ),
      },
      "/v1/admin/control": {
        post: op(
          "controlService",
          "Owner pauses starts or terminates active calls",
          "ServiceControl",
          [key],
        ),
      },
      "/v1/admin/callbacks": {
        post: op(
          "registerCallback",
          "Owner verifies an exact HTTPS callback using an echoed challenge",
          "CallbackRegistration",
          [key],
        ),
      },
      "/v1/admin/credentials/{id}/revoke": {
        post: op(
          "revokeCredential",
          "Owner revokes a credential and stops its active calls",
          undefined,
          [id, key],
        ),
      },
      "/v1/admin/credentials/{id}": {
        post: op(
          "updateCredential",
          "Owner replaces permissions while drained; preserves the existing secret and expiration",
          "CredentialUpdate",
          [id, key],
        ),
      },
      "/v1/admin/status": {
        get: op("adminStatus", "Owner spending, credentials and active calls"),
      },
      "/v1/admin/credentials": {
        post: op(
          "createCredential",
          "Owner issues a scoped credential, secret returned once; retries return 409 with its ID, never issue another key",
          "Credential",
          [key],
        ),
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        KeypadRequest: schema(KeypadSchema),
        CredentialUpdate: schema(CredentialUpdateSchema),
        Validation: schema(
          z.object({
            valid: z.boolean(),
            maximumEstimatedCents: z.number(),
            missingEssentials: z.array(z.string()),
            liveReady: z.boolean(),
            warnings: z.array(z.string()),
          }),
        ),
        Reconciliation: schema(
          z
            .object({
              confirmedStopped: z.literal(true),
              costCents: z.number().int().nonnegative().max(100000),
            })
            .strict(),
        ),
        ServiceControl: schema(
          z
            .object({
              kill: z.boolean().optional(),
              draining: z.boolean().optional(),
              terminateActive: z.boolean().optional(),
            })
            .strict(),
        ),
        CallbackRegistration: schema(
          z
            .object({
              id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
              url: z.url().max(2000),
            })
            .strict(),
        ),
        DecisionRequest: schema(
          z.object({
            id: z.uuid(),
            revision: z.number().int(),
            question: z.string(),
            context: z.string(),
            choices: z.array(z.string()),
            deadline: z.number(),
            fallback: CallBriefSchema.shape.escalation,
            status: z.enum(["pending", "answered", "expired", "superseded"]),
            answer: z.string().optional(),
            answeredAt: z.number().optional(),
            delegationId: z.string().optional(),
            ivrMenuId: z.string().optional(),
          }),
        ),
        CallResult: schema(
          z.object({
            finalized: z.boolean(),
            outcome: z.enum([
              "completed",
              "partially_completed",
              "unsuccessful",
              "uncertain",
            ]),
            summary: z.string(),
            confirmedDetails: z.array(z.string()),
            remainingQuestions: z.array(z.string()),
            evidenceReferences: z.array(z.string()),
            cost: z.object({ cents: z.number(), final: z.boolean() }),
          }),
        ),
        CallSnapshot: {
          type: "object",
          required: ["id", "mode", "status", "revision", "decisions", "usage"],
          properties: {
            id: { type: "string", format: "uuid" },
            mode: { enum: ["simulation", "live"] },
            destination: schema(CallBriefSchema.shape.destination),
            objective: { type: "string" },
            status: {
              enum: [
                "queued",
                "dialing",
                "active",
                "ending",
                "completed",
                "cancelled",
                "failed",
                "uncertain",
              ],
            },
            ivr: {
              type: "object",
              description:
                "Current IVR prompt: id, revision, prompt, kind (menu/input), options [{digits,label}], status, observedAt, expiresAt, operationId, digitCount. Fetch again before sending digits; expired or handled menus return 409.",
            },
            revision: { type: "integer" },
            createdAt: { type: "number" },
            startedAt: { type: "number" },
            endedAt: { type: "number" },
            providerRefs: {
              type: "object",
              properties: {
                telnyxCallControlId: { type: "string" },
                openaiSessionId: { type: "string" },
              },
            },
            decisions: {
              type: "array",
              items: { $ref: "#/components/schemas/DecisionRequest" },
            },
            result: { $ref: "#/components/schemas/CallResult" },
            usage: schema(
              z.object({
                liveSeconds: z.number(),
                carrierCostCents: z.number().optional(),
                backendCents: z.number(),
                costCents: z.number(),
                reservedCents: z.number(),
                final: z.boolean(),
              }),
            ),
            operations: { type: "array", items: { type: "object" } },
          },
        },
        Transcript: schema(
          z.object({
            fragments: z.array(
              z.object({
                speaker: z.enum(["business", "assistant"]),
                text: z.string(),
                startMs: z.number(),
                endMs: z.number(),
                at: z.number(),
                delivery: z.enum(["heard", "generated_unverified"]),
              }),
            ),
            purged: z.boolean(),
            playback: z.unknown(),
          }),
        ),
        CallBrief: schema(CallBriefSchema),
        DecisionAnswer: schema(AnswerSchema),
        ContextUpdate: schema(ContextSchema),
        Credential: schema(CredentialSchema),
        EventBatch: {
          type: "object",
          required: ["events", "nextSeq", "terminal"],
          properties: {
            events: {
              type: "array",
              items: { $ref: "#/components/schemas/CallEvent" },
            },
            nextSeq: { type: "integer" },
            terminal: { type: "boolean" },
          },
        },
        CallEvent: {
          type: "object",
          required: ["seq", "at", "type", "data"],
          properties: {
            seq: { type: "integer" },
            at: { type: "integer" },
            type: { type: "string" },
            data: {},
          },
        },
      },
    },
  };
}
