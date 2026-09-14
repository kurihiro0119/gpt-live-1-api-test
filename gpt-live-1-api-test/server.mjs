import express from "express";
import OpenAI from "openai";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), ".env");
loadDotEnv(envPath);

const app = express();
const port = Number(process.env.PORT || 3000);
const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "public");
const allowedOrigins = new Set([
  `http://localhost:${port}`,
  `http://127.0.0.1:${port}`,
]);

const VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "quartz",
  "ripple",
  "vesper",
  "willow",
  "stone",
  "gleam",
  "meridian",
  "bossa",
  "tempo",
  "beacon",
  "delta",
  "cinder",
];

const LIVE_INSTRUCTIONS = `あなたは Live、日本語の音声検証アシスタントです。落ち着いて短く、自然に話してください。過度に明るい口調は不要です。
ユーザーが英語で話したら英語に合わせ、戻したら日本語に戻してください。

Backchannel policy: Use moderate backchannels. 相槌は「うん」「はい」程度で、本筋の返答と被らせない。

Interruption policy: Stop speaking when the user interrupts. Listen to what they say.

Delegation policy:
Backend tools:
- Web search: 最新の事実、ニュース、公開情報の検索

Delegate to the backend when:
- 最新情報やウェブ上の事実確認が必要
- 進行中の検索対象が訂正された

Do not delegate to the backend when:
- 会話から答えられる
- 簡単な確認で足りる

Delegate before giving an answer that depends on backend work.
Do not guess the result while waiting.`;

const BACKEND_INSTRUCTIONS = `You help a Japanese voice assistant. Transcripts may be messy.
Use web search when current facts are needed.
Return concise, grounded results the voice model can speak in 1-3 sentences.
If the user changes the request mid-task, follow the latest request.`;

app.use(express.json({ limit: "64kb" }));
app.use(express.static(publicDir));

app.get("/api/config", (_request, response) => {
  loadDotEnv(envPath);
  response.json({
    model: "gpt-live-1",
    backendModel: process.env.BACKEND_MODEL || "gpt-5.6-terra",
    voices: VOICES,
    hasApiKey: Boolean(process.env.OPENAI_API_KEY),
  });
});

app.post("/api/session", async (request, response) => {
  if (!allowedOrigins.has(request.headers.origin ?? "")) {
    response.status(403).json({ error: "Unexpected request origin" });
    return;
  }
  if (typeof request.body?.sdp !== "string" || !request.body.sdp.trim()) {
    response.status(400).json({ error: "An SDP offer is required" });
    return;
  }
  const client = getClient();
  if (!client) {
    response.status(503).json({ error: "Set OPENAI_API_KEY in .env" });
    return;
  }

  const voice = VOICES.includes(request.body.voice)
    ? request.body.voice
    : "marin";
  const extra =
    typeof request.body.instructions === "string"
      ? request.body.instructions.trim().slice(0, 2000)
      : "";
  const useWebSearch = request.body.webSearch !== false;
  const backendModel = process.env.BACKEND_MODEL || "gpt-5.6-terra";

  /** @type {import("openai/resources/live/live").MediaSessionConfig} */
  const session = {
    model: "gpt-live-1",
    instructions: extra
      ? `${LIVE_INSTRUCTIONS}\n\nAdditional style:\n${extra}`
      : LIVE_INSTRUCTIONS,
    audio: { output: { voice } },
  };

  if (useWebSearch) {
    session.delegation = {
      type: "responses",
      responses: {
        model: backendModel,
        instructions: BACKEND_INSTRUCTIONS,
        tools: [{ type: "web_search" }],
        tool_choice: "auto",
      },
    };
  }

  try {
    const result = await client.live.create({
      session,
      transport: { type: "webrtc", sdp: request.body.sdp },
    });
    response.status(201).json(result);
  } catch (error) {
    if (!(error instanceof OpenAI.APIError)) throw error;
    console.error("Live session creation failed", error.status, error.message);
    response.status(error.status ?? 502).json({
      error: error.message || "Live session creation failed",
      code: error.code,
      type: error.type,
    });
  }
});

app.listen(port, "127.0.0.1", () => {
  console.log(`GPT-Live-1 lab → http://localhost:${port}`);
  if (!process.env.OPENAI_API_KEY) {
    console.warn("OPENAI_API_KEY is not set. Copy .env.example to .env");
  }
});

function getClient() {
  loadDotEnv(envPath);
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
