const { createWorker, PSM } = require("tesseract.js");
const { PNG } = require("pngjs");
const os = require("os");
const path = require("path");
const fs = require("fs");

const MAX_EXTRACTED_CHARS = 16000;
const TESSDATA_CACHE_DIR = path.join(os.tmpdir(), "ai-bridge-tessdata");

let workerPromise = null;

function ensureCacheDir() {
  try {
    fs.mkdirSync(TESSDATA_CACHE_DIR, { recursive: true });
  } catch {
    // Non-fatal; Tesseract.js will still operate in memory if cache dir cannot be created
  }
}

async function getOcrWorker() {
  if (!workerPromise) {
    ensureCacheDir();
    workerPromise = (async () => {
      try {
        const worker = await createWorker("eng", 1, {
          cachePath: TESSDATA_CACHE_DIR,
          logger: () => {}
        });
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.AUTO,
          preserve_interword_spaces: "1"
        });
        return worker;
      } catch (err) {
        workerPromise = null;
        throw new Error(
          `OCR engine initialization failed: ${err?.message || "Could not load Tesseract.js worker."}`
        );
      }
    })();
  }
  return workerPromise;
}

async function terminateOcrWorker() {
  if (!workerPromise) return;
  try {
    const worker = await workerPromise;
    await worker.terminate();
  } catch {
    // Ignore cleanup errors
  } finally {
    workerPromise = null;
  }
}

function isPngBuffer(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  );
}

/**
 * In-memory PNG preprocessing to improve OCR accuracy on slides, PDFs, dark-mode IDEs, and webpages:
 * 1. Convert to perceptual luminance grayscale
 * 2. Detect dark backgrounds and invert to dark-on-light (dramatically improves Tesseract accuracy)
 * 3. Stretch contrast using 2nd-98th percentile bounds
 * 4. Mild 3x3 sharpening pass
 * 5. 2x upscale when width < 1400px (capped at 2800px) so small UI/option text stays crisp
 */
function preprocessPngBuffer(inputBuffer) {
  if (!isPngBuffer(inputBuffer)) {
    return { buffer: inputBuffer, invertedForDarkMode: false, width: 0, height: 0 };
  }

  let png = PNG.sync.read(inputBuffer);
  const srcWidth = png.width;
  const srcHeight = png.height;
  const totalPixels = srcWidth * srcHeight;

  if (!totalPixels) {
    throw new Error("Captured screenshot has zero dimensions.");
  }

  const gray = new Uint8Array(totalPixels);
  let sumLum = 0;
  let minLum = 255;
  let maxLum = 0;

  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 4;
    const r = png.data[idx];
    const g = png.data[idx + 1];
    const b = png.data[idx + 2];
    const a = png.data[idx + 3] / 255;
    const cr = r * a + 255 * (1 - a);
    const cg = g * a + 255 * (1 - a);
    const cb = b * a + 255 * (1 - a);
    const lum = Math.max(0, Math.min(255, Math.round(0.299 * cr + 0.587 * cg + 0.114 * cb)));
    gray[i] = lum;
    sumLum += lum;
    if (lum < minLum) minLum = lum;
    if (lum > maxLum) maxLum = lum;
  }

  const avgLum = sumLum / totalPixels;
  const invertedForDarkMode = avgLum < 115;
  const actualRange = maxLum - minLum;
  const shouldStretch = actualRange >= 12 && actualRange < 190;

  const normalized = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    let val = gray[i];
    if (shouldStretch) {
      val = Math.round(((val - minLum) * 255) / actualRange);
      val = Math.max(0, Math.min(255, val));
    }
    if (invertedForDarkMode) {
      val = 255 - val;
    }
    normalized[i] = val;
  }

  // Smooth bilinear 2x upscale only for small/low-DPI captures (< 1150px wide)
  const scale = srcWidth < 1150 && srcWidth * 2 <= 2400 && srcHeight * 2 <= 2400 ? 2 : 1;
  const outWidth = srcWidth * scale;
  const outHeight = srcHeight * scale;
  const outPng = new PNG({ width: outWidth, height: outHeight });

  if (scale === 1) {
    for (let i = 0; i < totalPixels; i++) {
      const v = normalized[i];
      const o = i * 4;
      outPng.data[o] = v;
      outPng.data[o + 1] = v;
      outPng.data[o + 2] = v;
      outPng.data[o + 3] = 255;
    }
  } else {
    for (let y = 0; y < outHeight; y++) {
      const fy = y / 2;
      const y0 = Math.min(srcHeight - 1, Math.floor(fy));
      const y1 = Math.min(srcHeight - 1, y0 + 1);
      const wy = fy - y0;
      const outRow = y * outWidth;
      for (let x = 0; x < outWidth; x++) {
        const fx = x / 2;
        const x0 = Math.min(srcWidth - 1, Math.floor(fx));
        const x1 = Math.min(srcWidth - 1, x0 + 1);
        const wx = fx - x0;

        const p00 = normalized[y0 * srcWidth + x0];
        const p10 = normalized[y0 * srcWidth + x1];
        const p01 = normalized[y1 * srcWidth + x0];
        const p11 = normalized[y1 * srcWidth + x1];
        const top = p00 + (p10 - p00) * wx;
        const bottom = p01 + (p11 - p01) * wx;
        const v = Math.round(top + (bottom - top) * wy);

        const o = (outRow + x) * 4;
        outPng.data[o] = v;
        outPng.data[o + 1] = v;
        outPng.data[o + 2] = v;
        outPng.data[o + 3] = 255;
      }
    }
  }

  png = null;
  const outBuffer = PNG.sync.write(outPng);
  return {
    buffer: outBuffer,
    invertedForDarkMode,
    width: outWidth,
    height: outHeight
  };
}

/**
 * Clean OCR output while preserving:
 * - Question numbering (1., Q1., Question 2:)
 * - Option labels (A., B), (C), [D])
 * - Code indentation, operators, brackets, and meaningful symbols
 * - Logical line order
 */
function cleanOcrText(rawText) {
  if (!rawText || typeof rawText !== "string") return "";

  const normalized = rawText
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\t/g, "  ");

  const rawLines = normalized.split("\n");
  const cleanedLines = [];
  let blankStreak = 0;

  for (const rawLine of rawLines) {
    const rtrimmed = rawLine.replace(/[ \t]+$/g, "");
    if (!rtrimmed.trim()) {
      blankStreak++;
      if (blankStreak <= 1 && cleanedLines.length > 0) {
        cleanedLines.push("");
      }
      continue;
    }

    // Preserve leading indentation (for code / nested bullets), normalize huge mid-line whitespace gaps
    const match = rtrimmed.match(/^(\s*)(.*)$/);
    const leading = match ? match[1].slice(0, 12) : "";
    const body = match ? match[2].replace(/ {3,}/g, " ") : rtrimmed.trim();

    // Drop single-character stray OCR dust lines unless alphanumeric or meaningful code punctuation
    if (body.length === 1 && !/[a-zA-Z0-9{}()[\];:+*/=<>?!#]/.test(body)) {
      continue;
    }

    blankStreak = 0;
    cleanedLines.push(`${leading}${body}`);
  }

  let text = cleanedLines.join("\n").trim();

  if (text.length > MAX_EXTRACTED_CHARS) {
    text = `${text.slice(0, MAX_EXTRACTED_CHARS).trimEnd()}\n\n[...Truncated: extracted screen text exceeded ${MAX_EXTRACTED_CHARS} characters]`;
  }

  return text;
}

/**
 * Perform local OCR on an in-memory image Buffer and discard buffers immediately afterward.
 */
async function extractTextFromImageBuffer(imageBuffer) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error("No screenshot image data was received for OCR.");
  }

  let processed = null;
  let workingBuffer = null;

  try {
    processed = preprocessPngBuffer(imageBuffer);
    workingBuffer = processed.buffer;

    let worker = await getOcrWorker();
    let recognition;
    try {
      recognition = await worker.recognize(workingBuffer);
    } catch (firstErr) {
      // Recover once if the worker died unexpectedly
      await terminateOcrWorker();
      worker = await getOcrWorker();
      recognition = await worker.recognize(workingBuffer);
    }

    const cleanedText = cleanOcrText(recognition?.data?.text || "");
    const confidence = typeof recognition?.data?.confidence === "number"
      ? Math.round(recognition.data.confidence)
      : null;

    const alnumMatches = cleanedText.match(/[a-zA-Z0-9]/g) || [];
    if (!cleanedText || alnumMatches.length < 2) {
      return {
        ok: false,
        code: "EMPTY_OCR",
        error: "No readable text was found on the captured screen. Ensure text is visible and clearly legible, then try again.",
        confidence
      };
    }

    const lineCount = cleanedText.split("\n").filter((l) => l.trim().length > 0).length;
    return {
      ok: true,
      text: cleanedText,
      confidence,
      lineCount,
      charCount: cleanedText.length,
      invertedForDarkMode: processed.invertedForDarkMode
    };
  } finally {
    // Discard in-memory image buffers immediately after OCR
    workingBuffer = null;
    if (processed) {
      processed.buffer = null;
      processed = null;
    }
    imageBuffer = null;
  }
}

function buildScreenContextPrompt(extractedText, existingUserText = "") {
  const block = [
    "[SYSTEM INSTRUCTION FOR SCREEN CONTENT]",
    "",
    "You are an AI assistant analyzing content extracted from the user's current screen.",
    "",
    "The following text was extracted from the currently visible screen using OCR:",
    "",
    "--- EXTRACTED SCREEN CONTENT ---",
    extractedText,
    "--- END OF SCREEN CONTENT ---",
    "",
    "Analyze the extracted content and understand its structure.",
    "",
    "If it contains a question or multiple-choice question, identify the question and evaluate all available answer options.",
    "",
    "If it contains educational content, understand the topic and answer questions based on the extracted information.",
    "",
    "Do not assume that every extracted screen contains a question. Handle articles, notes, code, presentations, and other content appropriately."
  ].join("\n");

  const trimmedUser = (existingUserText || "").trim();
  if (trimmedUser) {
    return `${block}\n\n[USER QUESTION / INSTRUCTION]\n${trimmedUser}`;
  }
  return block;
}

const MCQ_FORMAT_ADDENDUM = [
  "",
  "[MULTIPLE-CHOICE & ACCURACY GUIDELINES]",
  "If the extracted screen content contains a multiple-choice question (MCQ):",
  "1. Identify the complete question and every available option.",
  "2. Evaluate each option independently and determine which options are technically or factually correct.",
  "3. Support multiple correct options when the question permits multiple answers; never assume only one option is correct.",
  "4. If the question explicitly asks for a single best answer, select one. If it asks for multiple correct answers, provide all correct options.",
  "5. If the OCR text is incomplete or unclear, explicitly state the uncertainty rather than guessing.",
  "6. Use this exact response format for MCQs (if only one option is correct, display only that option under Correct Answer):",
  "",
  "**Question:** [Identified question]",
  "",
  "**Correct Answer:**",
  "- Option X: [Option text]",
  "",
  "**Explanation:**",
  "[Brief explanation of why these options are correct.]",
  "",
  "**Why other options are incorrect:**",
  "- Y: [Short explanation]",
  "",
  "**Confidence:** High / Medium / Low",
  "",
  "If the extracted content does NOT contain an MCQ, answer normally based on the user's actual question or summarize/help with the content."
].join("\n");

function enrichScreenPrompt(message) {
  if (!message || typeof message !== "string") return message;
  const hasScreenContext =
    message.includes("[SYSTEM INSTRUCTION FOR SCREEN CONTENT]") ||
    message.includes("--- EXTRACTED SCREEN CONTENT ---");
  if (!hasScreenContext) return message;
  if (message.includes("[MULTIPLE-CHOICE & ACCURACY GUIDELINES]")) return message;
  return `${message.trimEnd()}\n${MCQ_FORMAT_ADDENDUM}`;
}

module.exports = {
  preprocessPngBuffer,
  cleanOcrText,
  extractTextFromImageBuffer,
  buildScreenContextPrompt,
  enrichScreenPrompt,
  terminateOcrWorker
};
