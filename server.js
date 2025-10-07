// server.js
import "dotenv/config";                 // opcional (fallback)
import express from "express";
import cors from "cors";
import multer from "multer";
import { createReadStream } from "fs";
import { writeFile } from "fs/promises";
import OpenAI from "openai";
import { setTimeout as wait } from "timers/promises";

const PORT = process.env.PORT || 5500;
const MOCKAPI_URL = "https://68e5388e8e116898997ee625.mockapi.io/apikey"; // tu endpoint
let OPENAI_API_KEY = null;
let KEY_SOURCE = null; // 'mockapi' | 'env'

// ==== Helper: fetch with timeout ====
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, ...options });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// ==== Extrae la key desde el body (soporta varios formatos) ====
function extractKeyFromBody(body) {
  // body puede ser: array [{id, key: "..."}] o objeto {api_key: "..."} u otro
  if (!body) return null;

  // Si es array, toma el primer elemento
  const candidate = Array.isArray(body) && body.length ? body[0] : body;

  const possibleFields = ["api_key", "apikey", "key", "token", "value", "secret", "apiKey"];
  for (const f of possibleFields) {
    if (candidate && Object.prototype.hasOwnProperty.call(candidate, f) && candidate[f]) {
      return String(candidate[f]).trim();
    }
  }

  // si contiene algo parecido a una clave (heurística): buscar cualquier string de longitud razonable
  if (candidate && typeof candidate === "object") {
    for (const k of Object.keys(candidate)) {
      const v = candidate[k];
      if (typeof v === "string" && v.length > 20) return v.trim();
    }
  }

  return null;
}

// ==== Intent: obtener key desde MockAPI con reintentos ====
async function loadKeyFromMockAPI(maxAttempts = 3, delayMs = 1500) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchWithTimeout(MOCKAPI_URL, { method: "GET" }, 8000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const key = extractKeyFromBody(body);
      if (key) {
        return key;
      } else {
        throw new Error("No se encontró campo con API key en la respuesta");
      }
    } catch (err) {
      console.warn(`[MockAPI] intento ${attempt} fallido: ${err.message}`);
      if (attempt < maxAttempts) await wait(delayMs);
    }
  }
  return null;
}

// ==== Inicialización: intenta cargar la key ====
async function initKey() {
  // 1) intentamos MockAPI
  try {
    const key = await loadKeyFromMockAPI(3, 1500);
    if (key) {
      OPENAI_API_KEY = key;
      KEY_SOURCE = "mockapi";
      console.log("[INFO] API key obtenida desde MockAPI");
      return;
    } else {
      console.warn("[WARN] No se obtuvo API key desde MockAPI");
    }
  } catch (err) {
    console.warn("[WARN] Error al consultar MockAPI:", err.message);
  }

  // 2) fallback: env
  if (process.env.OPENAI_API_KEY) {
    OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    KEY_SOURCE = "env";
    console.log("[INFO] Usando OPENAI_API_KEY desde environment (.env)");
    return;
  }

  // 3) no hay key -> abortar
  console.error("[FATAL] No se pudo obtener la API key (MockAPI ni env). Define una API key en MockAPI o en .env.");
  process.exit(1);
}

// ==== MAIN: configura servidor después de obtener la key ====
async function main() {
  await initKey();

  // Cliente OpenAI (usa la key al inicio)
  const client = new OpenAI({ apiKey: OPENAI_API_KEY });

  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));

  const upload = multer({ storage: multer.memoryStorage() });

  // Salud
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, port: PORT, keySource: KEY_SOURCE ? KEY_SOURCE : null });
  });

  // Transcribe (opcional)
  app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "no_audio" });
      const tmp = `/tmp/input.webm`;
      await writeFile(tmp, req.file.buffer);

      const transcription = await client.audio.transcriptions.create({
        model: "gpt-4o-mini-transcribe",
        file: createReadStream(tmp),
      });

      res.json({ text: transcription.text || "" });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "transcription_failed" });
    }
  });

  // Intent classifier
  app.post("/api/intent", async (req, res) => {
    try {
      const { text, commands } = req.body || {};
      if (typeof text !== "string" || !Array.isArray(commands) || !commands.length) {
        return res.status(400).json({ error: "bad_request" });
      }

      const systemMsg = "Eres un clasificador de intenciones que devuelve JSON estricto.";
      const userMsg =
        `Texto del usuario: "${text}". ` +
        `Elige el comando que mejor aplique de esta lista EXACTA: ${commands.join(", ")}. ` +
        `Devuelve sólo un JSON: {"command":"<uno de la lista>","confidence":<0..1>}`;

      // Llamada a OpenAI
      const chat = await client.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemMsg },
          { role: "user", content: userMsg }
        ],
      });

      let out = {};
      try {
        out = JSON.parse(chat.choices?.[0]?.message?.content ?? "{}");
      } catch {
        out = {};
      }

      const whitelist = new Set(commands.map(String));
      let { command = null, confidence = 0.5 } = out;
      if (!whitelist.has(command)) command = null;

      res.json({ command, confidence: Number(confidence) || 0.5, source: "openai" });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "intent_failed" });
    }
  });

  // Start server (intenta puerto y sube)
  app.listen(PORT, () => {
    console.log(`✅ API escuchando en http://localhost:${PORT} (key source: ${KEY_SOURCE})`);
  });
}

main().catch(err => {
  console.error("[FATAL] Error iniciando servidor:", err);
  process.exit(1);
});
