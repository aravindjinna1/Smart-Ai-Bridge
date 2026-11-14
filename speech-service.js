const { GoogleGenAI, Modality } = require("@google/genai");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { cleanInterviewTranscript } = require("./interview-helpers");

const WHISPER_MODEL = "onnx-community/whisper-tiny.en";
const WHISPER_CACHE_DIR = path.join(os.tmpdir(), "ai-bridge-whisper");

let whisperPipelinePromise = null;

const SILENCE_HALLUCINATIONS = new Set([
  "you",
  "you.",
  "thank you",
  "thank you.",
  "thanks for watching",
  "thanks for watching.",
  "bye",
  "bye.",
  "okay",
  "ok",
  "[blank_audio]",
  "[silence]",
  "[music]",
  "(music)",
  "(silence)",
  "[applause]",
  "..."
]);

function ensureWhisperCacheDir() {
  try {
    fs.mkdirSync(WHISPER_CACHE_DIR, { recursive: true });
  } catch {
    // Non-fatal
  }
}

async function getWhisperPipeline() {
  if (!whisperPipelinePromise) {
    ensureWhisperCacheDir();
    whisperPipelinePromise = (async () => {
      try {
        const { pipeline, env } = await import("@huggingface/transformers");
        env.cacheDir = WHISPER_CACHE_DIR;
        env.allowLocalModels = true;
        const asr = await pipeline("automatic-speech-recognition", WHISPER_MODEL, {
          dtype: "q8"
        });
        return asr;
      } catch (err) {
        whisperPipelinePromise = null;
        throw new Error(
          `Local Whisper initialization failed: ${err?.message || "Could not load speech model."}`
        );
      }
    })();
  }
  return whisperPipelinePromise;
}

function warmUpLocalWhisper() {
  getWhisperPipeline().catch((err) => {
    console.warn("Whisper warm-up deferred:", err?.message || err);
  });
}

function getSpeechEngineInfo(geminiKey) {
  if (geminiKey && String(geminiKey).trim()) {
    return {
      engine: "gemini-live",
      model: "gemini-3.5-transcribe-live",
      label: "Gemini Live Transcribe"
    };
  }
  return {
    engine: "local-whisper",
    model: WHISPER_MODEL,
    label: "Local Whisper (Fast Offline)"
  };
}

/**
 * Convert Int16 LE mono 16kHz PCM buffer to Float32Array [-1, 1],
 * trim leading/trailing silence, and compute RMS/peak energy.
 */
function preparePcmFloat32(pcmInt16Buffer) {
  if (!Buffer.isBuffer(pcmInt16Buffer) || pcmInt16Buffer.length < 3200) {
    // Less than 0.1s at 16kHz 16-bit mono
    return { float32: null, rms: 0, peak: 0 };
  }

  const sampleCount = Math.floor(pcmInt16Buffer.length / 2);
  const raw = new Float32Array(sampleCount);
  let sumSq = 0;
  let peak = 0;

  for (let i = 0; i < sampleCount; i++) {
    const s = pcmInt16Buffer.readInt16LE(i * 2) / 32768;
    raw[i] = s;
    sumSq += s * s;
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
  }

  const rms = Math.sqrt(sumSq / sampleCount);
  if (rms < 0.006 && peak < 0.025) {
    return { float32: null, rms, peak };
  }

  // Trim silent edges (keep 1600 samples = 100ms padding on each side)
  const frameThresh = Math.max(0.012, peak * 0.08);
  let start = 0;
  let end = sampleCount - 1;
  while (start < sampleCount && Math.abs(raw[start]) < frameThresh) start++;
  while (end > start && Math.abs(raw[end]) < frameThresh) end--;

  const pad = 1600;
  const trimStart = Math.max(0, start - pad);
  const trimEnd = Math.min(sampleCount, end + pad);
  const trimmed = raw.subarray(trimStart, trimEnd);

  if (trimmed.length < 2400) {
    return { float32: null, rms, peak };
  }

  return { float32: trimmed, rms, peak };
}

function cleanTranscriptText(rawText, rms = 1) {
  if (!rawText || typeof rawText !== "string") return "";
  const cleaned = rawText
    .replace(/\[BLANK_AUDIO\]/gi, "")
    .replace(/\[MUSIC\]/gi, "")
    .replace(/\[SILENCE\]/gi, "")
    .replace(/\(music\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";
  const lower = cleaned.toLowerCase();
  if (SILENCE_HALLUCINATIONS.has(lower) && rms < 0.03) {
    return "";
  }
  if (/^[^\w]+$/.test(cleaned)) return "";
  return cleanInterviewTranscript(cleaned);
}

function wrapPcm16AsWav(pcmInt16Buffer, sampleRate = 16000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmInt16Buffer.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmInt16Buffer]);
}

async function transcribePcm16(pcmInt16Buffer, geminiKey = "") {
  const startMs = Date.now();
  const { float32, rms } = preparePcmFloat32(pcmInt16Buffer);
  if (!float32) {
    return { ok: true, text: "", skippedSilence: true, durationMs: Date.now() - startMs };
  }

  // If Gemini API key is configured, prefer gemini-3.5-transcribe for unary audio chunks
  if (geminiKey && String(geminiKey).trim()) {
    try {
      const ai = new GoogleGenAI({
        apiKey: String(geminiKey).trim(),
        httpOptions: { headers: { "User-Agent": "aistudio-build" } }
      });
      const wavBuffer = wrapPcm16AsWav(pcmInt16Buffer, 16000);
      const response = await ai.models.generateContent({
        model: "gemini-3.5-transcribe",
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: "audio/wav",
                data: wavBuffer.toString("base64")
              }
            },
            {
              text: "Transcribe the spoken speech accurately into clean text. Only return the spoken words; if there is only background noise or silence, return an empty string."
            }
          ]
        }
      });
      const text = cleanTranscriptText(response.text || "", rms);
      return {
        ok: true,
        text,
        engine: "gemini-transcribe",
        durationMs: Date.now() - startMs
      };
    } catch (err) {
      console.warn("Gemini transcribe failed, falling back to local Whisper:", err?.message || err);
    }
  }

  // Fast local Whisper transcription (no API key required)
  const asr = await getWhisperPipeline();
  const result = await asr(float32);
  const text = cleanTranscriptText(result?.text || "", rms);
  return {
    ok: true,
    text,
    engine: "local-whisper",
    durationMs: Date.now() - startMs
  };
}

async function createGeminiLiveTranscriptionSession({ apiKey, onInterim, onTranscript, onError, onReady }) {
  const ai = new GoogleGenAI({
    apiKey: String(apiKey).trim(),
    httpOptions: { headers: { "User-Agent": "aistudio-build" } }
  });

  const session = await ai.live.connect({
    model: "gemini-3.5-transcribe-live",
    config: {
      responseModalities: [Modality.TEXT],
      inputAudioTranscription: {
        languageCodes: []
      }
    },
    callbacks: {
      onopen: () => {
        if (onReady) onReady();
      },
      onmessage: (message) => {
        const content = message?.serverContent;
        if (content?.interimInputTranscription?.text && onInterim) {
          onInterim(content.interimInputTranscription.text);
        }
        if (content?.inputTranscription?.text && onTranscript) {
          onTranscript(content.inputTranscription.text);
        }
      },
      onerror: (err) => {
        if (onError) onError(err);
      }
    }
  });

  return session;
}

module.exports = {
  getSpeechEngineInfo,
  warmUpLocalWhisper,
  transcribePcm16,
  createGeminiLiveTranscriptionSession,
  cleanTranscriptText,
  preparePcmFloat32
};
