import { DurableObject } from "cloudflare:workers";
import {
  ApiError,
  authorizeBrief,
  CredentialSchema,
  CredentialUpdateSchema,
  reservation,
  type CallBrief,
  type Principal,
  type Status,
} from "./domain";
import { Store } from "./storage";
import { digest, randomToken, liveReady, liveAllowed } from "./security";
type Credential = {
  principal: Principal;
  hash: string;
  expires: number;
  revoked: boolean;
  name: string;
};
type Entry = {
  id: string;
  principalId: string;
  status: Status;
  mode: string;
  createdAt: number;
  month: string;
  day: string;
  billingMonths?: string[];
  usageDays?: string[];
  reserved: number;
  charged: number;
  minutes: number;
  settled: boolean;
  final: boolean;
  deleted?: boolean;
  finalizingUntil?: number;
};
type Config = {
  kill: boolean;
  draining: boolean;
  callbacks: Record<string, { url: string; verified: boolean }>;
};
export class OwnerController extends DurableObject<Env> {
  private db: Store;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new Store(ctx.storage.sql);
  }
  private config() {
    return (
      this.db.get<Config>("config") ?? {
        kill: false,
        draining: false,
        callbacks: {},
      }
    );
  }
  async authenticate(token: string): Promise<Principal | null> {
    const [id] = token.split(".");
    if (!id || id.length > 60) return null;
    const hash = await digest(token);
    const c = this.db.get<Credential>(`credential:${id}`);
    if (!c || c.revoked || c.expires <= Date.now() || hash !== c.hash)
      return null;
    return c.principal;
  }
  async activeCredential(id: string, revision?: number) {
    if (id === "owner") return true;
    const c = this.db.get<Credential>(`credential:${id}`);
    return (
      !!c &&
      !c.revoked &&
      c.expires > Date.now() &&
      (revision === undefined ||
        (c.principal.credentialRevision ?? 1) === revision)
    );
  }
  async issue(input: unknown, key: string = crypto.randomUUID()) {
    const data = CredentialSchema.parse(input);
    const hash = await digest(JSON.stringify(data));
    const prior = this.db.get<{ hash: string; id: string }>(`issue:${key}`);
    if (prior)
      throw new ApiError(
        409,
        prior.hash === hash
          ? "credential_already_issued"
          : "idempotency_conflict",
        prior.hash === hash
          ? `Credential ${prior.id} was already issued. Its secret is returned once; revoke it before creating a replacement.`
          : "Key already used for different credential permissions",
      );
    const id = crypto.randomUUID(),
      token = `${id}.${randomToken()}`;
    const principal: Principal = {
      id,
      credentialRevision: 1,
      owner: false,
      scopes: data.scopes,
      live: data.live,
      destinations: data.destinations,
      maxCallCents: data.maxCallCents,
      maxCommitmentCents: data.maxCommitmentCents,
      allowCommitments: data.allowCommitments,
      allowFirstPerson: data.allowFirstPerson,
    };
    if (this.db.list("credential:").length >= 100)
      throw new ApiError(
        409,
        "credential_limit",
        "Revoke and remove unused credentials before adding more",
      );
    const credential = {
      principal,
      hash: await digest(token),
      expires: Date.now() + data.expiresInDays * 86400000,
      revoked: false,
      name: data.name,
    };
    this.ctx.storage.transactionSync(() => {
      // The digest await above may interleave with another issuance.
      if (this.db.get(`issue:${key}`))
        throw new ApiError(
          409,
          "credential_already_issued",
          "Credential already issued; inspect owner status before retrying",
        );
      this.db.put(`credential:${id}`, credential);
      this.db.put(`issue:${key}`, { hash, id });
    });
    return { id, token, principal };
  }
  async updateCredential(id: string, input: unknown, key: string) {
    const data = CredentialUpdateSchema.parse(input);
    const hash = await digest(JSON.stringify({ id, data }));
    return this.ctx.storage.transactionSync(() => {
      const receiptKey = `credential-update:${key}`;
      const prior = this.db.get<{ hash: string; result: unknown }>(receiptKey);
      if (prior) {
        if (prior.hash !== hash)
          throw new ApiError(
            409,
            "idempotency_conflict",
            "Key already used for different permissions",
          );
        return prior.result;
      }
      if (this.db.list("credential-update:", 5001).length >= 5000)
        throw new ApiError(
          429,
          "mutation_limit",
          "Credential update receipt capacity reached",
        );
      if (
        !this.config().draining ||
        this.entries().some(
          (e) => !e.settled || (e.finalizingUntil ?? 0) > Date.now(),
        )
      )
        throw new ApiError(
          409,
          "drain_required",
          "Pause admission and wait for calls to finish before changing credentials",
        );
      const c = this.db.get<Credential>(`credential:${id}`);
      if (!c || c.revoked || c.expires <= Date.now())
        throw new ApiError(404, "not_found", "Active credential not found");
      if ((c.principal.credentialRevision ?? 1) !== data.expectedRevision)
        throw new ApiError(
          409,
          "stale_revision",
          "Credential permissions changed; read current owner status",
        );
      const { expectedRevision, name, ...permissions } = data;
      c.name = name;
      c.principal = {
        ...permissions,
        id,
        owner: false,
        credentialRevision: expectedRevision + 1,
      };
      // Preserve the vault secret and its existing expiration. Changes and their
      // replay receipt commit together; an old retry cannot undo a later edit.
      const result = { id, name, expires: c.expires, principal: c.principal };
      this.db.put(`credential:${id}`, c);
      this.db.put(receiptKey, { hash, result });
      return result;
    });
  }
  private async adminMutation(
    key: string,
    body: unknown,
    action: () => Promise<unknown>,
  ) {
    const hash = await digest(JSON.stringify(body));
    const record = this.db.get<{
      hash: string;
      done: boolean;
      result?: unknown;
    }>(`admin:${key}`);
    if (record) {
      if (record.hash !== hash)
        throw new ApiError(
          409,
          "idempotency_conflict",
          "Administrative key has different content",
        );
      if (record.done) return record.result;
      throw new ApiError(
        409,
        "operation_pending",
        "Prior administrative operation requires inspection; it will not run twice",
      );
    }
    if (this.db.list("admin:", 5001).length >= 5000)
      throw new ApiError(
        429,
        "mutation_limit",
        "Administrative receipt capacity reached",
      );
    this.db.put(`admin:${key}`, { hash, done: false });
    const result = await action();
    this.db.put(`admin:${key}`, { hash, done: true, result });
    return result;
  }
  async revoke(id: string, key: string = crypto.randomUUID()) {
    return this.adminMutation(`revoke:${key}`, { id }, () =>
      this.applyRevoke(id),
    );
  }
  private async applyRevoke(id: string) {
    const c = this.db.get<Credential>(`credential:${id}`);
    if (!c) throw new ApiError(404, "not_found", "Credential not found");
    c.revoked = true;
    this.db.put(`credential:${id}`, c);
    const active = this.entries().filter(
      (e) => !e.settled && e.principalId === id,
    );
    for (const e of active)
      await this.env.CALLS.getByName(e.id).stop(
        "cancelled",
        "Originating credential revoked",
      );
    return { revoked: true };
  }
  async throttle(id: string) {
    const now = Date.now(),
      key = `rate:${id}`;
    let r = this.db.get<{ start: number; count: number }>(key);
    if (!r || now - r.start >= 10000) r = { start: now, count: 0 };
    if (++r.count > 30)
      throw new ApiError(
        429,
        "rate_limit",
        "Too many requests; retry after ten seconds",
      );
    this.db.put(key, r);
  }
  private entries() {
    return this.db.list<Entry>("call:", 5000).map((r) => r.value);
  }
  async create(p: Principal, b: CallBrief, key: string, hash: string) {
    if (!p.owner) {
      const c = this.db.get<Credential>(`credential:${p.id}`);
      if (
        !c ||
        c.revoked ||
        c.expires <= Date.now() ||
        (c.principal.credentialRevision ?? 1) !== (p.credentialRevision ?? 1)
      )
        throw new ApiError(
          401,
          "credential_changed",
          "Credential changed; authenticate again before creating a call",
        );
    }
    authorizeBrief(p, b);
    const prior = this.db.get<{ id: string; hash: string }>(
      `create:${p.id}:${key}`,
    );
    if (prior) {
      if (prior.hash !== hash)
        throw new ApiError(
          409,
          "idempotency_conflict",
          "Key already used for a different request",
        );
      return { ...prior, replay: true };
    }
    const c = this.config();
    if (c.kill || c.draining)
      throw new ApiError(423, "paused", "Calling service is paused");
    if (b.mode === "live" && !liveAllowed(this.env, p, b))
      throw new ApiError(
        503,
        "live_disabled",
        "Live calling is disabled until credentials and rollout checks are complete",
      );
    if (b.limits.maxMinutes > Number(this.env.MAX_CALL_MINUTES))
      throw new ApiError(
        422,
        "duration_limit",
        "Requested duration exceeds service limit",
      );
    const reserve = reservation(b);
    if (reserve > b.limits.maxCostCents)
      throw new ApiError(
        422,
        "insufficient_call_budget",
        "Budget does not cover maximum duration and backend allowance",
      );
    if (b.callbackId && !c.callbacks[b.callbackId]?.verified)
      throw new ApiError(
        422,
        "callback_unverified",
        "Callback must be registered and verified by the owner",
      );
    const entries = this.entries();
    if (entries.length >= 5000)
      throw new ApiError(
        409,
        "archive_required",
        "Call index capacity reached",
      );
    if (entries.some((e) => !e.settled))
      throw new ApiError(
        409,
        "concurrency_limit",
        "Another call is active or awaiting reconciliation",
      );
    const date = new Date(),
      month = date.toISOString().slice(0, 7),
      day = date.toISOString().slice(0, 10);
    const maximumEnd = new Date(
      date.getTime() +
        (b.mode === "live" ? b.limits.maxMinutes * 60000 + 180000 : 0),
    );
    const billingMonths = [
      ...new Set([month, maximumEnd.toISOString().slice(0, 7)]),
    ];
    const usageDays = [
      ...new Set([day, maximumEnd.toISOString().slice(0, 10)]),
    ];
    if (
      billingMonths.some(
        (period) =>
          entries
            .filter((e) => (e.billingMonths ?? [e.month]).includes(period))
            .reduce((a, e) => a + e.charged + (e.settled ? 0 : e.reserved), 0) +
            reserve +
            Number(this.env.MONTHLY_FIXED_ALLOWANCE_CENTS) >
          Number(this.env.MONTHLY_LIMIT_CENTS),
      )
    )
      throw new ApiError(
        402,
        "monthly_budget",
        "Monthly spending reservation would exceed the ceiling",
      );
    if (
      b.mode === "live" &&
      usageDays.some(
        (period) =>
          entries
            .filter(
              (e) =>
                (e.usageDays ?? [e.day]).includes(period) && e.mode === "live",
            )
            .reduce((a, e) => a + e.minutes, 0) +
            b.limits.maxMinutes >
          Number(this.env.DAILY_MINUTES),
      )
    )
      throw new ApiError(
        402,
        "daily_minutes",
        "Daily connected-minute reservation exceeded",
      );
    const id = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      this.db.put(`create:${p.id}:${key}`, { id, hash });
      this.db.put(`call:${id}`, {
        id,
        principalId: p.id,
        status: "queued",
        mode: b.mode,
        createdAt: Date.now(),
        month,
        day,
        billingMonths,
        usageDays,
        reserved: reserve,
        charged: 0,
        minutes: b.mode === "live" ? b.limits.maxMinutes : 0,
        settled: false,
        final: false,
      } satisfies Entry);
    });
    return { id, hash, replay: false };
  }
  async status(id: string, status: Status) {
    const e = this.db.get<Entry>(`call:${id}`);
    if (e) {
      e.status = status;
      this.db.put(`call:${id}`, e);
    }
  }
  async settle(
    id: string,
    charged: number,
    minutes: number,
    final: boolean,
    status: Status,
    endedAt = Date.now(),
  ) {
    const e = this.db.get<Entry>(`call:${id}`);
    if (!e) return;
    // Provisional bills retain the full reservation as a charge until verified receipts replace it.
    e.charged = final ? charged : Math.max(charged, e.reserved, e.charged);
    e.reserved = 0;
    e.settled = true;
    e.final = final;
    e.status = status;
    e.minutes = Math.max(0, minutes);
    const ended = new Date(endedAt).toISOString();
    e.billingMonths = [...new Set([e.month, ended.slice(0, 7)])];
    e.usageDays = [...new Set([e.day, ended.slice(0, 10)])];
    if (e.mode === "live") e.finalizingUntil ??= Date.now() + 20000;
    this.db.put(`call:${id}`, e);
    return e;
  }
  async reconcile(id: string, charged: number) {
    const e = this.db.get<Entry>(`call:${id}`);
    if (!e || !e.settled)
      throw new ApiError(
        409,
        "not_settled",
        "Call must be stopped before reconciling its bill",
      );
    e.charged = charged;
    e.final = true;
    this.db.put(`call:${id}`, e);
    return e;
  }
  async permitted(id: string) {
    const c = this.config();
    return !c.kill && (await this.activeCredential(id));
  }
  async hide(id: string) {
    const e = this.db.get<Entry>(`call:${id}`);
    if (e) {
      e.deleted = true;
      this.db.put(`call:${id}`, e);
    }
  }
  async list(p: Principal) {
    return this.entries()
      .filter((e) => !e.deleted && (p.owner || e.principalId === p.id))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100);
  }
  async inspect() {
    const entries = this.entries(),
      month = new Date().toISOString().slice(0, 7);
    return {
      ...this.config(),
      liveReady: liveReady(this.env),
      controlledTest: {
        destination: this.env.CONTROLLED_TEST_NUMBER,
        until: Number(this.env.CONTROLLED_TEST_UNTIL),
        serverTime: Date.now(),
      },
      monthlyLimitCents: Number(this.env.MONTHLY_LIMIT_CENTS),
      fixedAllowanceCents: Number(this.env.MONTHLY_FIXED_ALLOWANCE_CENTS),
      spentCents: entries
        .filter((e) => (e.billingMonths ?? [e.month]).includes(month))
        .reduce((a, e) => a + e.charged, 0),
      reservedCents: entries
        .filter(
          (e) => (e.billingMonths ?? [e.month]).includes(month) && !e.settled,
        )
        .reduce((a, e) => a + e.reserved, 0),
      activeCalls: entries.filter((e) => !e.settled).map((e) => e.id),
      finalizingCalls: entries
        .filter((e) => (e.finalizingUntil ?? 0) > Date.now())
        .map((e) => e.id),
      credentials: this.db
        .list<Credential>("credential:")
        .map(({ value: c }) => ({
          id: c.principal.id,
          name: c.name,
          expires: c.expires,
          revoked: c.revoked,
          principal: c.principal,
        })),
    };
  }
  async control(
    input: {
      kill?: boolean;
      draining?: boolean;
      terminateActive?: boolean;
    },
    key: string = crypto.randomUUID(),
  ) {
    return this.adminMutation(`control:${key}`, input, () =>
      this.applyControl(input),
    );
  }
  private async applyControl(input: {
    kill?: boolean;
    draining?: boolean;
    terminateActive?: boolean;
  }) {
    const c = this.config();
    if (input.kill !== undefined) c.kill = input.kill;
    if (input.draining !== undefined) c.draining = input.draining;
    this.db.put("config", c);
    if (input.terminateActive)
      for (const e of this.entries().filter((e) => !e.settled))
        await this.env.CALLS.getByName(e.id).stop(
          "cancelled",
          "Owner kill switch",
        );
    return this.inspect();
  }
  async registerCallback(
    id: string,
    url: string,
    key: string = crypto.randomUUID(),
  ) {
    return this.adminMutation(`callback:${key}`, { id, url }, () =>
      this.applyCallback(id, url),
    );
  }
  private async applyCallback(id: string, url: string) {
    if (!this.env.CALLBACK_SIGNING_KEY)
      throw new ApiError(
        503,
        "callback_disabled",
        "Configure a callback signing key first",
      );
    const u = new URL(url);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.port ||
      /^(localhost|.*\.local|.*\.internal|\d+\.\d+\.\d+\.\d+|\[)/.test(
        u.hostname,
      )
    )
      throw new ApiError(
        422,
        "invalid_callback",
        "A public HTTPS DNS endpoint is required",
      );
    const challenge = randomToken();
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "callback.verify", challenge }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || (await response.text()) !== challenge)
      throw new ApiError(
        422,
        "verification_failed",
        "Endpoint must return the exact verification challenge",
      );
    const c = this.config();
    if (Object.keys(c.callbacks).length >= 10 && !c.callbacks[id])
      throw new ApiError(
        409,
        "callback_limit",
        "At most ten callback endpoints",
      );
    c.callbacks[id] = { url, verified: true };
    this.db.put("config", c);
    return { id, verified: true };
  }
  async controlledHook(event: {
    event_type: string;
    payload: Record<string, unknown>;
  }) {
    const active = this.entries().find((e) => !e.settled && e.mode === "live");
    if (!active) return { ignored: true };
    return this.env.CALLS.getByName(active.id).controlledHook(event);
  }
  async callback(id: string) {
    return this.config().callbacks[id];
  }
}
