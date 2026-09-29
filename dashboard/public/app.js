const $ = (s) => document.querySelector(s);
let history = { calls: [], recordings: [] },
  selected,
  filter = "live",
  refreshing = false;
const money = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    (n ?? 0) / 100,
  );
const duration = (s) =>
  `${Math.floor((s ?? 0) / 60)}:${String(Math.floor((s ?? 0) % 60)).padStart(2, "0")}`;
const text = (tag, value, cls) => {
  const el = document.createElement(tag);
  el.textContent = value ?? "";
  if (cls) el.className = cls;
  return el;
};
const notice = (message) => {
  $("#notice").textContent = message;
  $("#notice").hidden = !message;
};
const recorded = (id) => history.recordings.filter((r) => r.callId === id);
async function api(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: { "X-Dashboard-Action": "1", ...options.headers },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? "Request failed");
  return data;
}
function turns(c) {
  const groups = [];
  for (const f of c.transcript?.fragments ?? []) {
    const previous = groups.at(-1);
    if (
      previous &&
      previous.speaker === f.speaker &&
      f.at - previous.lastAt < 8000
    ) {
      previous.text += f.text;
      previous.lastAt = f.at;
    } else groups.push({ ...f, lastAt: f.at });
  }
  return groups;
}
function render() {
  const live = history.calls.filter((c) => c.mode === "live");
  $("#total-calls").textContent = live.length;
  $("#total-minutes").textContent =
    `${(live.reduce((n, c) => n + (c.usage?.liveSeconds ?? 0), 0) / 60).toFixed(1)} min`;
  $("#total-cost").textContent = money(
    live.reduce((n, c) => n + (c.usage?.costCents ?? c.charged ?? 0), 0),
  );
  $("#total-recordings").textContent = history.recordings.filter((r) =>
    history.calls.some((c) => c.id === r.callId),
  ).length;
  $("#live-count").textContent = live.length;
  $("#all-count").textContent = history.calls.length;
  $("#sim-count").textContent = history.calls.length - live.length;
  $("#recorded-count").textContent = history.calls.filter(
    (c) => recorded(c.id).length,
  ).length;
  $("#sync-time").textContent = history.syncedAt
    ? `Updated ${new Date(history.syncedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : "Not refreshed yet";
  const query = $("#search").value.toLowerCase().trim(),
    status = $("#status-filter").value;
  const visible = history.calls.filter(
    (c) =>
      (filter === "all" ||
        (filter === "recorded" ? recorded(c.id).length : c.mode === filter)) &&
      (status === "all" ||
        (status === "active"
          ? ["queued", "dialing", "active", "ending"].includes(c.status)
          : c.status === status)) &&
      (!query ||
        [
          c.destination?.business,
          c.destination?.number,
          c.objective,
          c.result?.summary,
          ...turns(c).map((t) => t.text),
        ]
          .join(" ")
          .toLowerCase()
          .includes(query)),
  );
  $("#visible-count").textContent = visible.length;
  $("#list-title").textContent = {
    all: "All activity",
    live: "Phone calls",
    recorded: "With recordings",
    simulation: "Simulations",
  }[filter];
  const list = $("#call-list");
  list.replaceChildren();
  if (!visible.length)
    list.append(
      text(
        "div",
        query
          ? "No calls match your search."
          : filter === "recorded"
            ? "No recordings yet. Past calls had recording turned off."
            : "No calls in this view.",
        "empty",
      ),
    );
  if (!selected && visible.length) selected = visible[0].id;
  for (const c of visible) {
    const b = text(
      "button",
      "",
      "call-row" + (selected === c.id ? " selected" : ""),
    );
    b.setAttribute("aria-pressed", String(selected === c.id));
    const top = text("div", "", "call-row-top");
    top.append(
      text("span", c.destination?.business || "Unnamed call", "recipient"),
      text(
        "span",
        new Date(c.createdAt).toLocaleDateString([], {
          month: "short",
          day: "numeric",
        }),
        "date",
      ),
    );
    const meta = text("div", "", "call-meta");
    meta.append(
      text("span", c.status, "badge " + c.status),
      text("span", duration(c.usage?.liveSeconds)),
      text(
        "span",
        new Date(c.createdAt).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        }),
      ),
    );
    if (recorded(c.id).length) meta.append(text("span", "◉ Audio"));
    b.append(
      top,
      text(
        "p",
        c.objective || c.result?.summary || "Call details unavailable",
        "call-objective",
      ),
      meta,
    );
    b.onclick = () => {
      selected = c.id;
      render();
    };
    list.append(b);
  }
  renderDetail();
}
function renderDetail() {
  const c = history.calls.find((c) => c.id === selected),
    panel = $("#detail");
  if (!c) return;
  panel.replaceChildren();
  const top = text("div", "", "detail-top"),
    title = text("div");
  title.append(
    text("h2", c.destination?.business || "Unnamed call"),
    text(
      "div",
      `${c.destination?.number ?? ""} · ${new Date(c.createdAt).toLocaleString([], { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}`,
      "detail-date",
    ),
  );
  top.append(title, text("span", c.status, "badge " + c.status));
  panel.append(top);
  const facts = text("div", "", "detail-facts");
  facts.append(
    text("span", c.mode === "live" ? "↗ Outbound phone call" : "◌ Simulation"),
    text("span", duration(c.usage?.liveSeconds) + " connected"),
    text(
      "span",
      money(c.usage?.costCents ?? c.charged) +
        " " +
        (c.usage?.final ? "final" : "estimated"),
    ),
  );
  panel.append(facts);
  const brief = text("details", "", "objective");
  brief.append(
    text("summary", "View original call brief"),
    text("p", c.objective),
  );
  panel.append(brief);
  const summary = text("section", "", "summary");
  summary.append(
    text("h3", "CALL SUMMARY", "section-title"),
    text(
      "p",
      c.result?.summary || "A final summary is not available for this call.",
    ),
  );
  if (c.result?.confirmedDetails?.length) {
    const ul = text("ul");
    for (const d of c.result.confirmedDetails) ul.append(text("li", d));
    summary.append(ul);
  }
  panel.append(summary);
  const recording = text("section", "", "recording"),
    row = text("div", "", "section-row");
  const imp = text("button", "＋ Add audio file", "text-button");
  imp.onclick = () => {
    $("#audio-file").dataset.callId = c.id;
    $("#audio-file").click();
  };
  row.append(text("h3", "CALL RECORDING", "section-title"), imp);
  recording.append(row);
  const recordings = recorded(c.id);
  if (!recordings.length)
    recording.append(
      text(
        "p",
        c.mode === "simulation"
          ? "Simulations do not generate audio."
          : c.recording?.status === "requested"
            ? "Recording was requested. After the call ends, click Refresh history to retrieve the carrier's finished audio."
            : c.recording?.status === "failed"
              ? "The carrier reported a recording failure. The call transcript is still available below."
              : c.recording?.status === "saved"
                ? "The carrier saved this recording. Click Refresh history to load its audio."
                : "No recording is available. Earlier calls were made with recording disabled. You can attach an original WAV or MP3 file saved elsewhere.",
        "explanation",
      ),
    );
  for (const r of recordings) {
    recording.append(
      text(
        "div",
        r.source === "import"
          ? "IMPORTED AUDIO · stored only on this Mac"
          : "CARRIER RECORDING · downloads privately on playback",
        "source-label",
      ),
    );
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = `/api/recordings/${r.id}/audio`;
    audio.setAttribute("aria-label", "Call recording");
    audio.onerror = () =>
      notice(
        "Audio could not load. Refresh to renew carrier access, or check the imported file.",
      );
    recording.append(audio);
    const tools = text("div", "", "player-tools");
    for (const [label, delta] of [
      ["−10 sec", -10],
      ["+10 sec", 10],
    ]) {
      const b = text("button", label);
      b.onclick = () => {
        if (Number.isFinite(audio.duration))
          audio.currentTime = Math.max(
            0,
            Math.min(audio.duration, audio.currentTime + delta),
          );
      };
      tools.append(b);
    }
    const speed = document.createElement("select");
    speed.setAttribute("aria-label", "Playback speed");
    for (const v of [0.75, 1, 1.25, 1.5, 2]) {
      const o = text("option", v + "×");
      o.value = v;
      o.selected = v === 1;
      speed.append(o);
    }
    speed.onchange = () => {
      audio.playbackRate = Number(speed.value);
    };
    const download = text("a", "Download", "export-link");
    download.href = audio.src;
    download.download = `call-${c.id}-${r.id}.${r.format || "mp3"}`;
    tools.append(speed, download);
    recording.append(tools);
  }
  panel.append(recording);
  const heading = text("div", "", "section-row transcript-heading");
  heading.append(text("h3", "TRANSCRIPT", "section-title"));
  const groups = turns(c);
  if (groups.length) {
    const b = text("a", "Export transcript ↓", "text-button");
    b.href = `/api/calls/${c.id}/transcript.txt`;
    b.download = `call-${c.id}.txt`;
    heading.append(b);
  }
  panel.append(
    heading,
    text(
      "p",
      "Assistant text is generated speech; the recording is the source for what was actually heard.",
      "transcript-hint",
    ),
  );
  const transcript = text("div", "", "transcript");
  if (!groups.length)
    transcript.append(
      text(
        "p",
        c.transcript?.purged
          ? "This transcript expired under the 30-day retention policy."
          : c.mode === "simulation"
            ? "This simulation has no spoken conversation."
            : "No transcript was captured for this call.",
        "empty",
      ),
    );
  for (const t of groups) {
    const item = text("div", "", "turn " + t.speaker),
      body = text("div"),
      head = text("div", "", "turn-head");
    head.append(
      text(
        "span",
        t.speaker === "assistant"
          ? "Assistant"
          : c.destination?.business || "Recipient",
      ),
      text(
        "time",
        new Date(t.at).toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        }),
      ),
    );
    body.append(head, text("p", t.text));
    item.append(
      text(
        "span",
        t.speaker === "assistant"
          ? "↗"
          : (c.destination?.business || "R").slice(0, 1).toUpperCase(),
        "avatar",
      ),
      body,
    );
    transcript.append(item);
  }
  panel.append(transcript);
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  $("#refresh").disabled = true;
  $("#refresh span").textContent = "Refreshing…";
  notice("");
  try {
    history = await api("/api/sync", { method: "POST" });
    render();
    notice(history.warnings?.join(" ") || "");
  } catch (e) {
    notice(e.message + " You can continue viewing locally saved history.");
  } finally {
    refreshing = false;
    $("#refresh").disabled = false;
    $("#refresh span").textContent = "Refresh history";
  }
}
$("#refresh").onclick = refresh;
for (const b of document.querySelectorAll("[data-filter]"))
  b.onclick = () => {
    filter = b.dataset.filter;
    selected = undefined;
    for (const n of document.querySelectorAll("[data-filter]"))
      n.classList.toggle("active", n === b);
    $("#detail").replaceChildren(
      text("p", "Select a call to view its details.", "empty"),
    );
    render();
  };
$("#search").oninput = render;
$("#status-filter").onchange = render;
$("#audio-file").onchange = async (e) => {
  const file = e.target.files[0],
    id = e.target.dataset.callId;
  if (!file) return;
  try {
    if (file.size > 100 * 1024 * 1024)
      throw new Error("Choose a recording under 100 MB.");
    history = await api(`/api/calls/${id}/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
    render();
    notice(
      "Audio saved on this Mac. It was not uploaded to the calling service.",
    );
  } catch (e) {
    notice(e.message);
  } finally {
    $("#audio-file").value = "";
  }
};
try {
  history = await api("/api/history");
  render();
  if (!history.syncedAt) await refresh();
  else notice(history.warnings?.join(" ") || "");
} catch (e) {
  notice(e.message);
}
