import { DurableObject } from "cloudflare:workers";
import {
  AnswerSchema,
  ContextSchema,
  ApiError,
  terminal,
  publicState,
  estimatedCost,
  reservation,
  voiceInstructions,
  openingInstructions,
  explicitVoicemailInvitation,
  recipientRequestsHangup,
  assistantFarewell,
  authorizeBrief,
  type CallBrief,
  type Principal,
  type CallState,
  type Status,
  type CallEvent,
  type Transcript,
  type Decision,
} from "./domain";
import { Store } from "./storage";
import {
  digest,
  hmac,
  verifyMedia,
  liveAllowed,
  controlledTestAllowed,
  to64,
} from "./security";
import {
  dial,
  hangup,
  sendDigits,
  callStatus,
  telnyx,
} from "./providers/telnyx";
import {
  connectLive,
  contextChunks,
  modelContext,
  maxModelCost,
  reason,
  summarize,
  type ReasoningOutput,
  type ModelTier,
} from "./providers/openai";
import { Playback, AudioFrames } from "./playback";
import {
  KeypadSchema,
  parseIvr,
  normalizeIvr,
  selectIvrOption,
  validateKeypad,
  type IvrMenu,
} from "./ivr";
import { calculate } from "./calculation";
export class CallController extends DurableObject<Env> {
  private db: Store;
  private s?: CallState;
  private media?: WebSocket;
  private live?: WebSocket;
  private playback?: Playback;
  private timer?: ReturnType<typeof setInterval>;
  private pendingTranscript: Transcript[] = [];
  private liveReady = false;
  private backendBusy = false;
  private queuedDelegation?: string;
  private businessTail = "";
  private ivrText = "";
  private ivrTextAt = 0;
  private ivrTimer?: ReturnType<typeof setTimeout>;
  private ivrSilenceUntil = 0;
  private assistantTail = "";
  private lastAssistantTextAt = 0;
  private voicemailHandling = false;
  private recipientTurn = "";
  private assistantTurn = "";
  private lastRecipientTextAt = 0;
  private transcriptClose?: {
    timer: ReturnType<typeof setTimeout>;
    recipient: boolean;
  };
  private gracefulClosing = false;
  private closing = false;
  private streamId?: string;
  private inputFrames?: AudioFrames;
  private seq = 0;
  private lastInputAt = 0;
  private closeDeadline?: number;
  private appendEvents = new Map<string, number>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Store(ctx.storage.sql);
    this.s = this.db.get<CallState>("state");
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS transcript(seq INTEGER PRIMARY KEY AUTOINCREMENT,data TEXT NOT NULL)",
    );
    this.seq = ctx.storage.sql
      .exec<{ n: number }>("SELECT COALESCE(MAX(seq),0) AS n FROM events")
      .one().n;
  }
  private state() {
    if (!this.s) throw new ApiError(404, "not_found", "Call not found");
    return this.s;
  }
  private save() {
    this.db.put("state", this.state());
  }
  private event(type: string, data: unknown) {
    if (this.seq >= 10000) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO events(at,type,data) VALUES(?,?,?)",
      Date.now(),
      type,
      JSON.stringify(data),
    );
    this.seq++;
  }
  async initialize(id: string, brief: CallBrief, principal: Principal) {
    if (this.db.get("deleted"))
      throw new ApiError(
        410,
        "call_deleted",
        "This call was deleted; use a new idempotency key for a new call",
      );
    if (this.s) return publicState(this.s);
    const now = Date.now();
    this.s = {
      id,
      brief,
      principal,
      revision: 1,
      status: "queued",
      createdAt: now,
      maxEndAt:
        now +
        (brief.mode === "simulation"
          ? (brief.simulation?.durationSeconds ?? 480) * 1000
          : brief.limits.maxMinutes * 60000),
      decisions: [],
      operations: [],
      mediaNonce: crypto.randomUUID(),
      mediaUsed: false,
      liveSeconds: 0,
      backendCents: 0,
      backendReservedCents: 0,
      liveFinal: false,
      costFinal: false,
      reservedCents: reservation(brief),
      recording: {
        status:
          brief.mode === "live" && brief.recording === "on"
            ? "requested"
            : "off",
      },
      simulationQuestionSent: false,
      hangupAttempts: 0,
      ownerSettled: false,
      callbackAttempts: 0,
      confirmedDetails: [],
      providerEvents: [],
      modelRequests: 0,
      lastCheckpoint: now,
      rateWindow: now,
      mediaMessages: 0,
    };
    this.save();
    this.event("call.created", { mode: brief.mode, revision: 1 });
    await this.schedule();
    this.ctx.waitUntil(
      this.start().catch(() => this.stop("uncertain", "Startup failed")),
    );
    return publicState(this.s);
  }
  async erase() {
    const s = this.state();
    if (
      !terminal(s.status) ||
      !s.ownerSettled ||
      s.operations.some((o) => o.status === "intent")
    )
      throw new ApiError(
        409,
        "call_unsettled",
        "Finish and reconcile pending operations before deletion",
      );
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM events");
      this.ctx.storage.sql.exec("DELETE FROM transcript");
      this.ctx.storage.sql.exec("DELETE FROM records");
      this.db.put("deleted", true);
    });
    await this.ctx.storage.deleteAlarm();
    this.s = undefined;
    await this.env.OWNER.getByName("owner").hide(s.id);
    return { deleted: true };
  }
  async access(p: Principal) {
    const s = this.state();
    if (!p.owner && p.id !== s.principal.id)
      throw new ApiError(404, "not_found", "Call not found");
    return true;
  }
  async snapshot() {
    return publicState(this.state());
  }
  async events(since: number, includeTranscript = true) {
    this.state();
    const events = this.ctx.storage.sql
      .exec<{ seq: number; at: number; type: string; data: string }>(
        "SELECT seq,at,type,data FROM events WHERE seq>? ORDER BY seq LIMIT 200",
        since,
      )
      .toArray()
      .map((r) => ({ ...r, data: JSON.parse(r.data) }));
    return {
      events: includeTranscript
        ? events
        : events.filter((e) => e.type !== "transcript.batch"),
      nextSeq: events.at(-1)?.seq ?? since,
      terminal:
        terminal(this.state().status) &&
        this.state().result?.finalized !== false,
    };
  }
  async transcript() {
    const s = this.state();
    this.flushTranscript();
    return {
      fragments: this.transcripts(10000),
      purged: !!s.transcriptsPurged,
      playback: this.playback?.snapshot() ?? this.db.get("playback") ?? null,
    };
  }
  private transcripts(limit = 120): Transcript[] {
    return this.ctx.storage.sql
      .exec<{ data: string }>(
        "SELECT data FROM transcript ORDER BY seq DESC LIMIT ?",
        limit,
      )
      .toArray()
      .reverse()
      .flatMap((r) => JSON.parse(r.data) as Transcript[]);
  }
  private flushTranscript() {
    if (!this.pendingTranscript.length) return;
    const batch = this.pendingTranscript.splice(0);
    this.ctx.storage.sql.exec(
      "INSERT INTO transcript(data) VALUES(?)",
      JSON.stringify(batch),
    );
    this.event("transcript.batch", { fragments: batch });
  }
  private async schedule() {
    const s = this.state(),
      now = Date.now();
    const times: number[] = [];
    if (s.testPeer?.due) times.push(s.testPeer.due);
    if (this.db.list("webhook:", 1).length) times.push(now + 1000);
    if (!terminal(s.status) && s.status !== "ending") {
      times.push(s.maxEndAt, now + 5000);
      for (const d of s.decisions)
        if (d.status === "pending") times.push(d.deadline);
      if (
        s.brief.mode === "simulation" &&
        s.brief.simulation?.scenario !== "ivr" &&
        !s.simulationQuestionSent
      )
        times.push(
          s.createdAt +
            (s.brief.simulation?.questionAfterSeconds ?? 180) * 1000,
        );
    }
    if (s.nextRecoveryAt) times.push(s.nextRecoveryAt);
    if (s.retainUntil && !s.transcriptsPurged) times.push(s.retainUntil);
    if (s.nextCallbackAt) times.push(s.nextCallbackAt);
    if (!s.ownerSettled && terminal(s.status)) times.push(now + 5000);
    if (s.result?.finalized === false) times.push(now + 10000);
    if (times.length)
      await this.ctx.storage.setAlarm(Math.max(now + 100, Math.min(...times)));
    else await this.ctx.storage.deleteAlarm();
  }
  private async start() {
    const s = this.state();
    if (s.status !== "queued") return;
    if (s.brief.mode === "simulation") {
      s.status = "active";
      s.startedAt = Date.now();
      this.save();
      this.event("call.active", { simulation: true });
      await this.env.OWNER.getByName("owner").status(s.id, s.status);
      if (s.brief.simulation?.scenario === "ivr")
        this.publishIvr(
          "For opening hours, press one. For scheduling, press two.",
        );
      await this.schedule();
      return;
    }
    if (
      !liveAllowed(this.env, s.principal, s.brief) ||
      !(await this.env.OWNER.getByName("owner").permitted(s.principal.id))
    )
      return this.stop("failed", "Live call authorization unavailable");
    if (s.status !== "queued") return;
    s.status = "dialing";
    s.operations.push({
      id: s.id,
      kind: "dial",
      status: "intent",
      revision: s.revision,
      at: Date.now(),
    });
    this.save();
    try {
      const result = await dial(this.env, s);
      s.telnyxId = String(result.data.call_control_id ?? "");
      if (
        s.recording?.status === "requested" &&
        typeof result.data.recording_id === "string"
      )
        s.recording.id = result.data.recording_id;
      if (!s.telnyxId) throw new Error("missing_carrier_id");
      s.operations.find((o) => o.id === s.id)!.status = "succeeded";
      this.save();
      this.event("call.dialing", {});
      if (this.state().status === "ending" || terminal(this.state().status))
        await this.stop(
          s.pendingStop ?? "cancelled",
          "Cancellation while dialing",
        );
    } catch (error) {
      const op = s.operations.find((o) => o.id === s.id)!;
      if (error instanceof ApiError && error.code === "carrier_rejected") {
        op.status = "failed";
        s.costFinal = true;
        s.reconciledCents = 0;
        this.save();
        await this.finish("failed", error.message);
        return;
      }
      op.status = "uncertain";
      this.save();
      this.event("operation.uncertain", { id: op.id, kind: "dial" });
      await this.stop(
        "uncertain",
        "Dial outcome requires reconciliation; no automatic redial",
      );
    }
    await this.schedule();
  }
  private async idempotent(key: string, body: unknown, perform: () => unknown) {
    const hash = await digest(JSON.stringify(body));
    const prior = this.db.get<{ hash: string; result: unknown }>(
      `mutation:${key}`,
    );
    if (prior) {
      if (prior.hash !== hash)
        throw new ApiError(
          409,
          "idempotency_conflict",
          "Idempotency key has different content",
        );
      return prior.result;
    }
    if (this.db.list("mutation:", 501).length >= 500)
      throw new ApiError(429, "mutation_limit", "Call mutation limit reached");
    // Both the revised state and its replay receipt commit in one SQL transaction.
    const result = this.ctx.storage.transactionSync(() => {
      const result = perform();
      this.db.put(`mutation:${key}`, { hash, result });
      return result;
    });
    await this.schedule();
    return result;
  }
  async answer(body: unknown, key: string) {
    const a = AnswerSchema.parse(body);
    return this.idempotent(`answer:${key}`, a, () => {
      const s = this.state(),
        d = s.decisions.find((d) => d.id === a.decisionId);
      if (
        terminal(s.status) ||
        s.status === "ending" ||
        !d ||
        d.status !== "pending" ||
        d.deadline <= Date.now() ||
        d.revision !== a.expectedRevision ||
        s.revision !== a.expectedRevision
      )
        throw new ApiError(
          409,
          "stale_decision",
          "Decision is expired, resolved, or belongs to an older revision",
        );
      if (d.choices.length && !d.choices.includes(a.answer))
        throw new ApiError(
          422,
          "invalid_choice",
          "Answer must match one of the decision choices",
        );
      if (a.authorization) {
        const commitments = s.brief.authorizedCommitments.filter(
          (c) => c.id !== a.authorization!.id,
        );
        commitments.push(a.authorization);
        const revised = { ...s.brief, authorizedCommitments: commitments };
        authorizeBrief(s.principal, revised);
        s.brief = revised;
      }
      d.status = "answered";
      d.answer = a.answer;
      d.answeredAt = Date.now();
      s.revision++;
      if (s.ivr?.status === "pending") s.ivr.revision = s.revision;
      for (const other of s.decisions)
        if (other.status === "pending") other.status = "superseded";
      this.save();
      this.clearPlayback();
      this.event("decision.answered", {
        id: d.id,
        answer: a.answer,
        revision: s.revision,
        latencyMs:
          d.answeredAt -
          (d.deadline - s.brief.escalation.deadlineSeconds * 1000),
      });
      this.append(
        "thinking",
        `The originating agent answered the pending question: ${a.answer}. This supplies context only; it does not grant new commitment permissions.`,
        d.delegationId,
      );
      return publicState(s);
    });
  }
  async context(body: unknown, key: string) {
    const c = ContextSchema.parse(body);
    return this.idempotent(`context:${key}`, c, () => {
      const s = this.state();
      if (
        terminal(s.status) ||
        s.status === "ending" ||
        c.expectedRevision !== s.revision
      )
        throw new ApiError(
          409,
          "stale_revision",
          "Call revision has changed or call has ended",
        );
      const facts = [...s.brief.facts];
      for (const f of c.facts) {
        const i = facts.findIndex((x) => x.id === f.id);
        if (i >= 0) facts[i] = f;
        else facts.push(f);
      }
      if (facts.length > 100)
        throw new ApiError(422, "fact_limit", "At most 100 facts");
      const revised = {
        ...s.brief,
        facts,
        authorizedCommitments:
          c.authorizedCommitments ?? s.brief.authorizedCommitments,
      };
      authorizeBrief(s.principal, revised);
      if (c.instruction)
        revised.preferences = [
          ...revised.preferences.slice(-29),
          c.instruction,
        ];
      s.brief = revised;
      s.revision++;
      if (s.ivr?.status === "pending") s.ivr.revision = s.revision;
      for (const d of s.decisions)
        if (d.status === "pending") d.status = "superseded";
      this.save();
      this.clearPlayback();
      this.event("context.updated", {
        revision: s.revision,
        factIds: c.facts.map((f) => f.id),
      });
      for (const f of c.facts.filter((f) => f.visibility === "shareable"))
        this.append("thinking", `Corrected fact ${f.id}: ${f.text}`);
      if (c.instruction)
        this.append(
          "thinking",
          `Owner context, subordinate to existing permissions and prohibitions: ${c.instruction}`,
        );
      return publicState(s);
    });
  }
  async cancel(key: string) {
    const prior = this.db.get<{ done: boolean }>(`cancel:${key}`);
    if (prior?.done) return publicState(this.state());
    this.db.put(`cancel:${key}`, { done: false });
    await this.stop("cancelled", "Cancelled by caller");
    this.db.put(`cancel:${key}`, { done: true });
    return publicState(this.state());
  }
  private requestDecision(
    question: string,
    context: string,
    choices: string[],
    delegationId?: string,
  ) {
    const s = this.state();
    if (s.decisions.some((d) => d.status === "pending")) return;
    if (s.decisions.length >= 30) {
      this.ctx.waitUntil(this.stop("failed", "Decision limit reached"));
      return;
    }
    const d: Decision = {
      id: crypto.randomUUID(),
      revision: s.revision,
      question,
      context,
      choices,
      deadline: Date.now() + s.brief.escalation.deadlineSeconds * 1000,
      fallback: s.brief.escalation,
      status: "pending",
      delegationId,
      ivrMenuId:
        s.ivr &&
        ["pending", "expired", "failed", "uncertain"].includes(s.ivr.status)
          ? s.ivr.id
          : undefined,
    };
    s.decisions.push(d);
    this.save();
    this.event("decision.requested", d);
    this.enqueueCallback("decision.requested", d);
    this.append(
      "instructions",
      s.ivr &&
        ["pending", "expired", "uncertain", "failed"].includes(s.ivr.status)
        ? "Additional information is being requested for the phone menu. Stay silent; do not ask a recording to hold or repeat progress updates."
        : "Additional information is being requested. Ask an independent useful question or ask for a brief hold. Do not make the unresolved commitment or repeatedly fill the silence.",
      delegationId,
    );
  }
  async alarm() {
    const s = this.state(),
      now = Date.now();
    for (const { key } of this.db.list("webhook:", 20))
      await this.applyQueuedWebhook(key);
    this.flushTranscript();
    if (s.ivr?.status === "pending" && s.ivr.expiresAt <= now) {
      s.ivr.status = "expired";
      this.save();
      this.event("ivr.expired", { menuId: s.ivr.id });
      this.requestDecision(
        "The phone menu timed out without a keypad selection.",
        "Do not guess a key for an expired prompt.",
        [],
      );
    }
    if (s.testPeer?.due && now >= s.testPeer.due) await this.advanceTestPeer();
    if (!terminal(s.status) && s.status !== "ending") {
      if (
        !(await this.env.OWNER.getByName("owner").permitted(s.principal.id))
      ) {
        await this.stop(
          "cancelled",
          "Authorization revoked or kill switch enabled",
        );
        return;
      }
      for (const d of s.decisions)
        if (d.status === "pending" && d.deadline <= now) {
          d.status = "expired";
          s.revision++;
          this.save();
          this.event("decision.expired", {
            id: d.id,
            revision: s.revision,
            fallback: d.fallback.fallback,
          });
          this.clearPlayback();
          if (d.fallback.fallback === "end_without_commitment") {
            this.append(
              "instructions",
              "We cannot obtain the required authorization. Politely explain that we will follow up, and end without making a commitment.",
            );
            await this.stop(
              "completed",
              "Decision deadline passed without authorization",
            );
            return;
          }
          this.append(
            "instructions",
            d.fallback.fallback === "collect_information"
              ? "Authorization was not received. Only collect available information. Do not make the unresolved commitment."
              : `Authorization was not received. Use only this explicitly permitted alternative: ${d.fallback.explicitAlternative}`,
          );
        }
      if (now >= s.maxEndAt) {
        await this.stop("completed", "Maximum call duration reached");
        return;
      }
      if (
        s.brief.mode === "simulation" &&
        s.brief.simulation?.scenario !== "ivr" &&
        !s.simulationQuestionSent &&
        now >=
          s.createdAt + (s.brief.simulation?.questionAfterSeconds ?? 180) * 1000
      ) {
        s.simulationQuestionSent = true;
        this.save();
        this.requestDecision(
          "The requested appointment is unavailable. Which alternative should I ask about?",
          "Simulation: no business has been called.",
          ["Morning", "Afternoon", "End without booking"],
        );
      }
      if (s.brief.mode === "live") {
        if (s.status === "queued") {
          await this.start();
        } else if (
          s.status === "active" &&
          !this.live &&
          !this.media &&
          now - (s.startedAt ?? now) > 10000
        ) {
          await this.stop(
            "uncertain",
            "Runtime restarted or media transport lost; call safely stopped",
          );
          return;
        } else if (s.status === "dialing" && now - s.createdAt > 60000) {
          await this.stop("uncertain", "Carrier connection timeout");
          return;
        }
        if (estimatedCost(s) >= s.brief.limits.maxCostCents - 5) {
          await this.stop("completed", "Call spending limit reached");
          return;
        }
      }
    }
    if (s.nextRecoveryAt && now >= s.nextRecoveryAt) await this.recoverStop();
    if (terminal(s.status) && !s.ownerSettled) await this.settle();
    if (
      terminal(s.status) &&
      s.result?.finalized === false &&
      now - (s.endedAt ?? now) >= 20000
    ) {
      for (const op of s.operations)
        if (op.kind === "summary" && op.status === "intent")
          op.status = "uncertain";
      this.publishResult(
        "The call ended, but final summary generation did not finish. Review the transcript and verified details.",
      );
    }
    if (s.nextCallbackAt && now >= s.nextCallbackAt)
      await this.deliverCallback();
    if (s.retainUntil && now >= s.retainUntil && !s.transcriptsPurged) {
      this.ctx.storage.sql.exec("DELETE FROM transcript");
      this.ctx.storage.sql.exec(
        "DELETE FROM events WHERE type='transcript.batch'",
      );
      s.transcriptsPurged = true;
      this.event("transcript.purged", {});
    }
    s.lastCheckpoint = now;
    this.save();
    await this.schedule();
  }
  async webhook(event: {
    id: string;
    event_type: string;
    occurred_at?: string;
    payload: Record<string, unknown>;
  }) {
    const s = this.state();
    if (s.providerEvents.includes(event.id)) return { duplicate: true };
    if (s.providerEvents.length >= 1000)
      throw new ApiError(429, "webhook_limit", "Call webhook limit reached");
    const id = event.payload.call_control_id;
    if (s.telnyxId && id && s.telnyxId !== id)
      throw new ApiError(
        409,
        "carrier_mismatch",
        "Carrier call identifier mismatch",
      );
    if (id) s.telnyxId = String(id);
    if (event.event_type.startsWith("call.recording.")) {
      // Signed download URLs are short-lived credentials. Keep only durable
      // recording metadata; the local dashboard retrieves fresh URLs directly.
      const {
        call_control_id,
        recording_id,
        recording_started_at,
        recording_ended_at,
      } = event.payload;
      event = {
        ...event,
        payload: {
          call_control_id,
          recording_id,
          recording_started_at,
          recording_ended_at,
        },
      };
    }
    this.ctx.storage.transactionSync(() => {
      s.providerEvents.push(event.id);
      this.save();
      this.db.put(`webhook:${event.id}`, event);
      this.event("carrier.event", { id: event.id, type: event.event_type });
    });
    await this.schedule();
    // A signed event is durably accepted before asynchronous provider operations.
    this.ctx.waitUntil(
      this.applyQueuedWebhook(`webhook:${event.id}`).catch(() =>
        this.stop("uncertain", "Carrier event processing failed"),
      ),
    );
    return { accepted: true };
  }
  private async applyQueuedWebhook(key: string) {
    const event = this.db.get<{
      event_type: string;
      payload: Record<string, unknown>;
    }>(key);
    if (!event) return;
    await this.applyWebhook(event);
    this.db.remove(key);
  }
  async controlledHook(e: {
    event_type: string;
    payload: Record<string, unknown>;
  }) {
    const s = this.state();
    if (
      !controlledTestAllowed(this.env, s.principal, s.brief) ||
      terminal(s.status) ||
      s.status === "ending"
    )
      return { ignored: true };
    const p = e.payload,
      id = String(p.call_control_id ?? "");
    if (
      e.event_type === "call.initiated" &&
      p.direction === "incoming" &&
      p.from === this.env.TELNYX_FROM_NUMBER &&
      p.to === this.env.CONTROLLED_TEST_NUMBER &&
      !s.testPeer
    ) {
      s.testPeer = { callId: id, step: 0, due: Date.now() + 10000 };
      this.save();
      await this.schedule();
      await telnyx(
        this.env,
        `/calls/${encodeURIComponent(id)}/actions/answer`,
        { command_id: `${s.id}:test-answer` },
      );
    } else if (
      s.testPeer?.callId === id &&
      e.event_type === "call.answered" &&
      s.testPeer.step === 0
    ) {
      s.testPeer.due = Date.now();
      this.save();
      await this.schedule();
    } else if (s.testPeer?.callId === id && e.event_type === "call.hangup") {
      s.testPeer.due = 0;
      this.save();
    }
    return { accepted: true };
  }
  private async advanceTestPeer() {
    const s = this.state(),
      peer = s.testPeer;
    if (!peer) return;
    const script = [
      "Hello. This is the automated calling assistant test line. Please introduce yourself and tell me why you are calling.",
      "We have an appointment on Tuesday at ten a m. The reference number is B seven two nine. Please repeat that number.",
      "Correction. The reference number is B seven three nine. Please repeat the corrected reference number.",
      "Thank you. This controlled test is complete. Goodbye.",
    ];
    const step = peer.step++;
    peer.due = step >= script.length ? 0 : Date.now() + 13000;
    this.save();
    await this.schedule();
    try {
      if (step >= script.length)
        await hangup(this.env, peer.callId, `${s.id}:test-end`);
      else
        await telnyx(
          this.env,
          `/calls/${encodeURIComponent(peer.callId)}/actions/speak`,
          {
            payload: script[step],
            payload_type: "text",
            voice: "female",
            language: "en-US",
            command_id: `${s.id}:test-speak:${step}`,
          },
        );
      this.event("evaluation.peer_step", { step });
    } catch {
      this.event("evaluation.peer_failed", { step });
      await this.stop("uncertain", "Controlled test peer failed");
    }
  }
  private async applyWebhook(e: {
    event_type: string;
    payload: Record<string, unknown>;
  }) {
    const s = this.state();
    if (
      e.event_type === "call.recording.saved" ||
      e.event_type === "call.recording.error"
    ) {
      if (!s.recording || s.recording.status === "off") return;
      s.recording.status =
        e.event_type === "call.recording.saved" ? "saved" : "failed";
      if (typeof e.payload.recording_id === "string")
        s.recording.id = e.payload.recording_id;
      const start = Date.parse(String(e.payload.recording_started_at ?? ""));
      const end = Date.parse(String(e.payload.recording_ended_at ?? ""));
      if (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start >= s.createdAt - 60000 &&
        end >= start &&
        end <= Date.now() + 60000 &&
        end - start <= s.brief.limits.maxMinutes * 60000 + 120000
      ) {
        s.recording.startedAt = start;
        s.recording.endedAt = end;
      }
      this.save();
      this.event(
        e.event_type === "call.recording.saved"
          ? "recording.saved"
          : "recording.failed",
        { id: s.recording.id },
      );
      if (terminal(s.status)) await this.settle();
      return;
    }
    if (e.event_type === "call.cost") {
      const cost = Number(e.payload.total_cost);
      const parts = e.payload.cost_parts;
      if (
        e.payload.status === "success" &&
        typeof e.payload.total_cost === "string" &&
        Number.isFinite(cost) &&
        cost >= 0 &&
        cost <= 1000 &&
        Array.isArray(parts) &&
        parts.length &&
        parts.every((p) => p.currency === "USD")
      ) {
        s.carrierCostCents = Math.max(s.carrierCostCents ?? 0, cost * 100);
        this.save();
        this.event("carrier.cost", { cents: s.carrierCostCents });
        if (terminal(s.status)) await this.settle();
      }
      return;
    }
    if (e.event_type === "call.hangup") {
      s.endedAt ??= Date.now();
      s.nextRecoveryAt = undefined;
      await this.finish(
        s.pendingStop ?? "completed",
        "Carrier confirmed hangup",
      );
      return;
    }
    if (s.status === "ending" || terminal(s.status)) {
      if (s.telnyxId && !s.ownerSettled) await this.recoverStop();
      return;
    }
    if (e.event_type === "call.answered") {
      s.startedAt ??= Date.now();
      if (s.recording?.status === "requested")
        s.recording.startedAt ??= s.startedAt;
      s.status = "active";
      this.save();
      this.event("call.active", {});
      await this.env.OWNER.getByName("owner").status(s.id, s.status);
    }
    if (
      e.event_type === "call.machine.detection.ended" &&
      e.payload.result === "machine"
    )
      this.append(
        "thinking",
        "The carrier detected an automated greeting. This is only a hint: it may be an IVR or call-screening service rather than voicemail. For screening, briefly state the call purpose and wait to be connected. Navigate IVR menus with backend delegation. Apply the voicemail policy only after hearing an explicit invitation to leave a message.",
      );
  }
  async fetch(request: Request) {
    const s = this.state();
    const token = new URL(request.url).searchParams.get("token") ?? "";
    if (
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      s.brief.mode !== "live" ||
      s.mediaUsed ||
      terminal(s.status) ||
      s.status === "ending" ||
      !(await verifyMedia(this.env, s.id, s.mediaNonce, token))
    )
      return new Response("Unauthorized", { status: 401 });
    if (!(await this.env.OWNER.getByName("owner").permitted(s.principal.id)))
      return new Response("Forbidden", { status: 403 });
    if (s.mediaUsed) return new Response("Already connected", { status: 409 });
    s.mediaUsed = true;
    this.save();
    const pair = new WebSocketPair();
    this.media = pair[1];
    this.media.accept();
    this.media.addEventListener("message", (e) => {
      try {
        this.onMedia(String(e.data));
      } catch (error) {
        const code =
          error instanceof Error && /^[a-z_]{1,50}$/.test(error.message)
            ? error.message
            : "invalid_frame";
        this.event("media.error", { code });
        this.ctx.waitUntil(
          this.stop("uncertain", "Invalid media stream or backpressure"),
        );
      }
    });
    this.media.addEventListener("close", () => {
      if (!this.closing)
        this.ctx.waitUntil(
          this.stop("uncertain", "Carrier media disconnected"),
        );
    });
    this.media.addEventListener("error", () => {
      if (!this.closing)
        this.ctx.waitUntil(this.stop("uncertain", "Carrier media error"));
    });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  private onMedia(raw: string) {
    if (raw.length > 100000) throw new Error("media_frame_limit");
    const s = this.state(),
      now = Date.now();
    if (now - s.rateWindow > 1000) {
      s.rateWindow = now;
      s.mediaMessages = 0;
    }
    if (++s.mediaMessages > 120) throw new Error("media_rate_limit");
    const e = JSON.parse(raw);
    if (e.event === "start") {
      if (this.streamId) throw new Error("duplicate_stream");
      this.streamId = e.stream_id ?? e.start?.stream_id;
      if (
        e.start?.call_control_id &&
        s.telnyxId &&
        e.start.call_control_id !== s.telnyxId
      )
        throw new Error("wrong_call");
      const format = e.start?.media_format;
      const expected = this.env.AUDIO_CODEC === "PCMU" ? 8000 : 16000;
      if (
        !format ||
        Number(format.sample_rate) !== expected ||
        format.encoding !== this.env.AUDIO_CODEC
      )
        throw new Error("unexpected_codec");
      s.startedAt ??= now;
      s.status = "active";
      this.save();
      this.inputFrames = new AudioFrames(
        (expected * (this.env.AUDIO_CODEC === "PCMU" ? 1 : 2)) / 50,
        this.env.AUDIO_CODEC === "PCMU" ? 255 : 0,
      );
      this.playback = new Playback(
        expected * (this.env.AUDIO_CODEC === "PCMU" ? 1 : 2),
        (value) => this.media?.send(JSON.stringify(value)),
      );
      this.ctx.waitUntil(
        this.openVoice().catch(() =>
          this.stop("uncertain", "Voice session failed to start"),
        ),
      );
      return;
    }
    if (e.event === "media" && e.media?.payload) {
      if (!this.streamId) throw new Error("missing_start");
      if (e.media.track && e.media.track !== "inbound") return;
      const payload = String(e.media.payload);
      if (payload.length > 44000) throw new Error("oversized_audio");
      this.lastInputAt = now;
      this.inputFrames?.enqueue(payload, !this.liveReady);
    }
    if (e.event === "mark") this.playback?.mark(String(e.mark?.name));
    if (e.event === "dtmf")
      this.event("carrier.dtmf", { digit: e.dtmf?.digit });
    if (e.event === "stop" && !this.closing)
      this.ctx.waitUntil(this.stop("completed", "Carrier stream ended"));
  }
  private async openVoice() {
    const s = this.state();
    if (
      !(await this.env.OWNER.getByName("owner").permitted(s.principal.id)) ||
      s.status === "ending" ||
      terminal(s.status)
    )
      return;
    const ws = await connectLive(this.env);
    if (this.state().status === "ending" || terminal(this.state().status)) {
      ws.close(1000);
      return;
    }
    this.live = ws;
    s.liveOpenedAt = Date.now();
    this.save();
    ws.addEventListener("message", (e) => {
      try {
        this.onVoice(JSON.parse(String(e.data)));
      } catch {
        this.ctx.waitUntil(this.stop("uncertain", "Voice protocol error"));
      }
    });
    ws.addEventListener("close", (event) => {
      this.event("voice.closed", {
        code: event.code,
        clean: event.wasClean,
        requested: this.closing,
      });
      if (!this.closing)
        this.ctx.waitUntil(this.stop("uncertain", "Voice connection lost"));
    });
    ws.addEventListener("error", () => {
      if (!this.closing)
        this.ctx.waitUntil(this.stop("uncertain", "Voice transport error"));
    });
    ws.send(
      JSON.stringify({
        type: "session.start",
        session: {
          model: this.env.OPENAI_LIVE_MODEL,
          instructions: voiceInstructions(s.brief),
          input: [],
          audio: {
            format:
              this.env.AUDIO_CODEC === "PCMU"
                ? { type: "audio/pcmu" }
                : { type: "audio/pcm", rate: 16000 },
            output: { voice: "cedar" },
          },
          delegation: { type: "client" },
          store: false,
        },
      }),
    );
    this.timer = setInterval(() => {
      try {
        this.playback?.tick();
        if (this.liveReady && !this.closing && this.inputFrames)
          this.live?.send(
            JSON.stringify({
              type: "session.input_audio.append",
              audio: this.inputFrames.next(),
            }),
          );
        if (this.closeDeadline && Date.now() > this.closeDeadline)
          this.ctx.waitUntil(
            this.finish(
              s.pendingStop ?? "uncertain",
              "Voice close deadline reached",
            ),
          );
      } catch {
        this.ctx.waitUntil(this.stop("uncertain", "Media flow interrupted"));
      }
    }, 20);
  }
  private onVoice(e: Record<string, any>) {
    const s = this.state();
    if (e.type === "session.started") {
      const startupQueuedMs = this.inputFrames?.snapshot().queuedMs ?? 0;
      this.inputFrames?.startLive();
      this.liveReady = true;
      s.liveSessionId = e.session?.id;
      this.save();
      this.append("instructions", openingInstructions(s.brief));
      this.event("voice.started", {
        startupQueuedMs,
        retainedInputMs: this.inputFrames?.snapshot().queuedMs ?? 0,
      });
    } else if (e.type === "session.output_audio.delta" && !this.closing) {
      if (
        Date.now() >= this.ivrSilenceUntil &&
        !["pending", "sending"].includes(s.ivr?.status ?? "")
      )
        this.playback?.enqueue(e.delta);
    } else if (
      e.type === "session.input_transcript.delta" ||
      e.type === "session.output_transcript.delta"
    ) {
      const business = e.type === "session.input_transcript.delta";
      if (business) {
        this.observeIvr(String(e.delta));
        if (Date.now() - this.lastRecipientTextAt > 1500)
          this.recipientTurn = "";
        this.lastRecipientTextAt = Date.now();
        this.recipientTurn = (this.recipientTurn + String(e.delta)).slice(
          -1000,
        );
        this.assistantTurn = "";
        this.cancelTranscriptClose();
        s.conversationRevision = (s.conversationRevision ?? 0) + 1;
        this.businessTail = (this.businessTail + String(e.delta)).slice(-400);
        if (
          /\b(correction|i meant|actually,? (?:the|it|that))\b/i.test(
            this.businessTail,
          )
        ) {
          this.clearPlayback();
          this.append(
            "instructions",
            "The business is correcting earlier information. Listen to the correction; do not accept or repeat the superseded terms.",
          );
          this.businessTail = "";
          for (const operation of s.operations) {
            if (
              operation.kind === "spoken_commitment_authorization" &&
              operation.status === "succeeded"
            )
              operation.status = "failed";
          }
          this.event("conversation.correction", {
            conversationRevision: s.conversationRevision,
          });
        }
      } else {
        this.assistantTurn = (this.assistantTurn + String(e.delta)).slice(
          -1000,
        );
        this.recipientTurn = "";
        this.lastAssistantTextAt = Date.now();
        this.assistantTail = (this.assistantTail + String(e.delta)).slice(-400);
        const hasPermit = s.operations.some(
          (o) =>
            o.kind === "spoken_commitment_authorization" &&
            o.revision === s.revision &&
            o.status === "succeeded",
        );
        if (
          !hasPermit &&
          /\b(?:i|we)(?:'ve| have| will|(?:'ll)) (?:booked|purchased|accepted|confirmed|agree|accept|purchase|book)\b/i.test(
            this.assistantTail,
          )
        ) {
          this.clearPlayback();
          this.event("speech.guardrail", {
            reason: "Potential spoken commitment without a permit",
          });
          this.ctx.waitUntil(
            this.stop(
              "uncertain",
              "Potential unauthorized spoken commitment detected",
            ),
          );
        }
      }
      this.pendingTranscript.push({
        speaker: business ? "business" : "assistant",
        text: String(e.delta).slice(0, 10000),
        startMs: Number(e.start_ms) || 0,
        endMs: Number(e.end_ms) || 0,
        at: Date.now(),
        delivery: business ? "heard" : "generated_unverified",
      });
      if (this.pendingTranscript.length > 100) this.flushTranscript();
      if (business && recipientRequestsHangup(this.recipientTurn))
        this.scheduleTranscriptClose(true);
      if (!business && !this.transcriptClose?.recipient) {
        this.cancelTranscriptClose();
        if (assistantFarewell(this.assistantTurn))
          this.scheduleTranscriptClose(false);
      }
      if (
        business &&
        !this.voicemailHandling &&
        !this.closing &&
        s.brief.voicemail.action === "hangup" &&
        explicitVoicemailInvitation(this.businessTail)
      ) {
        this.voicemailHandling = true;
        this.event("voicemail.explicit_invitation", {});
        // Persist the transcript first. This is the already-authorized hangup
        // fallback, so it does not need another model request or delegation.
        this.ctx.waitUntil(
          Promise.resolve().then(() =>
            this.stop("completed", "Voicemail: configured to hang up"),
          ),
        );
      }
    } else if (e.type === "session.delegation.created" && !this.closing) {
      const id = e.delegation?.id;
      if (typeof id === "string" && e.delegation?.target === "client")
        this.ctx.waitUntil(this.delegate(id));
    } else if (
      e.type === "session.usage.updated" ||
      e.type === "session.closed"
    ) {
      if (Number.isFinite(e.usage?.seconds))
        s.liveSeconds = Math.max(s.liveSeconds, e.usage.seconds);
      s.usageAt = Date.now();
      if (e.type === "session.closed") {
        s.liveFinal = true;
        this.save();
        this.ctx.waitUntil(
          this.stop(s.pendingStop ?? "completed", "Voice session closed"),
        );
      }
    } else if (e.type === "error") {
      this.clearPlayback();
      this.event("voice.error", { code: String(e.error?.code ?? "unknown") });
      this.ctx.waitUntil(
        this.stop("uncertain", "Voice provider rejected a command"),
      );
    } else if (String(e.type).endsWith(".appended")) {
      const start = this.appendEvents.get(e.client_event_id);
      if (start) {
        this.appendEvents.delete(e.client_event_id);
        this.event("context.acknowledged", {
          eventId: e.client_event_id,
          latencyMs: Date.now() - start,
        });
      }
    }
  }
  private append(
    kind: "thinking" | "commentary" | "instructions",
    content: string,
    delegationId?: string,
  ) {
    if (!this.liveReady || this.closing) return;
    for (const chunk of contextChunks(content)) {
      const id = crypto.randomUUID();
      this.appendEvents.set(id, Date.now());
      if (this.appendEvents.size > 100)
        this.appendEvents.delete(this.appendEvents.keys().next().value!);
      try {
        this.live?.send(
          JSON.stringify({
            type: `session.${kind}.append`,
            event_id: id,
            delegation_id: delegationId ?? null,
            content: chunk,
          }),
        );
      } catch {
        // Context may be committed inside a SQL transaction. A socket failure
        // must not roll it back while leaving the in-memory revision changed.
        this.ctx.waitUntil(
          Promise.resolve().then(() =>
            this.stop("uncertain", "Voice context delivery failed"),
          ),
        );
        return;
      }
    }
  }
  private clearPlayback() {
    try {
      this.playback?.clear();
    } catch {}
  }
  private cancelTranscriptClose() {
    if (this.transcriptClose) clearTimeout(this.transcriptClose.timer);
    this.transcriptClose = undefined;
  }
  private scheduleTranscriptClose(recipient: boolean) {
    if (this.closing || this.gracefulClosing) return;
    this.cancelTranscriptClose();
    const timer = setTimeout(() => {
      this.transcriptClose = undefined;
      if (this.closing || terminal(this.state().status)) return;
      this.event("call.closing_fallback", {
        trigger: recipient ? "recipient_request" : "assistant_farewell",
      });
      if (recipient)
        this.append(
          "instructions",
          "The recipient explicitly asked to end this call. Say a brief goodbye now, without asking anything else. Do not announce internal actions.",
        );
      this.ctx.waitUntil(
        this.gracefulHangup(!recipient, recipient ? 1500 : 500),
      );
    }, 750);
    this.transcriptClose = { timer, recipient };
  }
  private observeIvr(delta: string) {
    const s = this.state();
    if (s.brief.ivr?.mode === "off" || this.closing) return;
    const now = Date.now();
    // New recipient speech invalidates a settled prompt before async reasoning
    // or an originating-agent command can act on the previous menu.
    if (s.ivr?.status === "pending") {
      s.ivr.status = "expired";
      this.save();
    }
    if (now - this.ivrTextAt > 4000) this.ivrText = "";
    this.ivrTextAt = now;
    this.ivrText = (this.ivrText + delta).slice(-2400);
    if (this.ivrTimer) clearTimeout(this.ivrTimer);
    if (parseIvr(this.ivrText)) {
      this.ivrSilenceUntil = now + 2500;
      this.clearPlayback();
    }
    this.ivrTimer = setTimeout(() => {
      this.ivrTimer = undefined;
      this.flushTranscript();
      this.publishIvr(this.ivrText);
    }, 1200);
  }
  private publishIvr(prompt: string) {
    const s = this.state();
    if (this.closing || terminal(s.status) || s.brief.ivr?.mode === "off")
      return;
    const parsed = parseIvr(prompt);
    if (!parsed) {
      if (s.ivr?.status === "pending") {
        s.ivr.status = "expired";
        this.save();
      }
      return;
    }
    const previous = s.ivr;
    if (
      previous &&
      (previous.kind === "menu" && parsed.kind === "menu"
        ? JSON.stringify(
            previous.options.map((o) => [o.digits, normalizeIvr(o.label)]),
          ) ===
          JSON.stringify(
            parsed.options.map((o) => [o.digits, normalizeIvr(o.label)]),
          )
        : normalizeIvr(previous.prompt) === normalizeIvr(prompt))
    ) {
      if (previous.status === "pending") return;
      if (["sent", "uncertain", "sending"].includes(previous.status)) {
        this.requestDecision(
          "The phone menu repeated after a keypad command. Please decide how to proceed.",
          "The service will not resend an ambiguous command automatically. You may provide context or end this call.",
          [],
        );
        return;
      }
    }
    const menu: IvrMenu = {
      id: crypto.randomUUID(),
      mode:
        s.brief.mode === "simulation"
          ? "assisted"
          : s.brief.ivr?.mode === "assisted"
            ? "assisted"
            : "auto",
      prompt: prompt.slice(-2400),
      ...parsed,
      revision: s.revision,
      observedAt: Date.now(),
      expiresAt: Date.now() + 30000,
      status: "pending",
    };
    s.ivr = menu;
    for (const d of s.decisions)
      if (d.status === "pending" && d.ivrMenuId && d.ivrMenuId !== menu.id)
        d.status = "superseded";
    this.save();
    this.event("ivr.menu", { menu });
    this.clearPlayback();
    this.append(
      "instructions",
      "An automated keypad prompt is active. Stay silent while the backend sends real DTMF. Do not say the digit or announce progress. Listen for the next prompt or a human greeting.",
    );
    if (s.brief.mode === "simulation" || s.brief.ivr?.mode === "assisted")
      return;
    this.ctx.waitUntil(this.navigateIvr(menu.id));
  }
  private async navigateIvr(menuId: string) {
    const s = this.state(),
      menu = s.ivr;
    if (!menu || menu.id !== menuId || menu.status !== "pending") return;
    const digits = selectIvrOption(menu, s.brief);
    if (digits) {
      try {
        await this.keypad(
          { expectedRevision: s.revision, menuId, digits },
          `auto:${menuId}`,
        );
      } catch (error) {
        this.event("ivr.action_rejected", {
          code: error instanceof ApiError ? error.code : "invalid_action",
        });
      }
    } else await this.delegate(`ivr:${menuId}`);
  }
  async keypad(body: unknown, key: string) {
    const request = KeypadSchema.parse(body),
      hash = await digest(JSON.stringify(request));
    const s = this.state();
    const receiptKey = `keypad:${key}`;
    const prior = this.db.get<{ hash: string; operationId: string }>(
      receiptKey,
    );
    if (prior) {
      if (prior.hash !== hash)
        throw new ApiError(
          409,
          "idempotency_conflict",
          "Idempotency key has different content",
        );
      const op = s.operations.find((o) => o.id === prior.operationId);
      return {
        operationId: prior.operationId,
        status: op?.status ?? "uncertain",
        simulated: s.brief.mode === "simulation",
      };
    }
    if (!(await this.env.OWNER.getByName("owner").permitted(s.principal.id)))
      throw new ApiError(
        403,
        "calling_disabled",
        "Call credential revoked or service stopped",
      );
    const concurrent = this.db.get<{ hash: string; operationId: string }>(
      receiptKey,
    );
    if (concurrent) {
      if (concurrent.hash !== hash)
        throw new ApiError(
          409,
          "idempotency_conflict",
          "Idempotency key has different content",
        );
      return {
        operationId: concurrent.operationId,
        status:
          s.operations.find((o) => o.id === concurrent.operationId)?.status ??
          "uncertain",
        simulated: s.brief.mode === "simulation",
      };
    }
    const menu = s.ivr;
    if (
      s.status !== "active" ||
      this.closing ||
      s.revision !== request.expectedRevision ||
      !menu ||
      menu.id !== request.menuId ||
      menu.revision !== s.revision ||
      menu.status !== "pending" ||
      menu.expiresAt <= Date.now()
    )
      throw new ApiError(
        409,
        "stale_menu",
        "Fetch the current call: this menu expired, changed, or was already handled",
      );
    if (s.brief.ivr?.mode === "off")
      throw new ApiError(
        403,
        "keypad_disabled",
        "Keypad navigation is disabled for this call",
      );
    if (s.operations.filter((o) => o.kind === "dtmf").length >= 20)
      throw new ApiError(
        429,
        "keypad_limit",
        "At most 20 keypad commands per call",
      );
    validateKeypad(menu, request.digits, s.brief, request.factId);
    if (s.brief.mode === "live" && !s.telnyxId)
      throw new ApiError(
        409,
        "carrier_unavailable",
        "Carrier is not connected",
      );
    const operationId = crypto.randomUUID();
    // Commit intent and receipt atomically before the external side effect. A crash
    // leaves an uncertain intent that must never be automatically resent.
    this.ctx.storage.transactionSync(() => {
      s.operations.push({
        id: operationId,
        kind: "dtmf",
        status: "intent",
        revision: s.revision,
        at: Date.now(),
      });
      menu.status = "sending";
      menu.operationId = operationId;
      menu.digitCount = request.digits.length;
      this.save();
      this.db.put(receiptKey, { hash, operationId });
      this.event("ivr.keypad_requested", {
        menuId: menu.id,
        operationId,
        digitCount: request.digits.length,
        simulated: s.brief.mode === "simulation",
      });
    });
    this.clearPlayback();
    this.ivrSilenceUntil = Date.now() + request.digits.length * 300 + 500;
    // The next menu can begin immediately after a key. Never carry options
    // from the previous level into that prompt's transcript buffer.
    this.ivrText = "";
    this.ivrTextAt = 0;
    const op = s.operations.find((o) => o.id === operationId)!;
    try {
      if (s.brief.mode === "live")
        await sendDigits(this.env, s.telnyxId!, request.digits, operationId);
      op.status = "succeeded";
      menu.status = "sent";
      for (const d of s.decisions)
        if (d.status === "pending" && d.ivrMenuId === menu.id)
          d.status = "superseded";
      this.event("ivr.keypad_accepted", {
        menuId: menu.id,
        operationId,
        digitCount: request.digits.length,
        simulated: s.brief.mode === "simulation",
      });
      this.append(
        "thinking",
        "The carrier accepted the keypad command. Stay silent and listen for the next menu or a person. Command acceptance does not prove menu traversal or a completed business action.",
      );
    } catch (error) {
      const rejected =
        error instanceof ApiError && error.code === "carrier_rejected";
      op.status = rejected ? "failed" : "uncertain";
      menu.status = rejected ? "failed" : "uncertain";
      this.event("ivr.keypad_failed", {
        menuId: menu.id,
        operationId,
        status: op.status,
      });
      this.requestDecision(
        "The keypad command could not be confirmed. How should I continue?",
        "No automatic repeat will be sent.",
        [],
      );
    }
    this.save();
    if (
      s.brief.mode === "simulation" &&
      s.brief.simulation?.scenario === "ivr" &&
      op.status === "succeeded"
    ) {
      const count = s.operations.filter(
        (o) => o.kind === "dtmf" && o.status === "succeeded",
      ).length;
      if (count === 1 && request.digits === "2") {
        this.publishIvr(
          "Please enter your reference number followed by the pound key.",
        );
      } else {
        const passed = count === 2 && request.digits === "6204#";
        if (passed)
          s.confirmedDetails.push(
            "Synthetic IVR reached scheduling and accepted the fixture reference.",
          );
        this.event(
          passed ? "ivr.simulation_completed" : "ivr.simulation_failed",
          { commands: count },
        );
        await this.stop(
          "completed",
          passed
            ? "Synthetic IVR keypad scenario completed; no carrier or voice model was called."
            : "Synthetic IVR selected an incorrect route or reference; no carrier or voice model was called.",
        );
      }
    }
    await this.schedule();
    return {
      operationId,
      status: op.status,
      simulated: s.brief.mode === "simulation",
    };
  }
  private async delegate(id: string, tier: ModelTier = "routine") {
    const s = this.state();
    if (this.closing || terminal(s.status)) return;
    if (this.backendBusy) {
      this.queuedDelegation = id;
      return;
    }
    this.backendBusy = true;
    const revision = s.revision;
    const conversationRevision = s.conversationRevision ?? 0;
    this.flushTranscript();
    const input = modelContext(
        s.brief,
        this.transcripts(),
        revision,
        s.decisions
          .filter((d) => d.status === "answered")
          .map(({ question, answer }) => ({ question, answer })),
        16000,
        s.ivr,
      ),
      reserve = maxModelCost(input, tier);
    const ivrId = s.ivr?.status === "pending" ? s.ivr.id : undefined;
    const opId = `reason:${id}:${tier}:${revision}:${conversationRevision}`;
    try {
      if (s.operations.some((o) => o.id === opId)) return;
      if (!(await this.env.OWNER.getByName("owner").permitted(s.principal.id)))
        return;
      if (s.revision !== revision || this.closing || terminal(s.status)) return;
      if (
        s.modelRequests >= 30 ||
        s.backendCents + s.backendReservedCents + reserve >
          s.brief.limits.backendCents
      ) {
        this.requestDecision(
          "Backend reasoning budget reached. Should this call end?",
          "No further model requests will be made.",
          ["End without booking"],
        );
        await this.schedule();
        return;
      }
      s.modelRequests++;
      s.backendReservedCents += reserve;
      s.operations.push({
        id: opId,
        kind: `reason.${tier}`,
        status: "intent",
        revision,
        at: Date.now(),
      });
      this.save();
      const began = Date.now();
      const result = await reason(this.env, input, tier);
      s.backendReservedCents -= reserve;
      s.backendCents += result.cost ?? reserve;
      const op = s.operations.find((o) => o.id === opId)!;
      op.status = "succeeded";
      this.save();
      this.event("reasoning.completed", {
        tier,
        action: result.output.action,
        latencyMs: Date.now() - began,
        costCents: result.cost ?? reserve,
      });
      if (
        s.revision !== revision ||
        ((s.conversationRevision ?? 0) !== conversationRevision &&
          !(
            result.output.action === "dtmf" &&
            ivrId &&
            s.ivr?.id === ivrId &&
            s.ivr.status === "pending"
          )) ||
        this.closing ||
        terminal(s.status)
      ) {
        this.event("reasoning.discarded", { id, revision });
        if (!this.closing && !terminal(s.status)) this.queuedDelegation = id;
        return;
      }
      if (result.output.action === "escalate" && tier === "routine") {
        this.backendBusy = false;
        await this.delegate(id, "deep");
        return;
      }
      await this.applyReasoning(result.output, id);
    } catch {
      const op = s.operations.find((o) => o.id === opId);
      if (op?.status === "intent") {
        op.status = "uncertain";
        this.save();
      }
      if (!terminal(s.status) && !this.closing)
        this.requestDecision(
          "The backend could not complete its decision. How should I continue?",
          "Model request failed or timed out; any reserved cost remains held.",
          ["End without booking"],
        );
    } finally {
      this.backendBusy = false;
      await this.schedule();
      const queued = this.queuedDelegation;
      this.queuedDelegation = undefined;
      if (queued && !this.closing && !terminal(s.status))
        this.ctx.waitUntil(this.delegate(queued));
    }
  }
  private evidence(quotes: string[]) {
    const transcript = this.transcripts()
      .filter((t) => t.speaker === "business")
      .map((t) => t.text)
      .join("");
    return (
      quotes.length > 0 &&
      quotes.every((q) => q.length >= 5 && transcript.includes(q))
    );
  }
  private async applyReasoning(r: ReasoningOutput, delegationId: string) {
    const s = this.state();
    switch (r.action) {
      case "calculate": {
        const values = Object.fromEntries(r.terms.map((t) => [t.key, t.value]));
        const source = [
          ...s.brief.facts
            .filter(
              (f) => f.visibility === "shareable" && r.factIds.includes(f.id),
            )
            .map((f) => f.text),
          ...(this.evidence(r.evidenceQuotes) ? r.evidenceQuotes : []),
        ].join(" ");
        const numbers: string[] = source.match(/-?\d+(?:\.\d+)?/g) ?? [];
        if (!numbers.includes(values.left) || !numbers.includes(values.right))
          break;
        try {
          const result = calculate(values.operator, values.left, values.right);
          this.append(
            "thinking",
            `Verified calculation: ${values.left} ${values.operator} ${values.right} = ${result} (rounded to six decimal places). This is arithmetic only, not authorization or proof of an action.`,
            delegationId,
          );
          this.event("calculation.completed", { operator: values.operator });
        } catch {
          this.append(
            "thinking",
            "The calculation could not be verified. Clarify its operands; do not invent a result.",
            delegationId,
          );
        }
        break;
      }
      case "advise":
        if (
          r.guidance &&
          (this.evidence(r.evidenceQuotes) ||
            r.factIds.some((id) =>
              s.brief.facts.some(
                (f) => f.id === id && f.visibility === "shareable",
              ),
            ))
        ) {
          this.append(
            "thinking",
            `Backend conversation guidance: ${r.guidance}. This is not permission to make a commitment, reveal new private facts, or claim an action succeeded. All existing authority checks still apply.`,
            delegationId,
          );
        }
        break;
      case "supply_facts":
        for (const id of r.factIds) {
          const fact = s.brief.facts.find(
            (f) => f.id === id && f.visibility === "shareable",
          );
          if (fact)
            this.append("thinking", `${fact.id}: ${fact.text}`, delegationId);
        }
        break;
      case "ask_origin":
      case "escalate":
        this.requestDecision(
          r.question || "Additional information is needed.",
          "Question based on the current business conversation.",
          r.choices,
          delegationId,
        );
        break;
      case "commit": {
        const approved = s.brief.authorizedCommitments.find(
          (c) => c.id === r.commitmentId,
        );
        const terms = Object.fromEntries(r.terms.map((t) => [t.key, t.value]));
        if (
          !approved ||
          !s.principal.allowCommitments ||
          approved.maxAmountCents > s.principal.maxCommitmentCents ||
          Object.keys(approved.terms).length !== r.terms.length ||
          !Object.entries(approved.terms).every(
            ([k, v]) => terms[k] === String(v),
          ) ||
          !this.evidence(r.evidenceQuotes)
        ) {
          this.requestDecision(
            "The offered terms do not match an authorized commitment. Should I collect more information or end the call?",
            "No commitment has been authorized.",
            ["Collect information", "End without booking"],
            delegationId,
          );
          break;
        }
        const key = `commit:${approved.id}:${s.revision}:${s.conversationRevision ?? 0}`;
        if (s.operations.some((o) => o.id === key)) break;
        s.operations.push({
          id: key,
          kind: "spoken_commitment_authorization",
          revision: s.revision,
          status: "succeeded",
          at: Date.now(),
          result: { terms: approved.terms, evidence: r.evidenceQuotes },
        });
        this.save();
        this.event("commitment.authorized", {
          id: approved.id,
          revision: s.revision,
          terms: approved.terms,
        });
        this.append(
          "commentary",
          `You may accept ONLY these approved terms: ${JSON.stringify(approved.terms)}. Read them back and obtain explicit business confirmation.`,
          delegationId,
        );
        break;
      }
      case "dtmf": {
        if (s.ivr && ["sent", "sending", "uncertain"].includes(s.ivr.status)) {
          this.append(
            "thinking",
            "This keypad prompt was already handled or has an uncertain command. Do not send it again. Listen for a new prompt.",
            delegationId,
          );
          break;
        }
        try {
          if (!s.ivr || s.ivr.status !== "pending")
            throw new ApiError(409, "no_pending_menu", "No current IVR prompt");
          await this.keypad(
            {
              expectedRevision: s.revision,
              menuId: s.ivr.id,
              digits: r.digits,
              factId: r.factIds?.[0],
            },
            `backend:${s.ivr.id}`,
          );
        } catch (error) {
          this.event("ivr.action_rejected", {
            code: error instanceof ApiError ? error.code : "invalid_action",
          });
          this.append(
            "thinking",
            "No keypad command was sent. Use the current offered menu options, or ask the originating agent for help.",
            delegationId,
          );
          this.requestDecision(
            "The phone menu needs a valid keypad selection.",
            s.ivr?.prompt ?? "No current menu is available.",
            [],
            delegationId,
          );
        }
        break;
      }
      case "voicemail":
        if (this.evidence(r.evidenceQuotes)) await this.voicemail();
        break;
      case "hangup":
        await this.gracefulHangup();
        break;
      case "confirm_outcome":
        if (this.evidence(r.evidenceQuotes)) {
          s.confirmedDetails.push(...r.evidenceQuotes);
          s.confirmedDetails = s.confirmedDetails.slice(-30);
          this.save();
          this.event("outcome.evidence", { quotes: r.evidenceQuotes });
        }
        break;
      case "wait":
        break;
    }
  }
  private async gracefulHangup(deferForNewSpeech = true, minimumMs = 500) {
    if (this.gracefulClosing || this.closing) return;
    this.gracefulClosing = true;
    try {
      const s = this.state();
      const started = Date.now(),
        revision = s.conversationRevision ?? 0;
      let checkpoint: ReturnType<Playback["checkpoint"]> | undefined;
      let checkpointTextAt = -1;
      this.event("call.closing_requested", {});
      // Finish already generated farewell speech before clearing carrier audio.
      // This is a bounded grace period, not an assertion that text was delivered.
      while (Date.now() - started < 5000) {
        if (this.closing || terminal(s.status)) return;
        if (
          (s.conversationRevision ?? 0) !== revision &&
          (deferForNewSpeech ||
            /\b(?:wait|don't|do not|actually)\b/i.test(this.recipientTurn))
        ) {
          this.event("call.closing_deferred", {
            reason: "The other party spoke again",
          });
          this.append(
            "instructions",
            "The other person spoke again. Address any new request; if they are only saying goodbye, finish the call using backend hangup. Do not discuss internal tools.",
          );
          return;
        }
        if (
          Date.now() - started >= minimumMs &&
          Date.now() - this.lastAssistantTextAt >= 1200
        ) {
          if (!checkpoint || checkpointTextAt !== this.lastAssistantTextAt) {
            checkpoint = this.playback?.checkpoint();
            checkpointTextAt = this.lastAssistantTextAt;
          }
          // Future continuous silence must not keep the call open. Only await
          // audio already queued after the final text became quiet.
          if (!checkpoint || this.playback?.acknowledged(checkpoint)) break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      await this.stop("completed", "Conversation ended");
    } finally {
      this.gracefulClosing = false;
    }
  }
  private async voicemail() {
    const s = this.state();
    if (s.brief.voicemail.action === "hangup")
      await this.stop("completed", "Voicemail: configured to hang up");
    else {
      this.append(
        "instructions",
        `An answering machine was detected. Wait for the tone, then say only this authorized message: ${s.brief.voicemail.message}. Request delegation to end the call after the message.`,
      );
      this.event("voicemail.message_requested", {});
    }
  }
  async stop(status: Status, reasonText: string) {
    this.cancelTranscriptClose();
    const s = this.state();
    if (terminal(s.status) && s.result) {
      if (!s.ownerSettled) await this.settle();
      return;
    }
    if (s.status === "ending" && this.closing) return;
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    s.pendingStop ??= status;
    s.status = "ending";
    this.clearPlayback();
    this.flushTranscript();
    if (this.live && !s.liveFinal) {
      try {
        this.live.send(JSON.stringify({ type: "session.close" }));
        this.closeDeadline = Date.now() + 15000;
        this.ctx.waitUntil(
          new Promise<void>((resolve) =>
            setTimeout(() => {
              // Socket cleanup never proves carrier termination or releases its reservation.
              this.shutdown();
              resolve();
            }, 15000),
          ),
        );
      } catch {}
    }
    if (s.testPeer) {
      s.testPeer.due = 0;
      this.ctx.waitUntil(
        hangup(this.env, s.testPeer.callId, `${s.id}:test-end`).catch(() => {}),
      );
    }
    this.save();
    this.event("call.stopping", { reason: reasonText });
    if (s.brief.mode === "simulation") return this.finish(status, reasonText);
    if (s.telnyxId) {
      if (s.hangupAttempts === 0) {
        s.hangupAttempts++;
        s.nextRecoveryAt = Date.now() + 10000;
        this.save();
        try {
          await hangup(this.env, s.telnyxId, `${s.id}:hangup`);
        } catch {
          this.event("hangup.uncertain", {});
        }
      }
    } else if (s.operations.some((o) => o.kind === "dial")) {
      s.nextRecoveryAt = Date.now() + 10000;
      this.event("reconciliation.required", {
        reason:
          "Carrier dial ID is unknown; reservation and concurrency remain held",
      });
    } else return this.finish(status, reasonText);
    await this.schedule();
  }
  private async recoverStop() {
    const s = this.state();
    if (s.telnyxId) {
      try {
        const result = await callStatus(this.env, s.telnyxId);
        if (result.data.is_alive === false)
          return this.finish(
            s.pendingStop ?? "uncertain",
            "Carrier confirms call is no longer alive",
          );
        if (s.hangupAttempts < 3) {
          s.hangupAttempts++;
          this.save();
          await hangup(this.env, s.telnyxId, `${s.id}:hangup`);
        }
      } catch {}
    }
    if (Date.now() > s.maxEndAt + 120000) {
      s.nextRecoveryAt = undefined;
      this.event("reconciliation.required", {
        reason:
          "Manual carrier reconciliation is required; concurrency and reservation remain held",
      });
      this.shutdown();
      this.save();
      return;
    }
    s.nextRecoveryAt = Date.now() + 15000;
    this.save();
  }
  private async finish(status: Status, reasonText: string) {
    const s = this.state();
    if (terminal(s.status) && s.result) {
      if (!s.ownerSettled) await this.settle();
      return;
    }
    if (
      s.brief.mode === "live" &&
      this.live &&
      !s.liveFinal &&
      !this.closeDeadline
    ) {
      this.closing = true;
      this.live.send(JSON.stringify({ type: "session.close" }));
      this.closeDeadline = Date.now() + 15000;
    }
    // Carrier is confirmed stopped here. Voice finalization remains provisional until session.closed.
    this.closing = true;
    s.status = status;
    s.endedAt ??= Date.now();
    s.nextRecoveryAt = undefined;
    this.flushTranscript();
    s.costFinal =
      s.brief.mode === "simulation" || s.reconciledCents !== undefined;
    s.retainUntil =
      s.endedAt + Number(this.env.TRANSCRIPT_RETENTION_DAYS) * 86400000;
    for (const d of s.decisions)
      if (d.status === "pending") d.status = "expired";
    const confirmed = s.confirmedDetails.length > 0;
    s.result = {
      finalized: s.brief.mode === "simulation" || !s.liveSessionId,
      outcome:
        status === "uncertain"
          ? "uncertain"
          : confirmed
            ? "partially_completed"
            : "unsuccessful",
      summary:
        s.brief.mode === "simulation"
          ? `Simulation ended: ${reasonText}`
          : reasonText,
      confirmedDetails: s.confirmedDetails,
      remainingQuestions: s.decisions
        .filter((d) => d.status !== "answered")
        .map((d) => d.question),
      evidenceReferences: s.operations
        .filter((o) => o.status === "succeeded")
        .map((o) => o.id),
      cost: { cents: estimatedCost(s), final: s.costFinal },
    };
    if (s.brief.mode === "simulation") {
      s.result.outcome = (
        s.brief.simulation?.scenario === "ivr"
          ? s.confirmedDetails.length > 0
          : s.decisions.some((d) => d.status === "answered")
      )
        ? "completed"
        : "unsuccessful";
    }
    this.save();
    this.event("call.ended", { status, result: s.result });
    this.enqueueCallback("call.ended", { status, result: s.result });
    await this.settle();
    if (s.brief.mode === "live") this.ctx.waitUntil(this.finalSummary());
    if (!this.live || s.liveFinal) this.shutdown();
    else
      this.ctx.waitUntil(
        new Promise<void>((resolve) =>
          setTimeout(() => {
            this.shutdown();
            resolve();
          }, 15000),
        ),
      );
    await this.schedule();
  }
  private async finalSummary() {
    const s = this.state();
    if (s.summaryDone || !s.result || !s.liveSessionId) return;
    if (!(await this.env.OWNER.getByName("owner").permitted(s.principal.id))) {
      this.publishResult(
        "The call ended. Final summary generation was skipped because calling authorization was revoked.",
      );
      return;
    }
    if (s.summaryDone) return;
    s.summaryDone = true;
    const transcript = this.transcripts(1000),
      input = JSON.stringify({
        conversation: JSON.parse(
          modelContext(s.brief, transcript, s.revision, [], 64000),
        ),
        verifiedApplicationState: {
          carrierStopped: terminal(s.status),
          confirmedDetails: s.confirmedDetails,
          playback: this.playback?.snapshot() ?? this.db.get("playback"),
        },
      }),
      reserved = maxModelCost(input, "summary");
    if (
      s.backendCents + s.backendReservedCents + reserved >
        s.brief.limits.backendCents ||
      s.modelRequests >= 30
    ) {
      this.publishResult(
        "The call ended. The remaining reasoning allowance did not cover a verified final summary.",
      );
      return;
    }
    s.backendReservedCents += reserved;
    s.modelRequests++;
    const id = `summary:${s.id}`;
    s.operations.push({
      id,
      kind: "summary",
      revision: s.revision,
      at: Date.now(),
      status: "intent",
    });
    this.save();
    try {
      const { output, cost } = await summarize(this.env, input);
      s.backendReservedCents -= reserved;
      s.backendCents += cost ?? reserved;
      s.operations.find((o) => o.id === id)!.status = "succeeded";
      const business = transcript
        .filter((t) => t.speaker === "business")
        .map((t) => t.text)
        .join("");
      const supported = output.criteria.filter(
        (c) =>
          c.met &&
          c.businessQuote.length >= 5 &&
          business.includes(c.businessQuote) &&
          c.criterionIndex >= 0 &&
          c.criterionIndex < s.brief.successCriteria.length,
      );
      const allMet =
        new Set(supported.map((c) => c.criterionIndex)).size ===
        s.brief.successCriteria.length;
      const uncertain =
        s.status === "uncertain" ||
        s.operations.some((o) => o.status === "uncertain");
      s.result!.outcome = uncertain
        ? "uncertain"
        : allMet
          ? "completed"
          : supported.length
            ? "partially_completed"
            : "unsuccessful";
      s.result!.summary = output.summary;
      s.result!.confirmedDetails = supported.map((c) => c.businessQuote);
      s.result!.remainingQuestions = [
        ...new Set([
          ...s.result!.remainingQuestions,
          ...output.remainingQuestions,
        ]),
      ];
      s.result!.evidenceReferences.push(id);
      s.result!.cost = { cents: estimatedCost(s), final: false };
      this.publishResult();
    } catch {
      s.operations.find((o) => o.id === id)!.status = "uncertain";
      this.event("summary.unavailable", {});
      this.publishResult(
        "The call ended, but the final summary could not be verified. Review the transcript and verified details.",
      );
    }
    this.save();
    await this.settle();
    await this.schedule();
  }
  private publishResult(unavailable?: string) {
    const s = this.state();
    if (!s.result) return;
    if (unavailable) {
      s.result.summary = unavailable;
      s.result.outcome = "uncertain";
    }
    s.result.finalized = true;
    this.save();
    this.event("result.updated", { result: s.result });
    this.enqueueCallback("result.updated", { result: s.result });
  }
  private shutdown() {
    this.cancelTranscriptClose();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.playback) this.db.put("playback", this.playback.snapshot());
    try {
      this.media?.close(1000, "Call ended");
      this.live?.close(1000, "Call ended");
    } catch {}
    this.live = undefined;
    this.media = undefined;
    this.liveReady = false;
  }
  private async settle() {
    const s = this.state();
    await this.env.OWNER.getByName("owner").settle(
      s.id,
      estimatedCost(s),
      s.startedAt ? ((s.endedAt ?? Date.now()) - s.startedAt) / 60000 : 0,
      s.costFinal,
      s.status,
      s.endedAt ?? Date.now(),
    );
    s.ownerSettled = true;
    this.save();
  }
  async reconcile(
    confirmedStopped: boolean,
    costCents: number,
    key: string = crypto.randomUUID(),
  ) {
    const receipt = this.db.get<{
      confirmedStopped: boolean;
      costCents: number;
      done: boolean;
    }>(`reconcile:${key}`);
    if (receipt) {
      if (
        receipt.costCents !== costCents ||
        receipt.confirmedStopped !== confirmedStopped
      )
        throw new ApiError(
          409,
          "idempotency_conflict",
          "Reconciliation key has different content",
        );
      if (receipt.done) return publicState(this.state());
    }
    const s = this.state();
    if (!confirmedStopped)
      throw new ApiError(
        422,
        "confirmation_required",
        "Carrier stop must be confirmed",
      );
    this.db.put(`reconcile:${key}`, {
      confirmedStopped,
      costCents,
      done: false,
    });
    if (!terminal(s.status)) {
      s.pendingStop = "uncertain";
      await this.finish("uncertain", "Owner confirmed carrier termination");
    }
    s.costFinal = true;
    s.reconciledCents = costCents;
    if (s.result) s.result.cost = { cents: costCents, final: true };
    this.save();
    await this.env.OWNER.getByName("owner").reconcile(s.id, costCents);
    this.event("cost.reconciled", { costCents });
    this.db.put(`reconcile:${key}`, {
      confirmedStopped,
      costCents,
      done: true,
    });
    return publicState(s);
  }
  private enqueueCallback(type: string, data: unknown) {
    const s = this.state();
    if (!s.brief.callbackId || !this.env.CALLBACK_SIGNING_KEY) return;
    if (this.db.list("callback:", 33).length >= 32) {
      this.event("callback.queue_full", {});
      return;
    }
    this.db.put(`callback:${String(this.seq).padStart(10, "0")}`, {
      type,
      data,
      eventId: `${s.id}:${this.seq}`,
      attempts: 0,
    });
    s.nextCallbackAt = Date.now();
    this.save();
  }
  private async deliverCallback() {
    const s = this.state();
    s.nextCallbackAt = undefined;
    if (!s.brief.callbackId || !this.env.CALLBACK_SIGNING_KEY) return;
    const message = this.db.list<{
      type: string;
      data: unknown;
      eventId: string;
      attempts: number;
    }>("callback:", 1)[0];
    if (!message) return;
    const target = await this.env.OWNER.getByName("owner").callback(
      s.brief.callbackId,
    );
    if (!target?.verified) return;
    const item = message.value;
    item.attempts++;
    this.db.put(message.key, item);
    this.save();
    const timestamp = String(Math.floor(Date.now() / 1000)),
      body = JSON.stringify({
        type: item.type,
        callId: s.id,
        eventId: item.eventId,
        data: item.data,
      });
    try {
      const signature = await hmac(
        this.env.CALLBACK_SIGNING_KEY,
        `${timestamp}.${body}`,
      );
      const response = await fetch(target.url, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-calling-timestamp": timestamp,
          "x-calling-signature": signature,
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("callback_failed");
      this.db.remove(message.key);
      this.event("callback.delivered", { eventId: item.eventId });
    } catch {
      if (item.attempts >= 3) {
        this.db.remove(message.key);
        this.event("callback.failed", { eventId: item.eventId });
      } else s.nextCallbackAt = Date.now() + 10000 * 2 ** item.attempts;
    }
    if (!s.nextCallbackAt && this.db.list("callback:", 1).length)
      s.nextCallbackAt = Date.now() + 1000;
    this.save();
  }
}
