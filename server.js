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

app.get("/", (req, res) => res.json({ status: "ok", info: "NIM proxy — set proxy URL to /v1/chat/completions in Janitor AI" }));
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/v1/chat/completions", (req, res) => {
  const authHeader = req.headers["authorization"] || req.headers["x-api-key"] || "";
  const apiKey = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!apiKey) {
    return res.status(401).json({ error: { message: "No API key. Put your nvapi-... key in the API Key field.", type: "auth_error" } });
  }

  // Force stream off — Janitor AI proxy mode works better with full JSON
  const body = { ...req.body, stream: false };
  const bodyStr = JSON.stringify(body);

  console.log("→ POST /v1/chat/completions, model:", body.model);

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
      console.log("← NIM status:", nimRes.statusCode, "body length:", data.length);
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

// Also handle /v1/models so Janitor AI can list models
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
