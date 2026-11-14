const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ANSWER_STYLES,
  cleanInterviewTranscript,
  getAnswerStylePreset,
  buildResumeAndJdBlock,
  buildConversationContextBlock,
  buildTeleprompterInstruction,
  getFallbackProviderOrder,
  buildMockQuizPromptFromBookmarks
} = require("./interview-helpers");

test("cleanInterviewTranscript normalizes spoken technical terms", () => {
  assert.equal(
    cleanInterviewTranscript("what is no js and use effect in react js with mongo db"),
    "what is Node.js and useEffect in React.js with MongoDB"
  );
  assert.equal(
    cleanInterviewTranscript("how does j w t and graph ql work with type script"),
    "how does JWT and GraphQL work with TypeScript"
  );
  assert.equal(cleanInterviewTranscript("   "), "");
});

test("getAnswerStylePreset returns valid presets and falls back to deep_technical", () => {
  assert.equal(getAnswerStylePreset("quick_spoken").id, "quick_spoken");
  assert.equal(getAnswerStylePreset("coding_dsa").id, "coding_dsa");
  assert.equal(getAnswerStylePreset("system_design").id, "system_design");
  assert.equal(getAnswerStylePreset("behavioral_star").id, "behavioral_star");
  assert.equal(getAnswerStylePreset("nonexistent").id, "deep_technical");
  assert.ok(Object.keys(ANSWER_STYLES).length === 5);
});

test("buildResumeAndJdBlock includes resume and JD safely", () => {
  const out = buildResumeAndJdBlock({
    resumeText: "Built payment checkout handling 10k RPS in Node.js",
    jobDescription: "Looking for Senior MERN engineer with Redis experience"
  });
  assert.ok(out.includes("[CANDIDATE RESUME HIGHLIGHTS]"));
  assert.ok(out.includes("10k RPS"));
  assert.ok(out.includes("[TARGET JOB DESCRIPTION]"));
  assert.ok(out.includes("Redis experience"));
  assert.equal(buildResumeAndJdBlock({}), "");
});

test("buildConversationContextBlock formats recent turns within budget", () => {
  const msgs = [
    { role: "user", text: "What is caching?" },
    { role: "assistant", text: "Caching stores frequently read data in memory." },
    { role: "user", text: "What about eviction policies?" },
    { role: "assistant", text: "LRU and LFU are common eviction policies." }
  ];
  const ctx = buildConversationContextBlock(msgs, 2, 1000);
  assert.ok(ctx.includes("[RECENT CONVERSATION CONTEXT]"));
  assert.ok(ctx.includes("Previous Question: What is caching?"));
  assert.ok(ctx.includes("Previous AI Answer: LRU and LFU"));
  assert.equal(buildConversationContextBlock([]), "");
});

test("getFallbackProviderOrder skips primary and respects Direct API keys", () => {
  const direct = getFallbackProviderOrder("chatgpt", {
    directApiMode: true,
    userKeys: { chatgpt: "sk-1", gemini: "AIza-1", claude: "sk-ant-1", deepai: "" }
  });
  assert.deepEqual(direct, ["gemini", "claude"]);

  const bridge = getFallbackProviderOrder("deepai", { directApiMode: false });
  assert.equal(bridge[0], "gemini");
  assert.ok(!bridge.includes("deepai"));
});

test("buildTeleprompterInstruction and buildMockQuizPromptFromBookmarks produce valid prompts", () => {
  assert.equal(buildTeleprompterInstruction(false), "");
  assert.ok(buildTeleprompterInstruction(true).includes("[TELEPROMPTER SCANNING MODE]"));

  const quiz = buildMockQuizPromptFromBookmarks(
    [{ question: "Explain Node.js event loop", topic: "Node.js" }],
    { role: "Backend Engineer" }
  );
  assert.ok(quiz.includes("Backend Engineer"));
  assert.ok(quiz.includes("Explain Node.js event loop"));
});
