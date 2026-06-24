const express = require("express");
const https = require("https");

const app = express();
const PORT = process.env.PORT || 3000;

const NIM_HOST = "integrate.api.nvidia.com";
const NIM_BASE_PATH = "/v1";

// CORS — allow everything
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, x-api-key, x-requested-with");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res) => res.json({
  status: "ok",
  trigger_words: {
    "!long": "forces min 400 tokens in response (stripped from message automatically)",
  },
  url_params: {
    "?reasoning=force": "force thinking mode on",
    "?reasoning=visible": "show <think> tags if model produces them",
    "?min_tokens=400": "minimum response length in tokens",
    "?system=your+prompt+here": "inject a system prompt at the top",
    "?stream=false": "disable streaming (not recommended — slower)",
  }
}));

app.get("/health", (req, res) => res.json({ status: "ok" }));

// ─── Helper: forward a request to NIM ────────────────────────────────────────
function nimRequest(path, method, apiKey, bodyStr) {
  return new Promise((resolve, reject) => {
    const headers = {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json",
    };
    if (bodyStr) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(
      { hostname: NIM_HOST, path: `${NIM_BASE_PATH}${path}`, method, headers },
      (nimRes) => {
        let data = "";
        nimRes.on("data", (chunk) => { data += chunk; });
        nimRes.on("end", () => resolve({ status: nimRes.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.setTimeout(300_000, () => { req.destroy(); reject(new Error("timeout")); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Helper: forward a STREAMING request to NIM ──────────────────────────────
function nimStreamRequest(path, apiKey, bodyStr, res) {
  return new Promise((resolve, reject) => {
    const headers = {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "Content-Length": Buffer.byteLength(bodyStr),
    };

    const req = https.request(
      { hostname: NIM_HOST, path: `${NIM_BASE_PATH}${path}`, method: "POST", headers },
      (nimRes) => {
        // If NIM returns an error status, collect the body and surface it
        if (nimRes.statusCode !== 200) {
          let errData = "";
          nimRes.on("data", (c) => { errData += c; });
          nimRes.on("end", () => {
            console.error(`← NIM error | status: ${nimRes.statusCode} | body: ${errData || "(empty)"}`);
            reject({ status: nimRes.statusCode, body: errData });
          });
          return;
        }

        // Pass SSE headers through to the client
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });

        // Pipe each chunk straight to the client as it arrives
        nimRes.on("data", (chunk) => res.write(chunk));
        nimRes.on("end", () => { res.end(); resolve(); });
      }
    );

    req.on("error", reject);
    req.setTimeout(300_000, () => {
      req.destroy();
      reject(new Error("NIM stream timed out after 5 minutes"));
    });
    req.write(bodyStr);
    req.end();
  });
}

// ─── POST /v1/chat/completions ────────────────────────────────────────────────
app.post("/v1/chat/completions", async (req, res) => {
  const authHeader = req.headers["authorization"] || req.headers["x-api-key"] || "";
  const apiKey = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!apiKey) {
    return res.status(401).json({
      error: { message: "No API key. Put your nvapi-... key in the API Key field.", type: "auth_error" }
    });
  }

  // ── URL query params ──
  const reasoning    = req.query.reasoning;
  const minTokensParam = req.query.min_tokens ? parseInt(req.query.min_tokens) : null;
  const systemInject = req.query.system ? decodeURIComponent(req.query.system) : null;
  // Streaming: on by default; pass ?stream=false to disable
  const wantStream   = req.query.stream !== "false";

  // ── Build body ──
  let body = { ...req.body };

  // ── Trigger word detection ──
  let triggeredMinTokens = minTokensParam;
  if (body.messages?.length > 0) {
    const lastMsg = { ...body.messages[body.messages.length - 1] };
    if (lastMsg.role === "user" && typeof lastMsg.content === "string") {
      if (lastMsg.content.includes("!long")) {
        triggeredMinTokens = 400;
        lastMsg.content = lastMsg.content.replace(/!long/g, "").trim();
        console.log("→ trigger: !long → min_tokens=400");
      }
    }
    body.messages = [...body.messages.slice(0, -1), lastMsg];
  }

  if (triggeredMinTokens && !isNaN(triggeredMinTokens)) {
    body.min_tokens = triggeredMinTokens;
  }

  // ── Inject system prompt ──
  if (systemInject) {
    const existing = body.messages || [];
    const hasSystem = existing.length > 0 && existing[0].role === "system";
    if (hasSystem) {
      body.messages = [
        { role: "system", content: systemInject + "\n\n" + existing[0].content },
        ...existing.slice(1),
      ];
    } else {
      body.messages = [{ role: "system", content: systemInject }, ...existing];
    }
    console.log("→ system prompt injected");
  }

  // ── Force thinking mode ──
  if (reasoning === "force") {
    body.thinking = { type: "enabled", budget_tokens: 5000 };
    console.log("→ reasoning=force: thinking enabled");
  }

  // ── Streaming vs non-streaming ──
  body.stream = wantStream;

  const bodyStr = JSON.stringify(body);
  console.log(
    `→ POST /v1/chat/completions | model: ${body.model} | min_tokens: ${body.min_tokens ?? "unset"} | reasoning: ${reasoning ?? "off"} | stream: ${wantStream}`
  );

  // ── Streaming path ──
  if (wantStream) {
    try {
      await nimStreamRequest("/chat/completions", apiKey, bodyStr, res);
    } catch (err) {
      console.error("Stream error:", err);
      // If headers not sent yet, return a proper JSON error
      if (!res.headersSent) {
        const status = err?.status ?? 504;
        let message = err?.body ?? err?.message ?? "Unknown streaming error";
        // Try to pass the NIM error JSON through if parseable
        try { message = JSON.parse(message); } catch (_) { /* keep as string */ }
        res.status(status).json({ error: { message, type: "proxy_error" } });
      }
    }
    return;
  }

  // ── Non-streaming path (fallback) ──
  try {
    const { status, body: rawBody } = await nimRequest("/chat/completions", "POST", apiKey, bodyStr);
    console.log(`← NIM status: ${status} | body length: ${rawBody.length}`);
    try {
      res.status(status).json(JSON.parse(rawBody));
    } catch (_) {
      res.status(500).json({ error: { message: "Failed to parse NIM response: " + rawBody.slice(0, 100), type: "proxy_error" } });
    }
  } catch (err) {
    console.error("NIM request error:", err.message);
    res.status(500).json({
      error: { message: err.message, type: "proxy_error" }
    });
  }
});

// ─── GET /v1/models ───────────────────────────────────────────────────────────
app.get("/v1/models", async (req, res) => {
  const authHeader = req.headers["authorization"] || req.headers["x-api-key"] || "";
  const apiKey = authHeader.replace(/^Bearer\s+/i, "").trim();

  try {
    const { status, body } = await nimRequest("/models", "GET", apiKey, null);
    try {
      res.status(status).json(JSON.parse(body));
    } catch (_) {
      res.status(500).json({ error: "Failed to parse models response" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`NIM proxy running on port ${PORT}`));
