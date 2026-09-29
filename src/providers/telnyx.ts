import { ApiError, type CallState } from "../domain";
import { mediaToken } from "../security";
export async function telnyx(env: Env, path: string, body?: unknown) {
  const r = await fetch(`https://api.telnyx.com/v2${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${env.TELNYX_API_KEY}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) {
    const details = (await r.json().catch(() => ({}))) as {
      errors?: { code?: string; source?: { pointer?: string } }[];
    };
    const codes =
      details.errors
        ?.map((e) => e.code ?? "unknown")
        .join(",")
        .slice(0, 100) ?? "unknown";
    const definitive =
      r.status >= 400 && r.status < 500 && ![408, 409, 429].includes(r.status);
    throw new ApiError(
      definitive ? 422 : 502,
      definitive ? "carrier_rejected" : "carrier_error",
      `Carrier request returned ${r.status}; provider codes: ${codes}`,
    );
  }
  return (await r.json()) as { data: Record<string, unknown> };
}
export async function dial(env: Env, s: CallState) {
  const token = await mediaToken(env, s.id, s.mediaNonce, Date.now() + 300000);
  const base = env.PUBLIC_BASE_URL.replace(/\/$/, "");
  return telnyx(env, "/calls", {
    connection_id: env.TELNYX_CONNECTION_ID,
    to: s.brief.destination.number,
    from: env.TELNYX_FROM_NUMBER,
    command_id: s.id,
    client_state: btoa(s.id),
    webhook_url: `${base}/webhooks/telnyx`,
    stream_url: `${base.replace(/^https:/, "wss:")}/media/${s.id}?token=${encodeURIComponent(token)}`,
    stream_track: "inbound_track",
    stream_bidirectional_mode: "rtp",
    stream_codec: env.AUDIO_CODEC,
    stream_bidirectional_codec: env.AUDIO_CODEC,
    stream_bidirectional_sampling_rate:
      env.AUDIO_CODEC === "PCMU" ? 8000 : 16000,
    timeout_secs: 45,
    time_limit_secs: Math.ceil(s.brief.limits.maxMinutes * 60),
    answering_machine_detection: "detect",
    ...(s.brief.recording === "on"
      ? {
          record: "record-from-answer",
          record_channels: "dual",
          record_format: "mp3",
          record_track: "both",
          record_max_length: Math.ceil(s.brief.limits.maxMinutes * 60),
          record_timeout_secs: 0,
        }
      : {}),
  });
}
export async function hangup(env: Env, id: string, commandId: string) {
  return telnyx(env, `/calls/${encodeURIComponent(id)}/actions/hangup`, {
    command_id: commandId,
  });
}
export async function sendDigits(
  env: Env,
  id: string,
  digits: string,
  commandId: string,
) {
  if (!/^[0-9*#w]{1,24}$/.test(digits))
    throw new ApiError(
      422,
      "invalid_digits",
      "Invalid or excessive DTMF sequence",
    );
  return telnyx(env, `/calls/${encodeURIComponent(id)}/actions/send_dtmf`, {
    digits,
    duration_millis: 200,
    command_id: commandId,
  });
}
export async function callStatus(env: Env, id: string) {
  return telnyx(env, `/calls/${encodeURIComponent(id)}`);
}
