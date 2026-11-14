const ANSWER_STYLES = {
  quick_spoken: {
    id: "quick_spoken",
    label: "Quick Spoken (20-30s)",
    shortLabel: "Quick Spoken",
    description: "Short conversational summary + 3-4 speakable bullet points",
    instruction: [
      "Answer in natural, conversational, first-person spoken English that I can say directly out loud in 20 to 30 seconds.",
      "Keep it concise and punchy:",
      "## Quick Summary",
      "Give 1-2 crisp sentences directly answering the question.",
      "## Key Talking Points",
      "Give 3 to 4 short bullet points with **bold** anchor phrases so I can scan them in 2 seconds."
    ].join("\n")
  },
  deep_technical: {
    id: "deep_technical",
    label: "Deep Technical (5-Step)",
    shortLabel: "Deep Technical",
    description: "Definition, Purpose, Working, MERN Example & Important Point",
    instruction: [
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
    ].join("\n")
  },
  coding_dsa: {
    id: "coding_dsa",
    label: "Coding / DSA",
    shortLabel: "Coding / DSA",
    description: "Approach, Brute vs Optimal complexity, clean code & edge cases",
    instruction: [
      "Answer this coding / data-structures problem cleanly for a live technical coding round:",
      "## 1. Problem Understanding & Approach",
      "Summarize the goal and constraints in 2 lines.",
      "## 2. Brute Force vs Optimal Strategy",
      "Briefly note the naive approach, then explain the optimal algorithm step by step.",
      "## 3. Complexity",
      "State Time Complexity and Space Complexity clearly.",
      "## 4. Clean Solution Code",
      "Provide clean, bug-free, commented code in a labeled fenced code block (```javascript or requested language).",
      "## 5. Edge Cases to Mention",
      "List 3 key edge cases (empty input, duplicates, bounds, overflow)."
    ].join("\n")
  },
  system_design: {
    id: "system_design",
    label: "System Design",
    shortLabel: "System Design",
    description: "Requirements, Architecture, Schema/APIs, Scaling & Trade-offs",
    instruction: [
      "Structure your answer for a system design interview clearly so I can walk an interviewer through step by step:",
      "## 1. Functional & Non-Functional Requirements",
      "Clarify core features, scale assumptions, and latency/consistency goals.",
      "## 2. High-Level Architecture",
      "Describe clients, API gateway, services, queues, and storage flow cleanly.",
      "## 3. Data Model & Core APIs",
      "Outline key database collections/tables, indexes, and REST/WebSocket endpoints.",
      "## 4. Scaling, Caching & Bottlenecks",
      "Explain horizontal scaling, Redis caching, partitioning/sharding, rate limiting, and failure handling.",
      "## 5. Key Trade-Offs",
      "Highlight 2-3 architectural trade-offs and why you chose this design."
    ].join("\n")
  },
  behavioral_star: {
    id: "behavioral_star",
    label: "Behavioral / STAR",
    shortLabel: "STAR Method",
    description: "Situation, Task, Action & Result grounded in your projects",
    instruction: [
      "Craft a genuine, conversational first-person behavioral interview answer using the STAR method grounded specifically in my candidate profile, projects, and resume details (do not invent unrelated companies if my details are provided):",
      "## Situation",
      "Set brief context (team/project, scale, problem).",
      "## Task",
      "Clarify my exact responsibility or goal.",
      "## Action",
      "Explain 2-3 concrete technical or leadership actions I took.",
      "## Result & Reflection",
      "Share measurable impact, outcome, and what I learned."
    ].join("\n")
  }
};

const TECH_TERM_REPLACEMENTS = [
  [/\bno\s+js\b/gi, "Node.js"],
  [/\bnode\s+js\b/gi, "Node.js"],
  [/\bnode\s+dot\s+js\b/gi, "Node.js"],
  [/\breact\s+js\b/gi, "React.js"],
  [/\bnext\s+js\b/gi, "Next.js"],
  [/\bexpress\s+js\b/gi, "Express.js"],
  [/\bvue\s+js\b/gi, "Vue.js"],
  [/\bmongo\s+db\b/gi, "MongoDB"],
  [/\bmongo\s+d\s+b\b/gi, "MongoDB"],
  [/\bpost\s+gress(?:\s+sql)?\b/gi, "PostgreSQL"],
  [/\bpostgres\s+ql\b/gi, "PostgreSQL"],
  [/\bmy\s+sql\b/gi, "MySQL"],
  [/\btype\s+script\b/gi, "TypeScript"],
  [/\bjava\s+script\b/gi, "JavaScript"],
  [/\buse\s+effect\b/gi, "useEffect"],
  [/\buse\s+state\b/gi, "useState"],
  [/\buse\s+ref\b/gi, "useRef"],
  [/\buse\s+memo\b/gi, "useMemo"],
  [/\buse\s+callback\b/gi, "useCallback"],
  [/\buse\s+context\b/gi, "useContext"],
  [/\brest\s+api\b/gi, "REST API"],
  [/\bgraph\s+ql\b/gi, "GraphQL"],
  [/\bweb\s+sockets?\b/gi, (m) => (/s$/i.test(m) ? "WebSockets" : "WebSocket")],
  [/\bj\s*w\s*t\b/gi, "JWT"],
  [/\bo\s+auth\b/gi, "OAuth"],
  [/\bm\s+e\s+r\s+n\b/gi, "MERN"],
  [/\bci\s+cd\b/gi, "CI/CD"],
  [/\bred\s+is\b/gi, "Redis"],
  [/\bcube\s+control\b/gi, "kubectl"],
  [/\bkube\s+netes\b/gi, "Kubernetes"],
  [/\bdocker\s+compose\b/gi, "Docker Compose"]
];

function cleanInterviewTranscript(rawText) {
  let text = String(rawText || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  for (const [pattern, replacement] of TECH_TERM_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function getAnswerStylePreset(styleId) {
  const key = String(styleId || "").trim().toLowerCase();
  return ANSWER_STYLES[key] || ANSWER_STYLES.deep_technical;
}

function buildResumeAndJdBlock(profile = {}) {
  const resumeText = String(profile.resumeText || "").trim();
  const jobDescription = String(profile.jobDescription || "").trim();
  const blocks = [];
  if (resumeText) {
    const truncated = resumeText.length > 2400 ? `${resumeText.slice(0, 2400).trim()}...` : resumeText;
    blocks.push(`[CANDIDATE RESUME HIGHLIGHTS]\n${truncated}`);
  }
  if (jobDescription) {
    const truncated = jobDescription.length > 1600 ? `${jobDescription.slice(0, 1600).trim()}...` : jobDescription;
    blocks.push(`[TARGET JOB DESCRIPTION]\n${truncated}`);
  }
  return blocks.join("\n\n");
}

function buildConversationContextBlock(messages = [], maxTurns = 3, maxTotalChars = 2400) {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const sliceCount = Math.max(1, maxTurns) * 2;
  const recent = messages.slice(-sliceCount);
  const lines = [];
  let charBudget = maxTotalChars;

  for (let i = recent.length - 1; i >= 0; i--) {
    const msg = recent[i];
    if (!msg || !msg.text) continue;
    const roleLabel = msg.role === "assistant" ? "Previous AI Answer" : "Previous Question";
    let body = String(msg.text || "").replace(/\s+/g, " ").trim();
    if (body.length > 650) body = `${body.slice(0, 650).trim()}...`;
    const entry = `${roleLabel}: ${body}`;
    if (entry.length > charBudget && lines.length > 0) break;
    lines.unshift(entry);
    charBudget -= entry.length;
  }

  if (lines.length === 0) return "";
  return [
    "[RECENT CONVERSATION CONTEXT]",
    "If the new question is a follow-up, build directly on this recent exchange without repeating everything from scratch:",
    ...lines
  ].join("\n");
}

function buildTeleprompterInstruction(enabled) {
  if (!enabled) return "";
  return [
    "[TELEPROMPTER SCANNING MODE]",
    "Highlight ONLY the 4-5 most important anchor phrases per section using **bold** so the candidate can scan and speak them within 2 seconds while keeping eye contact with the camera."
  ].join("\n");
}

function getFallbackProviderOrder(primaryProvider, { directApiMode = false, userKeys = {} } = {}) {
  const primary = String(primaryProvider || "deepai").toLowerCase();
  if (directApiMode) {
    const directOrder = ["gemini", "chatgpt", "claude", "deepseek", "perplexity", "deepai"];
    return directOrder.filter((p) => p !== primary && Boolean(String(userKeys[p] || "").trim()));
  }
  const bridgeOrder = ["deepai", "gemini", "duckai", "chatgpt", "deepseek", "perplexity", "claude"];
  return bridgeOrder.filter((p) => p !== primary);
}

function buildMockQuizPromptFromBookmarks(bookmarks = [], profile = {}) {
  const items = Array.isArray(bookmarks) ? bookmarks.slice(0, 6) : [];
  const topicLines = items.map((b, idx) => {
    const q = String(b.question || "").replace(/\s+/g, " ").trim().slice(0, 220);
    const topic = b.topic ? ` (${b.topic})` : "";
    return `${idx + 1}.${topic} ${q}`;
  });
  const roleNote = profile.role ? `Target Role: ${profile.role}. ` : "";
  return [
    `You are conducting a focused post-interview practice quiz. ${roleNote}Based on these saved tough interview questions:`,
    ...topicLines,
    "",
    "Generate 5 realistic follow-up mock interview questions that test deeper understanding and edge cases, plus a concise **What interviewers look for** hint and a brief **Sample Strong Answer** under a collapsible/clear heading for each question."
  ].join("\n");
}

module.exports = {
  ANSWER_STYLES,
  cleanInterviewTranscript,
  getAnswerStylePreset,
  buildResumeAndJdBlock,
  buildConversationContextBlock,
  buildTeleprompterInstruction,
  getFallbackProviderOrder,
  buildMockQuizPromptFromBookmarks
};
