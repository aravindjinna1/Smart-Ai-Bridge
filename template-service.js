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

function normalizeTemplateSettings(doc = {}) {
  return {
    role: String(doc.role || "").trim().slice(0, 120),
    experience: String(doc.experience || "").trim().slice(0, 80),
    techStack: String(doc.techStack || "").trim().slice(0, 400),
    companyName: String(doc.companyName || "").trim().slice(0, 120),
    keyDetails: String(doc.keyDetails || "").trim().slice(0, 1500),
    customTemplate: String(doc.customTemplate || "").trim().slice(0, 6000),
    interviewMode: doc.interviewMode === undefined ? true : Boolean(doc.interviewMode),
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
  const merged = normalizeTemplateSettings({
    role: incoming.role !== undefined ? incoming.role : existing.role,
    experience: incoming.experience !== undefined ? incoming.experience : existing.experience,
    techStack: incoming.techStack !== undefined ? incoming.techStack : existing.techStack,
    companyName: incoming.companyName !== undefined ? incoming.companyName : existing.companyName,
    keyDetails: incoming.keyDetails !== undefined ? incoming.keyDetails : existing.keyDetails,
    customTemplate: incoming.customTemplate !== undefined ? incoming.customTemplate : existing.customTemplate,
    interviewMode: incoming.interviewMode !== undefined ? incoming.interviewMode : existing.interviewMode
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
        customTemplate: merged.customTemplate,
        interviewMode: merged.interviewMode,
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
