const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// Target NIM base URL
const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", proxy_target: NIM_BASE_URL });
});

// Proxy all /v1/* requests to NIM
app.all("/v1/*", async (req, res) => {
  const nimPath = req.path; // e.g. /v1/chat/completions
  const targetUrl = `${NIM_BASE_URL}${nimPath.replace("/v1", "")}`;

  // Forward the Authorization header from the client (their own API key)
  const authHeader = req.headers["authorization"];
  if (!authHeader) {
    return res.status(401).json({ error: "Missing Authorization header. Pass your NIM API key as Bearer token." });
  }

  try {
    const nimResponse = await axios({
      method: req.method,
      url: targetUrl,
      headers: {
        "Authorization": authHeader,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      data: req.body,
      responseType: "stream",
      timeout: 120000,
    });

    // Forward status and headers
    res.status(nimResponse.status);
    res.setHeader("Content-Type", nimResponse.headers["content-type"] || "application/json");

    // Stream the response back
    nimResponse.data.pipe(res);
  } catch (err) {
    if (err.response) {
      // Forward NIM error responses
      res.status(err.response.status);
      err.response.data.pipe(res);
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// Root info
app.get("/", (req, res) => {
  res.json({
    name: "NIM Proxy",
    usage: {
      janitor_ai_proxy_url: "https://YOUR-APP.onrender.com/v1/chat/completions",
      api_key: "Your own nvapi-... key from build.nvidia.com",
      model: "deepseek-ai/deepseek-v4-pro",
    },
    health: "/health",
  });
});

app.listen(PORT, () => {
  console.log(`NIM proxy running on port ${PORT}`);
  console.log(`Proxying requests to: ${NIM_BASE_URL}`);
});
