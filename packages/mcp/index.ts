import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CallingClient, bearerTransport } from "../client/index";
import {
  CallBriefSchema,
  Fact,
  Commitment,
  ContextSchema,
} from "../../src/domain";
import { KeypadSchema } from "../../src/ivr";
const base = process.env.CALLING_API_URL,
  token = process.env.CALLING_API_KEY;
if (!base || !token)
  throw new Error(
    "Set CALLING_API_URL and a scoped CALLING_API_KEY through your MCP host secret mechanism",
  );
const client = new CallingClient(base, bearerTransport(token)),
  server = new McpServer({
    name: "personal-calling-assistant",
    version: "1.0.0",
  });
const wrap = (fn: (a: any) => Promise<unknown>) => async (a: any) => {
  try {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(await fn(a)) }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: e instanceof Error ? e.message : "Request failed",
        },
      ],
    };
  }
};
server.registerTool(
  "validate_call",
  {
    description:
      "Validate a versioned brief and its maximum cost; never dials.",
    inputSchema: { brief: CallBriefSchema },
  },
  wrap((a) => client.validate(a.brief)),
);
server.registerTool(
  "create_call",
  {
    description:
      "Create a call within the credential authority. Default is simulation. Keep the same idempotency key on retries.",
    inputSchema: { brief: CallBriefSchema, idempotencyKey: z.string().min(8) },
  },
  wrap((a) => client.create(a.brief, a.idempotencyKey)),
);
server.registerTool(
  "get_call",
  {
    description: "Read call state and pending decisions.",
    inputSchema: { callId: z.uuid() },
  },
  wrap((a) => client.get(a.callId)),
);
server.registerTool(
  "call_events",
  {
    description: "Read incremental events after a durable sequence cursor.",
    inputSchema: {
      callId: z.uuid(),
      since: z.number().int().nonnegative().default(0),
    },
  },
  wrap((a) => client.events(a.callId, a.since)),
);
server.registerTool(
  "supervise_call",
  {
    description:
      "Poll in code for up to 55 seconds; return only a pending question, completion, or the next cursor. Repeat while supervising.",
    inputSchema: {
      callId: z.uuid(),
      since: z.number().int().nonnegative().default(0),
    },
  },
  wrap((a) => client.supervise(a.callId, { since: a.since, timeoutMs: 55000 })),
);
server.registerTool(
  "answer_decision",
  {
    description:
      "Answer a pending decision at the exact revision. Cannot revive expired decisions or grant broader authority.",
    inputSchema: {
      callId: z.uuid(),
      decisionId: z.uuid(),
      revision: z.number().int().positive(),
      answer: z.string().min(1),
      authorization: Commitment.optional(),
      idempotencyKey: z.string().min(8),
    },
  },
  wrap((a) =>
    client.answer(
      a.callId,
      { id: a.decisionId, revision: a.revision },
      a.answer,
      a.idempotencyKey,
      a.authorization,
    ),
  ),
);
server.registerTool(
  "update_call_context",
  {
    description:
      "Update shareable or private facts and supersede old decisions.",
    inputSchema: {
      callId: z.uuid(),
      revision: z.number().int().positive(),
      facts: z.array(Fact),
      authorizedCommitments: z.array(Commitment).max(20).optional(),
      instruction: ContextSchema.shape.instruction,
      idempotencyKey: z.string().min(8),
    },
  },
  wrap((a) =>
    client.context(a.callId, a.revision, a.facts, a.idempotencyKey, {
      authorizedCommitments: a.authorizedCommitments,
      instruction: a.instruction,
    }),
  ),
);
server.registerTool(
  "send_keypad",
  {
    description:
      "Send actual DTMF for a current IVR menu, never just speak digits. Read get_call.ivr first; preserve the idempotency key on ambiguous retries. Cannot authorize commitments or disclose private facts.",
    inputSchema: {
      callId: z.uuid(),
      request: KeypadSchema,
      idempotencyKey: z.string().min(8),
    },
  },
  wrap((a) => client.keypad(a.callId, a.request, a.idempotencyKey)),
);
server.registerTool(
  "cancel_call",
  {
    description: "Stop the call and reconcile underway provider operations.",
    inputSchema: { callId: z.uuid(), idempotencyKey: z.string().min(8) },
  },
  wrap((a) => client.cancel(a.callId, a.idempotencyKey)),
);
server.registerTool(
  "call_transcript",
  {
    description:
      "Read generated transcript fragments and separate playback evidence.",
    inputSchema: { callId: z.uuid() },
  },
  wrap((a) => client.transcript(a.callId)),
);
await server.connect(new StdioServerTransport());
