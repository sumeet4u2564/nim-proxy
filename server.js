const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";

// Very explicit CORS — Janitor AI needs OPTIONS preflight to pass
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept", "x-api-key"],
  credentials: false,
}));

// Handle OPTIONS preflight immediately before anything else
app.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept, x-api-key");
  res.sendStatus(204);
});

app.use(express.json({ limit: "10mb" }));

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", proxy_target: NIM_BASE_URL });
});

// Root info
app.get("/", (req, res) => {
  res.json({
    name: "NIM Proxy",
    status: "running",
    usage: {
      proxy_url: "https://YOUR-APP.onrender.com/v1/chat/completions",
      api_key: "Your nvapi-... key from build.nvidia.com",
      model: "deepseek-ai/deepseek-v4-pro",
    },
  });
});

// Main proxy — catches /v1/chat/completions and any other /v1/* path
app.all("/v1/*", async (req, res) => {
  // Strip leading /v1 since NIM_BASE_URL already includes /v1
  const subPath = req.path.replace(/^\/v1/, "");
  const targetUrl = `${NIM_BASE_URL}${subPath}`;

  // Grab the API key — Janitor AI sends it as Bearer token
  const authHeader = req.headers["authorization"] || req.headers["x-api-key"];
  if (!authHeader) {
    return res.status(401).json({
      error: "No API key provided. Set your nvapi-... key in Janitor AI's API Key field."
    });
  }

  // Normalise: make sure it's "Bearer nvapi-..."
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader
    : `Bearer ${authHeader}`;

  // Disable streaming in the request body so NIM returns a clean JSON response
  // (Janitor AI can struggle with SSE streams through a proxy)
  let body = req.body;
  if (body && typeof body === "object") {
    body = { ...body, stream: false };
  }

  console.log(`→ ${req.method} ${targetUrl}`);

  try {
    const nimResponse = await axios({
      method: req.method,
      url: targetUrl,
      headers: {
        "Authorization": bearerToken,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      data: body,
      timeout: 120000,
      // Don't stream — get full response so we can forward it cleanly
      responseType: "json",
    });

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    res.status(nimResponse.status).json(nimResponse.data);

  } catch (err) {
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (err.response) {
      console.error(`NIM error ${err.response.status}:`, err.response.data);
      res.status(err.response.status).json(err.response.data);
    } else {
      console.error("Proxy error:", err.message);
      res.status(500).json({ error: err.message });
    }
  }
});

app.listen(PORT, () => {
  console.log(`NIM proxy running on port ${PORT}`);
});
