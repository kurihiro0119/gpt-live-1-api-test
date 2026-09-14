const GAP_MS = 700;
const HOT_TYPES = new Set([
  "session.started",
  "session.closed",
  "session.delegation.created",
  "session.usage.updated",
  "error",
]);

const startBtn = document.querySelector("#start");
const stopBtn = document.querySelector("#stop");
const muteBtn = document.querySelector("#mute");
const downloadBtn = document.querySelector("#download");
const injectForm = document.querySelector("#inject");
const injectInput = document.querySelector("#inject-text");
const injectSubmit = injectForm.querySelector("button");
const voiceSelect = document.querySelector("#voice");
const extraInput = document.querySelector("#extra");
const webSearchInput = document.querySelector("#web-search");
const statusEl = document.querySelector("#status");
const usageEl = document.querySelector("#usage");
const captionsEl = document.querySelector("#captions");
const logEl = document.querySelector("#log");
const keyBadge = document.querySelector("#key-badge");
const modelsEl = document.querySelector("#models");
const levelEl = document.querySelector("#level");
const audio = document.querySelector("#playback");

/** @type {RTCPeerConnection | undefined} */
let peer;
/** @type {RTCDataChannel | undefined} */
let events;
/** @type {MediaStream | undefined} */
let microphone;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let closeTimeout;
/** @type {number | undefined} */
let meterRaf;
/** @type {AudioContext | undefined} */
let meterCtx;
let ready = false;
let muted = false;
let finalized = false;
let eventSeq = 0;
/** @type {object[]} */
const eventLog = [];
/** @type {{ role: string, text: string, startMs: number, endMs: number, el: HTMLElement }[]} */
const rows = [];

const config = await fetch("/api/config").then((r) => r.json());
keyBadge.textContent = config.hasApiKey ? "API key: set" : "API key: missing";
keyBadge.classList.add(config.hasApiKey ? "ok" : "bad");
modelsEl.textContent = `${config.model} → ${config.backendModel}`;
for (const voice of config.voices) {
  const option = document.createElement("option");
  option.value = voice;
  option.textContent = voice;
  if (voice === "marin") option.selected = true;
  voiceSelect.append(option);
}

startBtn.addEventListener("click", connect);
stopBtn.addEventListener("click", endConversation);
muteBtn.addEventListener("click", toggleMute);
downloadBtn.addEventListener("click", downloadLog);
injectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const content = injectInput.value.trim();
  if (!content || !ready || events?.readyState !== "open") return;
  send({
    type: "session.commentary.append",
    event_id: `comment_${++eventSeq}`,
    delegation_id: null,
    content,
  });
  injectInput.value = "";
});

async function connect() {
  startBtn.disabled = true;
  voiceSelect.disabled = true;
  extraInput.disabled = true;
  webSearchInput.disabled = true;
  finalized = false;
  muted = false;
  eventLog.length = 0;
  rows.length = 0;
  captionsEl.replaceChildren();
  logEl.replaceChildren();
  usageEl.textContent = "";
  setStatus("Connecting…");

  try {
    const connection = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    peer = connection;
    connection.addEventListener("track", (event) => {
      audio.srcObject = new MediaStream([event.track]);
      audio.play().catch(() => setStatus("ブラウザが自動再生を止めた。再生して。"));
    });

    microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of microphone.getAudioTracks()) {
      connection.addTrack(track, microphone);
    }
    startMeter(microphone);

    events = connection.createDataChannel("oai-events");
    events.addEventListener("message", ({ data }) => {
      const event = JSON.parse(data);
      ingest(event);
    });
    events.addEventListener("close", (event) => {
      if (event.target !== events) return;
      if (!finalized) {
        setStatus("Disconnected without session.closed");
        cleanup();
      }
    });

    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await waitForIce(connection);

    const sdp = connection.localDescription?.sdp;
    if (!sdp) throw new Error("Missing local SDP offer");

    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sdp,
        voice: voiceSelect.value,
        instructions: extraInput.value,
        webSearch: webSearchInput.checked,
      }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || (await response.text()) || response.statusText);
    }
    const result = await response.json();
    record({ type: "client.session.created", session: result.session, transport: "webrtc" });
    await connection.setRemoteDescription({
      type: "answer",
      sdp: result.transport.sdp,
    });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
    cleanup();
  }
}

function ingest(event) {
  record(event);
  if (event.type === "session.started") {
    ready = true;
    stopBtn.disabled = false;
    muteBtn.disabled = false;
    injectInput.disabled = false;
    injectSubmit.disabled = false;
    setStatus(`Connected ${event.session.id}`);
    send({
      type: "session.instructions.append",
      event_id: `greet_${++eventSeq}`,
      delegation_id: null,
      content:
        "Speak Japanese. Immediately greet with「こんにちは。GPT-Live-1の検証です。お話しください。」then pause and listen.",
    });
    return;
  }
  if (event.type === "session.closed") {
    finalized = true;
    const seconds = event.usage?.seconds;
    usageEl.textContent =
      seconds == null ? "usage: unconfirmed" : `${seconds}s · $${((seconds / 60) * 0.05).toFixed(4)} voice`;
    setStatus(`Closed (${event.reason ?? "ok"})`);
    cleanup();
    return;
  }
  if (event.type === "session.usage.updated") {
    const seconds = event.usage?.seconds ?? 0;
    usageEl.textContent = `${seconds}s · $${((seconds / 60) * 0.05).toFixed(4)} voice`;
    return;
  }
  if (event.type === "session.input_transcript.delta") {
    appendCaption("user", event.delta ?? "", event.start_ms, event.end_ms);
    return;
  }
  if (event.type === "session.output_transcript.delta") {
    appendCaption("assistant", event.delta ?? "", event.start_ms, event.end_ms);
    return;
  }
  if (event.type === "session.delegation.created") {
    setStatus(`Delegating ${event.delegation?.id ?? ""}`);
    return;
  }
  if (event.type === "session.input_audio.muted") {
    muted = true;
    muteBtn.textContent = "ミュート解除";
    return;
  }
  if (event.type === "session.input_audio.unmuted") {
    muted = false;
    muteBtn.textContent = "ミュート";
    return;
  }
  if (event.type === "error") {
    setStatus(event.error?.message || "error");
  }
}

function appendCaption(role, delta, startMs, endMs) {
  if (!delta) return;
  const last = [...rows].reverse().find((row) => row.role === role);
  if (last && startMs - last.endMs < GAP_MS) {
    last.text += delta;
    last.endMs = Math.max(last.endMs, endMs ?? last.endMs);
    last.el.querySelector(".t").textContent = last.text;
    return;
  }
  const el = document.createElement("div");
  el.className = `row ${role}`;
  el.innerHTML = `<div class="who">${role}</div><div class="t"></div>`;
  el.querySelector(".t").textContent = delta;
  captionsEl.append(el);
  rows.push({
    role,
    text: delta,
    startMs: startMs ?? 0,
    endMs: endMs ?? startMs ?? 0,
    el,
  });
  captionsEl.scrollTop = captionsEl.scrollHeight;
}

function endConversation() {
  if (!ready || events?.readyState !== "open") return;
  stopBtn.disabled = true;
  setStatus("Finishing…");
  send({ type: "session.close" });
  closeTimeout = setTimeout(() => {
    setStatus("Incomplete finalization: no session.closed");
    cleanup();
  }, 15_000);
}

function toggleMute() {
  if (!ready || events?.readyState !== "open") return;
  send({
    type: muted ? "session.input_audio.unmute" : "session.input_audio.mute",
    event_id: `mute_${++eventSeq}`,
  });
}

function send(payload) {
  events?.send(JSON.stringify(payload));
  record({ type: "client.send", payload });
}

function record(event) {
  eventLog.push({ t: Date.now(), ...event });
  const node = document.createElement("div");
  node.className = "ev";
  const nested = event.response?.event?.type || event.payload?.type;
  const label = nested ? `${event.type} → ${nested}` : event.type;
  if (HOT_TYPES.has(event.type) || HOT_TYPES.has(nested)) node.classList.add("hot");
  node.textContent = `${label}\n${JSON.stringify(event, null, 2)}`;
  logEl.prepend(node);
}

function downloadLog() {
  const blob = new Blob([JSON.stringify(eventLog, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `gpt-live-1-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function cleanup() {
  cancelAnimationFrame(meterRaf ?? 0);
  meterCtx?.close().catch(() => {});
  meterCtx = undefined;
  clearTimeout(closeTimeout);
  microphone?.getTracks().forEach((track) => track.stop());
  events?.close();
  peer?.close();
  audio.srcObject = null;
  ready = false;
  muted = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
  muteBtn.disabled = true;
  muteBtn.textContent = "ミュート";
  injectInput.disabled = true;
  injectSubmit.disabled = true;
  voiceSelect.disabled = false;
  extraInput.disabled = false;
  webSearchInput.disabled = false;
  levelEl.style.width = "0";
}

function setStatus(text) {
  statusEl.textContent = text;
}

function waitForIce(connection) {
  if (connection.iceGatheringState === "complete") return;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      connection.removeEventListener("icegatheringstatechange", onState);
      reject(new Error("Timed out while gathering ICE candidates"));
    }, 10_000);
    function onState() {
      if (connection.iceGatheringState !== "complete") return;
      clearTimeout(timeout);
      connection.removeEventListener("icegatheringstatechange", onState);
      resolve(undefined);
    }
    connection.addEventListener("icegatheringstatechange", onState);
    onState();
  });
}

function startMeter(stream) {
  meterCtx?.close().catch(() => {});
  const ctx = new AudioContext();
  meterCtx = ctx;
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const sample of data) {
      const v = (sample - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    levelEl.style.width = `${Math.min(100, rms * 280)}%`;
    meterRaf = requestAnimationFrame(tick);
  };
  tick();
}
