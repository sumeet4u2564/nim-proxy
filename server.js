const express = require("express");
const cors = require("cors");
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
    "!long": "forces min 500 tokens in response (strip from message automatically)",
  },
  url_params: {
    "?reasoning=force": "force thinking mode on",
    "?reasoning=visible": "show <think> tags if model produces them",
    "?min_tokens=200": "minimum response length in tokens",
    "?system=your+prompt+here": "inject a system prompt at the top",
  }
}));
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/v1/chat/completions", (req, res) => {
  const authHeader = req.headers["authorization"] || req.headers["x-api-key"] || "";
  const apiKey = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!apiKey) {
    return res.status(401).json({ error: { message: "No API key. Put your nvapi-... key in the API Key field.", type: "auth_error" } });
  }

  // URL query params
  const reasoning = req.query.reasoning;
  const minTokensParam = req.query.min_tokens ? parseInt(req.query.min_tokens) : null;
  const systemInject = req.query.system ? decodeURIComponent(req.query.system) : null;

  // Start with the body Janitor AI sent, force stream off
  let body = { ...req.body, stream: false };

  // --- Trigger word detection in the last user message ---
  let triggeredMinTokens = minTokensParam;
  if (body.messages && body.messages.length > 0) {
    const lastMsg = { ...body.messages[body.messages.length - 1] };
    if (lastMsg.role === "user" && typeof lastMsg.content === "string") {

      // !long — force 500 min tokens
      if (lastMsg.content.includes("!long")) {
        triggeredMinTokens = 600;
        lastMsg.content = lastMsg.content.replace(/!long/g, "").trim();
        console.log("→ trigger: !long → min_tokens=600 (~500 words)");
      }

    }
    // Put the cleaned message back
    body.messages = [
      ...body.messages.slice(0, -1),
      lastMsg,
    ];
  }

  // Apply min_tokens (from trigger word or URL param)
  if (triggeredMinTokens && !isNaN(triggeredMinTokens)) {
    body.min_tokens = triggeredMinTokens;
  }

  // Inject system prompt from URL param
  if (systemInject) {
    const existing = body.messages || [];
    const hasSystem = existing.length > 0 && existing[0].role === "system";
    if (hasSystem) {
      body.messages = [
        { role: "system", content: systemInject + "\n\n" + existing[0].content },
        ...existing.slice(1),
      ];
    } else {
      body.messages = [
        { role: "system", content: systemInject },
        ...existing,
      ];
    }
    console.log("→ system prompt injected");
  }

  // Force thinking mode from URL param
  if (reasoning === "force") {
    body.thinking = { type: "enabled", budget_tokens: 5000 };
    console.log("→ reasoning=force: thinking enabled");
  }

  const bodyStr = JSON.stringify(body);
  console.log("→ POST /v1/chat/completions | model:", body.model, "| min_tokens:", body.min_tokens || "unset", "| reasoning:", reasoning || "off");

  const options = {
    hostname: NIM_HOST,
    path: `${NIM_BASE_PATH}/chat/completions`,
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Content-Length": Buffer.byteLength(bodyStr),
    },
  };

  const nimReq = https.request(options, (nimRes) => {
    let data = "";
    nimRes.on("data", (chunk) => { data += chunk; });
    nimRes.on("end", () => {
      console.log("← NIM status:", nimRes.statusCode, "| body length:", data.length);
      try {
        const parsed = JSON.parse(data);
        res.status(nimRes.statusCode).json(parsed);
      } catch (e) {
        console.error("Failed to parse NIM response:", data.slice(0, 200));
        res.status(500).json({ error: { message: "Failed to parse NIM response: " + data.slice(0, 100), type: "proxy_error" } });
      }
    });
  });

  nimReq.on("error", (e) => {
    console.error("NIM request error:", e.message);
    res.status(500).json({ error: { message: e.message, type: "proxy_error" } });
  });

  nimReq.setTimeout(120000, () => {
    nimReq.destroy();
    res.status(504).json({ error: { message: "Request to NIM timed out", type: "timeout" } });
  });

  nimReq.write(bodyStr);
  nimReq.end();
});

// /v1/models so Janitor AI can validate the connection
app.get("/v1/models", (req, res) => {
  const authHeader = req.headers["authorization"] || req.headers["x-api-key"] || "";
  const apiKey = authHeader.replace(/^Bearer\s+/i, "").trim();

  const options = {
    hostname: NIM_HOST,
    path: `${NIM_BASE_PATH}/models`,
    method: "GET",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json",
    },
  };

  const nimReq = https.request(options, (nimRes) => {
    let data = "";
    nimRes.on("data", (chunk) => { data += chunk; });
    nimRes.on("end", () => {
      try {
        res.status(nimRes.statusCode).json(JSON.parse(data));
      } catch (e) {
        res.status(500).json({ error: "Failed to parse models response" });
      }
    });
  });
  nimReq.on("error", (e) => res.status(500).json({ error: e.message }));
  nimReq.end();
});

app.listen(PORT, () => console.log(`NIM proxy running on port ${PORT}`));
