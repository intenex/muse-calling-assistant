import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  ApiError,
  ownerPrincipal,
  type Principal,
  type CallBrief,
} from "./domain";
export const bytes = (s: string) => new TextEncoder().encode(s);
export const from64 = (s: string) =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export function to64(b: Uint8Array) {
  let s = "";
  for (let i = 0; i < b.length; i += 8192)
    s += String.fromCharCode(...b.subarray(i, i + 8192));
  return btoa(s);
}
export async function digest(s: string) {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(s)));
  return Array.from(b, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function randomToken() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
export async function equal(a: string, b: string) {
  return timingSafeEqual(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(a))),
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(b))),
  );
}
export async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return to64(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes(value))),
  );
}
export async function mediaToken(
  env: Env,
  id: string,
  nonce: string,
  expires: number,
) {
  if (!env.MEDIA_SIGNING_KEY)
    throw new ApiError(503, "not_configured", "Media signing key is required");
  return `${expires}.${encodeURIComponent(await hmac(env.MEDIA_SIGNING_KEY, `${id}.${nonce}.${expires}`))}`;
}
export async function verifyMedia(
  env: Env,
  id: string,
  nonce: string,
  token: string,
) {
  const i = token.indexOf("."),
    expires = Number(token.slice(0, i));
  if (
    i < 0 ||
    !Number.isFinite(expires) ||
    expires < Date.now() ||
    expires > Date.now() + 600000 ||
    !env.MEDIA_SIGNING_KEY
  )
    return false;
  try {
    return await equal(
      decodeURIComponent(token.slice(i + 1)),
      await hmac(env.MEDIA_SIGNING_KEY, `${id}.${nonce}.${expires}`),
    );
  } catch {
    return false;
  }
}
export async function verifyTelnyx(req: Request, raw: string, env: Env) {
  const ts = req.headers.get("telnyx-timestamp"),
    sig = req.headers.get("telnyx-signature-ed25519");
  if (
    !ts ||
    !sig ||
    !env.TELNYX_PUBLIC_KEY ||
    !/^\d+$/.test(ts) ||
    Math.abs(Date.now() / 1000 - Number(ts)) > 300
  )
    return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      from64(env.TELNYX_PUBLIC_KEY),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      from64(sig),
      bytes(`${ts}|${raw}`),
    );
  } catch {
    return false;
  }
}
const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function authenticate(req: Request, env: Env): Promise<Principal> {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7);
    if (token.length > 256)
      throw new ApiError(401, "unauthorized", "Invalid credential");
    if (env.OWNER_API_KEY && (await equal(token, env.OWNER_API_KEY)))
      return ownerPrincipal;
    const p = await env.OWNER.getByName("owner").authenticate(token);
    if (p) return p;
  }
  const assertion = req.headers.get("cf-access-jwt-assertion");
  if (assertion && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUDIENCE) {
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    if (!jwks.has(issuer))
      jwks.set(
        issuer,
        createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
      );
    try {
      await jwtVerify(assertion, jwks.get(issuer)!, {
        issuer,
        audience: env.ACCESS_AUDIENCE,
      });
      return ownerPrincipal;
    } catch {}
  }
  throw new ApiError(
    401,
    "unauthorized",
    "Owner login or scoped bearer credential required",
  );
}
export function assertOwner(p: Principal) {
  if (!p.owner)
    throw new ApiError(403, "owner_required", "Owner access required");
}
export function idempotency(req: Request) {
  const k = req.headers.get("idempotency-key");
  if (!k || !/^[-a-zA-Z0-9_:.]{8,128}$/.test(k))
    throw new ApiError(
      400,
      "idempotency_required",
      "Provide an Idempotency-Key of 8–128 safe characters",
    );
  return k;
}
export async function readBody(req: Request, limit = 65536) {
  const tooLarge = () =>
    new ApiError(
      413,
      "body_too_large",
      `Maximum request size is ${limit} bytes`,
    );
  if (Number(req.headers.get("content-length") ?? 0) > limit) throw tooLarge();
  if (!req.body) return "";
  const reader = req.body.getReader(),
    decoder = new TextDecoder();
  let size = 0,
    raw = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw tooLarge();
      }
      raw += decoder.decode(value, { stream: true });
    }
    return raw + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
export async function readJson(req: Request) {
  const raw = await readBody(req);
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON");
  }
}
export function liveReady(env: Env) {
  return (
    env.LIVE_ENABLED === "true" &&
    env.ACCOUNT_HEADROOM_VERIFIED === "true" &&
    env.ROLLOUT_VERIFIED === "true" &&
    !!(
      env.OPENAI_API_KEY &&
      env.TELNYX_API_KEY &&
      env.TELNYX_PUBLIC_KEY &&
      env.TELNYX_CONNECTION_ID &&
      env.TELNYX_FROM_NUMBER &&
      env.MEDIA_SIGNING_KEY
    ) &&
    env.PUBLIC_BASE_URL.startsWith("https://")
  );
}

export function controlledTestAllowed(env: Env, p: Principal, b: CallBrief) {
  const until = Number(env.CONTROLLED_TEST_UNTIL);
  return (
    p.owner &&
    b.mode === "live" &&
    b.destination.number === env.CONTROLLED_TEST_NUMBER &&
    until > Date.now() &&
    until <= Date.now() + 3600000 &&
    b.limits.maxMinutes <= 2 &&
    b.limits.maxCostCents <= 50 &&
    b.limits.backendCents <= 10
  );
}
export function liveAllowed(env: Env, p: Principal, b: CallBrief) {
  return liveReady(env) || controlledTestAllowed(env, p, b);
}
