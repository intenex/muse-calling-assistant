import type {
  CallBrief,
  CallState,
  CallEvent,
  Decision,
  Transcript,
  Result,
  Principal,
} from "../../src/domain";
import type { z } from "zod";
import type {
  AnswerSchema,
  ContextSchema,
  CallBriefSchema,
} from "../../src/domain";
export type CallBriefInput = z.input<typeof CallBriefSchema>;
export type CallSnapshot = Pick<
  CallState,
  | "id"
  | "status"
  | "revision"
  | "createdAt"
  | "startedAt"
  | "endedAt"
  | "decisions"
  | "result"
  | "recording"
  | "ivr"
> & {
  mode: CallBrief["mode"];
  destination: CallBrief["destination"];
  objective: string;
  usage: {
    liveSeconds: number;
    carrierCostCents?: number;
    backendCents: number;
    costCents: number;
    reservedCents: number;
    final: boolean;
  };
};
export type AuthenticatedFetch = (request: Request) => Promise<Response>;
export class CallingClient {
  constructor(
    readonly baseUrl: string,
    private transport: AuthenticatedFetch,
  ) {
    const url = new URL(baseUrl);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      )
    )
      throw new Error("Calling API requires HTTPS");
  }
  async request<T>(
    path: string,
    body?: unknown,
    key?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!path.startsWith("/v1/"))
      throw new Error("Client requests must use the configured /v1 API host");
    const request = new Request(new URL(path, this.baseUrl), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "idempotency-key": key ?? crypto.randomUUID(),
            }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    });
    const response = await this.transport(request);
    const result = (await response.json()) as any;
    if (!response.ok)
      throw new CallingApiError(
        response.status,
        result.error?.code ?? "error",
        result.error?.message ?? "Request failed",
      );
    return result;
  }
  validate(brief: CallBriefInput) {
    return this.request<{
      valid: boolean;
      maximumEstimatedCents: number;
      missingEssentials: string[];
      liveReady: boolean;
      warnings: string[];
    }>("/v1/calls/validate", brief);
  }
  create(brief: CallBriefInput, key: string) {
    return this.request<CallSnapshot>("/v1/calls", brief, key);
  }
  get(id: string) {
    return this.request<CallSnapshot>(`/v1/calls/${encodeURIComponent(id)}`);
  }
  events(id: string, since = 0) {
    return this.request<{
      events: CallEvent[];
      nextSeq: number;
      terminal: boolean;
    }>(`/v1/calls/${encodeURIComponent(id)}/events?since_seq=${since}`);
  }
  answer(
    id: string,
    decision: Pick<Decision, "id" | "revision">,
    answer: string,
    key: string,
    authorization?: z.infer<typeof AnswerSchema>["authorization"],
  ) {
    return this.request<CallSnapshot>(
      `/v1/calls/${encodeURIComponent(id)}/answers`,
      {
        decisionId: decision.id,
        expectedRevision: decision.revision,
        answer,
        authorization,
      },
      key,
    );
  }
  context(
    id: string,
    revision: number,
    facts: CallBrief["facts"],
    key: string,
    changes: Omit<
      z.infer<typeof ContextSchema>,
      "expectedRevision" | "facts"
    > = {},
  ) {
    return this.request<CallSnapshot>(
      `/v1/calls/${encodeURIComponent(id)}/context`,
      { ...changes, expectedRevision: revision, facts },
      key,
    );
  }
  keypad(
    id: string,
    request: import("zod").z.infer<typeof import("../../src/ivr").KeypadSchema>,
    key: string,
  ) {
    return this.request<{
      operationId: string;
      status: string;
      simulated: boolean;
    }>(`/v1/calls/${encodeURIComponent(id)}/dtmf`, request, key);
  }
  cancel(id: string, key: string) {
    return this.request<CallSnapshot>(
      `/v1/calls/${encodeURIComponent(id)}/cancel`,
      {},
      key,
    );
  }
  transcript(id: string) {
    return this.request<{
      fragments: Transcript[];
      purged: boolean;
      playback: unknown;
    }>(`/v1/calls/${encodeURIComponent(id)}/transcript`);
  }
  /** Unchanged polls execute in code, without an LLM turn. Caller persists nextSeq. */
  async supervise(
    id: string,
    options: { since?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ) {
    let seq = options.since ?? 0;
    const duration = Math.max(1, Math.min(options.timeoutMs ?? 55000, 2700000));
    const deadline = Date.now() + duration;
    const window = new AbortController();
    const timer = setTimeout(() => window.abort(), duration);
    const signal = options.signal
      ? AbortSignal.any([options.signal, window.signal])
      : window.signal;
    try {
      while (Date.now() < deadline) {
        options.signal?.throwIfAborted();
        const pollStarted = Date.now();
        const [batch, state] = await Promise.all([
          this.request<{
            events: CallEvent[];
            nextSeq: number;
            terminal: boolean;
          }>(
            `/v1/calls/${encodeURIComponent(id)}/events?since_seq=${seq}`,
            undefined,
            undefined,
            signal,
          ),
          this.request<CallSnapshot>(
            `/v1/calls/${encodeURIComponent(id)}`,
            undefined,
            undefined,
            signal,
          ),
        ]);
        seq = batch.nextSeq;
        const decisions = state.decisions.filter(
          (d) => d.status === "pending" && d.deadline > Date.now(),
        );
        const ended =
          state.result?.finalized !== false &&
          (batch.terminal ||
            ["completed", "cancelled", "failed", "uncertain"].includes(
              state.status,
            ));
        const ivr =
          state.ivr?.mode === "assisted" &&
          state.ivr.status === "pending" &&
          state.ivr.expiresAt > Date.now()
            ? state.ivr
            : undefined;
        if (decisions.length || ended || ivr)
          return {
            ivr,
            nextSeq: seq,
            decisions,
            result: state.result,
            status: state.status,
            terminal: ended,
          };
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            signal.removeEventListener("abort", abort);
            resolve();
          };
          const t = setTimeout(
            done,
            Math.max(0, 5000 - (Date.now() - pollStarted)),
          );
          const abort = () => {
            clearTimeout(t);
            signal.removeEventListener("abort", abort);
            reject(signal.reason);
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!window.signal.aborted) throw error;
    } finally {
      clearTimeout(timer);
      window.abort();
    }
    return {
      nextSeq: seq,
      decisions: [],
      terminal: false,
      status: "supervision_window_elapsed" as const,
    };
  }
}
export class CallingApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function bearerTransport(token: string): AuthenticatedFetch {
  return (req) => {
    const headers = new Headers(req.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(new Request(req, { headers }));
  };
}
export type { CallBrief, CallEvent, Decision, Result, Principal };
