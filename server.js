// server.js
import "dotenv/config";                 // carga .env
import express from "express";
import cors from "cors";
import multer from "multer";
import { createReadStream } from "fs";
import { writeFile } from "fs/promises";
import OpenAI from "openai";

const PORT = process.env.PORT || 5500;

// ---- Chequeo temprano ----
if (!process.env.OPENAI_API_KEY) {
  console.error("[FATAL] Falta OPENAI_API_KEY en .env");
  process.exit(1);
}

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({ storage: multer.memoryStorage() });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------
// Endpoint de salud
// ---------------------
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    port: PORT,
    hasKey: !!process.env.OPENAI_API_KEY
  });
});

// ---------------------
// Transcripción (STT)
// ---------------------
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "no_audio" });
    const tmp = `/tmp/input.webm`;
    await writeFile(tmp, req.file.buffer);

    const transcription = await client.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe", // modelo recomendado
      file: createReadStream(tmp),
      // language: "es" // opcional
    });

    res.json({ text: transcription.text || "" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "transcription_failed" });
  }
});

// ---------------------
// Clasificador de intent
// ---------------------
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
      `Devuelve solo un JSON: {"command":"<uno de la lista>","confidence":<0..1>}`;

    const chat = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemMsg },
        { role: "user", content: userMsg }
      ],
    });

    const json = JSON.parse(chat.choices[0].message.content);
    json.source = "openai";
    if (typeof json.confidence !== "number") json.confidence = 0.5;
    if (typeof json.command !== "string") json.command = null;

    res.json(json);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "intent_failed" });
  }
});

// ---------------------
app.listen(PORT, () => {
  console.log(`✅ API escuchando en http://localhost:${PORT}`);
});
