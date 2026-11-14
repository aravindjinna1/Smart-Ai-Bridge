const { ObjectId } = require("mongodb");
const { getCollections } = require("./db");

const DEFAULT_INTERVIEW_TEMPLATE = [
  "Answer clearly in natural, conversational, interview-ready English without heavy jargon so I can speak or deliver this directly in an interview.",
  "Format the response cleanly with Markdown headings (##), concise bullet points, **bold** key terms, and labeled fenced code blocks (```language) whenever code helps explain the concept.",
  "",
  "For technical or programming questions, strictly follow these 5 steps:",
  "## 1. Definition (What is it?)",
  "Start with a simple, technically accurate definition.",
  "",
  "## 2. Purpose (Why do we use it?)",
  "Explain the problem it solves or why developers need it.",
  "",
  "## 3. Working (How does it work?)",
  "Explain its internal working or execution flow clearly step by step.",
  "",
  "## 4. Practical Example (Where do we use it?)",
  "Give a real-world development example, preferably from MERN projects, and include a clean code snippet if helpful.",
  "",
  "## 5. Important Point (What should we remember?)",
  "Mention a limitation, advantage, best practice, or common mistake.",
  "",
  "If the question is a Multiple-Choice Question (MCQ) or non-technical HR question, answer naturally using clear headings without forcing code."
].join("\n");

const { getAnswerStylePreset } = require("./interview-helpers");

function normalizeTemplateSettings(doc = {}) {
  const preset = getAnswerStylePreset(doc.answerStyle);
  return {
    role: String(doc.role || "").trim().slice(0, 120),
    experience: String(doc.experience || "").trim().slice(0, 80),
    techStack: String(doc.techStack || "").trim().slice(0, 400),
    companyName: String(doc.companyName || "").trim().slice(0, 120),
    keyDetails: String(doc.keyDetails || "").trim().slice(0, 1500),
    resumeText: String(doc.resumeText || "").trim().slice(0, 10000),
    jobDescription: String(doc.jobDescription || "").trim().slice(0, 6000),
    customTemplate: String(doc.customTemplate || "").trim().slice(0, 6000),
    answerStyle: preset.id,
    interviewMode: doc.interviewMode === undefined ? true : Boolean(doc.interviewMode),
    autoSendOnSilence: Boolean(doc.autoSendOnSilence),
    contextWindowEnabled: doc.contextWindowEnabled === undefined ? true : Boolean(doc.contextWindowEnabled),
    teleprompterMode: Boolean(doc.teleprompterMode),
    autoFallbackEnabled: doc.autoFallbackEnabled === undefined ? true : Boolean(doc.autoFallbackEnabled),
    regionSelectBeforeOcr: doc.regionSelectBeforeOcr === undefined ? true : Boolean(doc.regionSelectBeforeOcr),
    compactMode: Boolean(doc.compactMode),
    updatedAt: doc.updatedAt || null
  };
}

async function getUserTemplateSettings(userId) {
  if (!ObjectId.isValid(userId)) return normalizeTemplateSettings({});
  const { templates } = await getCollections();
  const doc = await templates.findOne({ userId: new ObjectId(userId) });
  return normalizeTemplateSettings(doc || {});
}

async function saveUserTemplateSettings(userId, incoming = {}) {
  if (!ObjectId.isValid(userId)) {
    const err = new Error("Invalid user session.");
    err.status = 401;
    throw err;
  }

  const existing = await getUserTemplateSettings(userId);
  const pick = (key) => (incoming[key] !== undefined ? incoming[key] : existing[key]);
  const merged = normalizeTemplateSettings({
    role: pick("role"),
    experience: pick("experience"),
    techStack: pick("techStack"),
    companyName: pick("companyName"),
    keyDetails: pick("keyDetails"),
    resumeText: pick("resumeText"),
    jobDescription: pick("jobDescription"),
    customTemplate: pick("customTemplate"),
    answerStyle: pick("answerStyle"),
    interviewMode: pick("interviewMode"),
    autoSendOnSilence: pick("autoSendOnSilence"),
    contextWindowEnabled: pick("contextWindowEnabled"),
    teleprompterMode: pick("teleprompterMode"),
    autoFallbackEnabled: pick("autoFallbackEnabled"),
    regionSelectBeforeOcr: pick("regionSelectBeforeOcr"),
    compactMode: pick("compactMode")
  });

  if (merged.customTemplate === DEFAULT_INTERVIEW_TEMPLATE.trim()) {
    merged.customTemplate = "";
  }

  const { templates } = await getCollections();
  const now = new Date();
  const uid = new ObjectId(userId);
  await templates.updateOne(
    { userId: uid },
    {
      $set: {
        role: merged.role,
        experience: merged.experience,
        techStack: merged.techStack,
        companyName: merged.companyName,
        keyDetails: merged.keyDetails,
        resumeText: merged.resumeText,
        jobDescription: merged.jobDescription,
        customTemplate: merged.customTemplate,
        answerStyle: merged.answerStyle,
        interviewMode: merged.interviewMode,
        autoSendOnSilence: merged.autoSendOnSilence,
        contextWindowEnabled: merged.contextWindowEnabled,
        teleprompterMode: merged.teleprompterMode,
        autoFallbackEnabled: merged.autoFallbackEnabled,
        regionSelectBeforeOcr: merged.regionSelectBeforeOcr,
        compactMode: merged.compactMode,
        updatedAt: now
      },
      $setOnInsert: {
        userId: uid,
        createdAt: now
      }
    },
    { upsert: true }
  );

  return { ...merged, updatedAt: now };
}

function buildPersonalizedProfileBlock(profile = {}) {
  const lines = [];
  if (profile.role) lines.push(`- Target Role: ${profile.role}`);
  if (profile.experience) lines.push(`- Experience Level: ${profile.experience}`);
  if (profile.techStack) lines.push(`- Tech Stack / Skills: ${profile.techStack}`);
  if (profile.companyName) lines.push(`- Target Company: ${profile.companyName}`);
  if (profile.keyDetails) lines.push(`- Key Focus / Interview Details: ${profile.keyDetails}`);

  if (lines.length === 0) return "";
  return [
    "[INTERVIEW CANDIDATE PROFILE]",
    "Tailor the depth, terminology, tone, and practical examples in your answer specifically to this candidate profile:",
    ...lines
  ].join("\n");
}

module.exports = {
  DEFAULT_INTERVIEW_TEMPLATE,
  normalizeTemplateSettings,
  getUserTemplateSettings,
  saveUserTemplateSettings,
  buildPersonalizedProfileBlock
};
