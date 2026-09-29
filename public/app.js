const $ = (s) => document.querySelector(s);
const pendingMutations = new Map();
let token = "",
  principal,
  ready = false,
  current,
  seq = 0,
  pendingBrief,
  refreshing = false,
  createKey;
const money = (c) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    c / 100,
  );
function notice(text) {
  $("#notice").hidden = !text;
  $("#notice").textContent = text;
}
async function api(path, body, key) {
  const identity = body === undefined ? undefined : path + JSON.stringify(body);
  if (identity && !key) {
    key = pendingMutations.get(identity) ?? crypto.randomUUID();
    pendingMutations.set(identity, key);
  }
  const r = await fetch(path, {
    signal: AbortSignal.timeout(10000),
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined
        ? {}
        : {
            "content-type": "application/json",
            "idempotency-key": key ?? crypto.randomUUID(),
          }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (identity && (r.ok || (r.status >= 400 && r.status < 500)))
    pendingMutations.delete(identity);
  if (!r.ok)
    throw new Error(data.error?.message ?? `Request failed (${r.status})`);
  return data;
}
async function run(fn) {
  notice("");
  try {
    await fn();
  } catch (e) {
    notice(e.message);
  }
}
$("#login-form").onsubmit = (e) => {
  e.preventDefault();
  token = $("#api-key").value;
  run(connect);
};
async function connect() {
  const data = await api("/v1/me");
  principal = data.principal;
  ready = data.liveReady && (principal.owner || principal.live);
  $("#api-key").value = "";
  $("#login").hidden = true;
  $("#workspace").hidden = false;
  $("#connection").textContent = principal.owner
    ? "Owner connected"
    : "Agent connected";
  $("#connection").classList.add("live");
  $("#live-option").disabled = !ready;
  $("#mode-state").textContent = ready ? "Live available" : "Simulation";
  $("#live-explanation").textContent = ready
    ? "Calls use your authorized brief"
    : "Live activation checks pending";
  $("#admin").hidden = !principal.owner;
  await refresh();
}
function formBrief() {
  const f = new FormData($("#call-form")),
    seconds = Number(f.get("simulation"));
  return {
    version: "1",
    mode: f.get("mode"),
    destination: { number: f.get("number"), business: f.get("business") },
    caller: {
      name: f.get("name"),
      persona: f.get("persona"),
      introduction: "",
    },
    objective: f.get("objective"),
    successCriteria: ["Collect and confirm the requested information"],
    facts: String(f.get("facts"))
      .split("\n")
      .filter(Boolean)
      .map((text, i) => ({
        id: `fact-${i + 1}`,
        text,
        visibility: "shareable",
      })),
    origin: { agent: principal?.owner ? "owner-console" : "agent-console" },
    limits: {
      maxMinutes: Number(f.get("minutes")),
      maxCostCents: 500,
      backendCents: 100,
    },
    ...(f.get("mode") === "simulation"
      ? {
          simulation: {
            durationSeconds: seconds,
            questionAfterSeconds:
              seconds === 2700 ? 1200 : seconds === 480 ? 180 : 10,
          },
        }
      : {}),
  };
}
$("#populate-json").onclick = () => {
  $("#advanced").value = JSON.stringify(formBrief(), null, 2);
};
$("#call-form").onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    pendingBrief = $("#advanced").value.trim()
      ? JSON.parse($("#advanced").value)
      : formBrief();
    const validation = await api("/v1/calls/validate", pendingBrief);
    if (!validation.valid) throw new Error(validation.warnings.join(" "));
    $("#review").hidden = false;
    $("#review-brief").textContent = JSON.stringify(pendingBrief, null, 2);
    $("#review-info").textContent =
      `Maximum reserved cost: ${money(validation.maximumEstimatedCents)}. ${validation.warnings.join(" ")}`;
    $("#start").textContent =
      pendingBrief.mode === "live" ? "Place phone call" : "Start simulation";
    createKey = crypto.randomUUID();
  });
};
$("#edit").onclick = () => {
  $("#review").hidden = true;
};
$("#start").onclick = () =>
  run(async () => {
    $("#start").disabled = true;
    try {
      const call = await api("/v1/calls", pendingBrief, createKey);
      await select(call.id);
    } finally {
      $("#start").disabled = false;
    }
  });
$("#new-call").onclick = () => {
  current = null;
  seq = 0;
  $("#composer").hidden = false;
  $("#active").hidden = true;
  $("#review").hidden = true;
};
async function select(id) {
  current = { id };
  seq = 0;
  $("#event-log").textContent = "";
  $("#transcript").textContent =
    "The transcript will appear here. Simulations don’t generate audio.";
  $("#playback").textContent = "Generated speech ≠ verified playback";
  $("#result").hidden = true;
  decisionRenderKey = "";
  $("#composer").hidden = true;
  $("#active").hidden = false;
  await refresh();
}
async function refresh() {
  if (!principal || refreshing) return;
  refreshing = true;
  try {
    const list = await api("/v1/calls");
    $("#history").replaceChildren();
    for (const c of list.calls) {
      const button = document.createElement("button");
      button.textContent = `${c.mode === "simulation" ? "◌" : "↗"} ${new Date(c.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
      const sub = document.createElement("small");
      sub.textContent = c.status;
      button.append(sub);
      button.onclick = () => run(() => select(c.id));
      $("#history").append(button);
    }
    if (principal.owner) {
      const a = await api("/v1/admin/status");
      $("#spending").textContent =
        `${money(a.spentCents)} / ${money(a.monthlyLimitCents)}`;
      $("#reserved").textContent =
        `${money(a.reservedCents)} call reservations · ${money(a.fixedAllowanceCents ?? 0)} fixed allowance`;
      $("#service-state").textContent = a.kill
        ? "Stopped"
        : a.draining
          ? "Paused"
          : "Ready";
    }
    if (current) {
      const id = current.id;
      const c = await api(`/v1/calls/${id}`);
      if (current?.id !== id) return;
      current = c;
      $("#call-title").textContent = c.destination.business;
      $("#call-subtitle").textContent =
        `${c.destination.number} · ${c.mode} · revision ${c.revision}`;
      $("#call-status").textContent = c.status;
      $("#call-cost").textContent =
        `${money(c.usage.costCents)} ${c.usage.final ? "final" : "estimated"} · ${money(c.usage.reservedCents)} initially reserved`;
      const ended = ["completed", "cancelled", "failed", "uncertain"].includes(
        c.status,
      );
      $("#cancel").disabled = ended;
      $("#context-form").hidden = ended;
      renderDecisions(c.decisions);
      $("#result").hidden = !c.result;
      if (c.result)
        $("#result").textContent =
          c.result.finalized === false
            ? "Call ended. Preparing the final summary…"
            : `${c.result.outcome.replaceAll("_", " ")}\n${c.result.summary}\n${c.result.confirmedDetails.join("\n")}`;
      const events = await api(`/v1/calls/${id}/events?since_seq=${seq}`);
      seq = events.nextSeq;
      for (const e of events.events)
        $("#event-log").textContent +=
          `${new Date(e.at).toLocaleTimeString()} · ${e.type}\n`;
      $("#event-log").textContent = $("#event-log").textContent.slice(-15000);
      if (principal.owner || principal.scopes.includes("transcript:read")) {
        const t = await api(`/v1/calls/${id}/transcript`);
        renderTranscript(t.fragments);
        if (t.purged)
          $("#transcript").textContent =
            "Transcript expired under the 30-day retention policy.";
        if (t.playback)
          $("#playback").textContent =
            `Carrier acknowledged ${t.playback.playedBytes} audio bytes; ${t.playback.clearedBytes} cleared. This does not verify the wording.`;
      }
    }
  } finally {
    refreshing = false;
  }
}
let decisionRenderKey = "";
function renderDecisions(decisions) {
  const active = decisions.filter((d) => d.status === "pending");
  const key = active.map((d) => d.id + ":" + d.revision).join();
  if (key === decisionRenderKey) return;
  decisionRenderKey = key;
  $("#decisions").replaceChildren();
  for (const d of active) {
    const box = document.createElement("div");
    box.className = "decision";
    const heading = document.createElement("h3");
    heading.textContent = d.question;
    const deadline = document.createElement("small");
    deadline.textContent = `Answer by ${new Date(d.deadline).toLocaleTimeString()} · fallback: ${d.fallback.fallback.replaceAll("_", " ")}`;
    box.append(heading, deadline);
    if (d.choices.length)
      for (const choice of d.choices) {
        const b = document.createElement("button");
        b.textContent = choice;
        b.onclick = () => run(() => answer(d, choice));
        box.append(b);
      }
    else {
      const input = document.createElement("input"),
        b = document.createElement("button");
      input.placeholder = "Your answer";
      b.textContent = "Send answer";
      b.onclick = () => run(() => answer(d, input.value));
      box.append(input, b);
    }
    $("#decisions").append(box);
  }
}
async function answer(d, answer) {
  await api(`/v1/calls/${current.id}/answers`, {
    decisionId: d.id,
    expectedRevision: d.revision,
    answer,
  });
  await refresh();
}
function renderTranscript(fragments) {
  if (!fragments.length) return;
  const el = $("#transcript"),
    atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  el.replaceChildren();
  let previous;
  for (const f of fragments) {
    if (previous && previous.speaker === f.speaker) {
      previous.text.textContent += f.text;
      continue;
    }
    const box = document.createElement("div");
    box.className = "fragment " + f.speaker;
    const who = document.createElement("small");
    who.textContent =
      f.speaker === "assistant"
        ? "Assistant · generated, playback unverified"
        : "Recipient";
    const text = document.createElement("span");
    text.textContent = f.text;
    box.append(who, text);
    el.append(box);
    previous = { speaker: f.speaker, text };
  }
  if (atBottom) el.scrollTop = el.scrollHeight;
}
$("#cancel").onclick = () =>
  run(async () => {
    await api(`/v1/calls/${current.id}/cancel`, {});
    await refresh();
  });
$("#context-form").onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    await api(`/v1/calls/${current.id}/context`, {
      expectedRevision: current.revision,
      facts: [
        {
          id: "owner-update",
          text: $("#new-context").value,
          visibility: "shareable",
        },
      ],
    });
    $("#new-context").value = "";
    await refresh();
  });
};
for (const [id, body] of [
  ["pause", { draining: true }],
  ["kill", { kill: true, terminateActive: true }],
  ["resume", { kill: false, draining: false }],
])
  $("#" + id).onclick = () =>
    run(async () => {
      await api("/v1/admin/control", body);
      await refresh();
    });
$("#credential-form").onsubmit = (e) => {
  e.preventDefault();
  run(async () => {
    const c = await api("/v1/admin/credentials", {
      name: $("#agent-name").value,
      scopes: [
        "calls:create",
        "calls:read",
        "calls:answer",
        "calls:context",
        "calls:cancel",
        "transcript:read",
      ],
      live: false,
    });
    $("#credential-result").hidden = false;
    $("#credential-result").value = c.token;
    notice(
      "New credential is shown once below. Store it in your agent’s secure vault.",
    );
  });
};
setInterval(() => {
  if (!document.hidden) run(refresh);
}, 5000);
run(async () => {
  try {
    await connect();
  } catch {
    /* Show the login form when Access is not configured. */
  }
});
