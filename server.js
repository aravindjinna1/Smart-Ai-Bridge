require("dotenv").config();
const express = require("express");
const { GoogleGenAI } = require("@google/genai");
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const { WebSocketServer } = require("ws");
const { extractTextFromImageBuffer, enrichScreenPrompt } = require("./ocr-service");
const {
  getSpeechEngineInfo,
  warmUpLocalWhisper,
  transcribePcm16,
  createGeminiLiveTranscriptionSession
} = require("./speech-service");
const { connectToDatabase, getDbStatus } = require("./db");
const {
  extractTokenFromRequest,
  verifyTokenPayload,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
  registerUser,
  loginUser,
  getUserById,
  getUserApiKeys,
  saveUserApiKeys,
  requestPasswordReset,
  verifyResetToken,
  resetPasswordWithToken
} = require("./auth-service");
const {
  listUserChats,
  createUserChat,
  getUserChatById,
  appendChatMessage,
  renameUserChat,
  deleteUserChat
} = require("./chat-history-service");
const {
  DEFAULT_INTERVIEW_TEMPLATE,
  getUserTemplateSettings,
  saveUserTemplateSettings,
  buildPersonalizedProfileBlock
} = require("./template-service");

const GEMINI_URL = "https://gemini.google.com/app";
const CHATGPT_URL = "https://chatgpt.com/";
const DEEPSEEK_URL = "https://chat.deepseek.com/";
const CLAUDE_URL = "https://claude.ai/new";
const DUCKAI_URL = "https://duck.ai/";
const DEEPAI_URL = "https://deepai.org/chat";
const PERPLEXITY_URL = "https://www.perplexity.ai/";

const PROVIDERS = {
  gemini: {
    name: "Gemini",
    url: GEMINI_URL,
    origin: "https://gemini.google.com/",
    prompt: [
      'rich-textarea .ql-editor',
      'rich-textarea [contenteditable="true"]',
      'div.ql-editor',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea'
    ],
    send: [
      'button[aria-label*="Send" i]',
      'button.send-button',
      'button[data-test-id="send-button"]'
    ],
    response: "message-content, .message-content, .model-response-text, [data-message-author-role=\"model\"]"
  },
  chatgpt: {
    name: "ChatGPT",
    url: CHATGPT_URL,
    origin: "https://chatgpt.com/",
    prompt: [
      '#prompt-textarea',
      '#mobile-composer-prompt',
      'textarea[data-id="root"]',
      'div[contenteditable="true"][data-placeholder]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea'
    ],
    send: [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send" i]',
      'button[data-testid="fruitjuice-send-button"]'
    ],
    response: '[data-message-author-role="assistant"], div.markdown, .agent-turn'
  },
  deepseek: {
    name: "DeepSeek",
    url: DEEPSEEK_URL,
    origin: "https://chat.deepseek.com/",
    prompt: [
      'textarea#chat-input',
      'textarea[placeholder*="DeepSeek" i]',
      'textarea[placeholder*="Message" i]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea'
    ],
    send: [
      'button[aria-label*="Send" i]',
      'div[role="button"][aria-disabled="false"]',
      'button[type="submit"]'
    ],
    response: '.ds-markdown, .ds-markdown--block, [class*="ds-markdown"]'
  },
  claude: {
    name: "Claude",
    url: CLAUDE_URL,
    origin: "https://claude.ai/",
    prompt: [
      'div[contenteditable="true"].ProseMirror',
      'div[contenteditable="true"][role="textbox"]',
      'fieldset div[contenteditable="true"]',
      '[contenteditable="true"][data-placeholder]',
      'textarea'
    ],
    send: [
      'button[aria-label*="Send" i]',
      'button[data-testid="send-button"]'
    ],
    response: '[data-testid="chat-message-content"], .font-claude-message, div.prose'
  },
  duckai: {
    name: "Duck.ai",
    url: DUCKAI_URL,
    origin: "https://duck.ai/",
    prompt: [
      'textarea[placeholder*="Ask anything" i]',
      'textarea[placeholder*="privately" i]',
      'textarea'
    ],
    send: [
      'button[aria-label="Ask"]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    response: '[data-testid="ChatsList"] [class*="markdown"], [data-testid="ChatsList"] .prose, [data-testid="assistant-message"], div[data-message-author="assistant"]'
  },
  deepai: {
    name: "DeepAI",
    url: DEEPAI_URL,
    origin: "https://deepai.org/",
    prompt: [
      '#persistentChatbox',
      'textarea.chatbox',
      'textarea[placeholder*="Message AI Chat" i]',
      'textarea'
    ],
    send: [
      '#chatSubmitButton',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    response: '.markdownContainer, .outputBox'
  },
  perplexity: {
    name: "Perplexity",
    url: PERPLEXITY_URL,
    origin: "https://www.perplexity.ai/",
    prompt: [
      'div.composer-editable[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'textarea[placeholder*="Ask" i]',
      'textarea'
    ],
    send: [
      'button[aria-label="Submit"]',
      'button[aria-label*="Send" i]',
      'button[type="submit"]'
    ],
    response: '.prose, [data-testid*="answer"]'
  }
};

const app = express();
app.use((req, res, next) => {
  res.setHeader("Permissions-Policy", "display-capture=*");
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let browser;
let context;
let page;
let browserConnectionMode = null;
let activeBrowserName = null;
const providerPages = new Map();
let busy = false;
let ocrBusy = false;

function getBrowserChannel() {
  const configuredBrowser = process.env.AI_BRIDGE_BROWSER?.trim().toLowerCase();
  if (configuredBrowser) {
    if (configuredBrowser === "chrome" || configuredBrowser === "msedge") return configuredBrowser;
    throw new Error('AI_BRIDGE_BROWSER must be set to "chrome" or "msedge".');
  }

  if (process.platform === "win32") {
    const registryKey = "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice";
    try {
      const output = execFileSync("reg.exe", ["query", registryKey, "/v", "ProgId"], {
        encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
      });
      const progId = output.match(/ProgId\s+REG_SZ\s+(\S+)/i)?.[1] || "";
      if (/edge/i.test(progId)) return "msedge";
      if (/chrome/i.test(progId)) return "chrome";
    } catch {
      console.log("Could not detect default Windows browser; using Chrome.");
    }
  }
  return "chrome";
}

function getDefaultBrowserProfileDir(channel) {
  const home = os.homedir();
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return null;
    if (channel === "msedge") return path.join(localAppData, "Microsoft", "Edge", "User Data");
    return path.join(localAppData, "Google", "Chrome", "User Data");
  }
  if (process.platform === "darwin") {
    if (channel === "msedge") return path.join(home, "Library", "Application Support", "Microsoft Edge");
    return path.join(home, "Library", "Application Support", "Google", "Chrome");
  }
  if (channel === "msedge") return path.join(home, ".config", "microsoft-edge");
  return path.join(home, ".config", "google-chrome");
}

function getBridgeBrowserProfile() {
  const channel = getBrowserChannel();
  const baseDir = process.platform === "win32"
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    : path.join(os.homedir(), ".config");
  const userDataDir = path.join(baseDir, "AI-Bridge", channel);
  fs.mkdirSync(userDataDir, { recursive: true });
  return { channel, userDataDir };
}

function isHeadlessCloudEnv() {
  return process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

function findContainerChromiumExecutable() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, "/ms-playwright"].filter(Boolean);
  for (const root of roots) {
    try {
      if (!fs.existsSync(root)) continue;
      const entries = fs.readdirSync(root);
      for (const entry of entries) {
        if (entry.startsWith("chromium_headless_shell-")) {
          const candidate = path.join(root, entry, "chrome-headless-shell-linux64", "chrome-headless-shell");
          if (fs.existsSync(candidate)) return candidate;
        }
        if (entry.startsWith("chromium-")) {
          const candidate = path.join(root, entry, "chrome-linux", "chrome");
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch {}
  }
  return null;
}

async function getProviderPage(providerKey) {
  const provider = PROVIDERS[providerKey];
  if (!context) {
    const cdpCandidates = [
      process.env.AI_BRIDGE_CDP_URL,
      "http://127.0.0.1:9222",
      "http://127.0.0.1:9223"
    ].filter(Boolean);

    for (const cdpUrl of cdpCandidates) {
      try {
        browser = await chromium.connectOverCDP(cdpUrl, { timeout: 1500 });
        context = browser.contexts()[0] || await browser.newContext();
        browserConnectionMode = "cdp";
        activeBrowserName = getBrowserChannel() === "msedge" ? "Microsoft Edge (Active Browser)" : "Google Chrome (Active Browser)";
        console.log(`Connected to current default browser via CDP at ${cdpUrl}.`);
        break;
      } catch {}
    }

    if (!context && isHeadlessCloudEnv()) {
      const { userDataDir: cloudProfileDir } = getBridgeBrowserProfile();
      const executablePath = findContainerChromiumExecutable();
      try {
        context = await chromium.launchPersistentContext(cloudProfileDir, {
          ...(executablePath ? { executablePath } : {}),
          headless: true,
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled"
          ],
          ignoreDefaultArgs: ["--enable-automation"]
        });
        await context.addInitScript(() => {
          Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        }).catch(() => {});
        browserConnectionMode = "cloud-headless";
        activeBrowserName = "Chromium (Cloud Headless)";
        console.log("Launched container headless Chromium for Browser Bridge.");
      } catch (error) {
        throw new Error(
          `Could not launch container browser (${error.message.split("\n")[0]}). Turn ON Direct API Mode in the header or run locally.`
        );
      }
    }

    if (!context) {
      // CDP not listening; launch the local default browser
      const channel = getBrowserChannel();
      const channelDisplayName = channel === "msedge" ? "Microsoft Edge" : "Google Chrome";
      const profileMode = (process.env.AI_BRIDGE_PROFILE_MODE || "persistent").trim().toLowerCase();
      const realProfileDir = profileMode === "isolated"
        ? null
        : getDefaultBrowserProfileDir(channel);
      const { userDataDir: fallbackProfileDir } = getBridgeBrowserProfile();

      const launchOptions = {
        channel,
        headless: false,
        args: [
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-blink-features=AutomationControlled",
          "--start-maximized"
        ],
        ignoreDefaultArgs: ["--enable-automation"]
      };

      if (realProfileDir && fs.existsSync(realProfileDir)) {
        try {
          context = await chromium.launchPersistentContext(realProfileDir, launchOptions);
          browserConnectionMode = "default-profile";
          activeBrowserName = channelDisplayName;
          console.log(`Launched default ${channel} browser with your existing logged-in profile.`);
        } catch (profileErr) {
          console.warn(
            `Default ${channel} profile is currently locked or restricted (${profileErr.message.split("\n")[0]}). Falling back to AI-Bridge profile. Tip: start your browser with --remote-debugging-port=9222 or close existing ${channel} windows first to reuse your active logins.`
          );
        }
      }

      if (!context) {
        try {
          context = await chromium.launchPersistentContext(fallbackProfileDir, launchOptions);
          browserConnectionMode = "bridge-profile";
          activeBrowserName = channelDisplayName;
        } catch (channelErr) {
          try {
            // Fallback to Playwright Chromium if system Chrome/Edge channel is unavailable
            context = await chromium.launchPersistentContext(fallbackProfileDir, {
              headless: false,
              args: ["--disable-blink-features=AutomationControlled"],
              ignoreDefaultArgs: ["--enable-automation"]
            });
            browserConnectionMode = "bridge-profile";
            activeBrowserName = "Playwright Chromium";
          } catch (error) {
            throw new Error(
              `Could not launch local browser (${error.message.split("\n")[0]}). Ensure Chrome or Edge is installed locally, or turn ON Direct API Mode.`
            );
          }
        }
      }

      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      }).catch(() => {});
    }

    const launchedContext = context;
    launchedContext.on("close", () => {
      if (context === launchedContext) {
        context = null;
        page = null;
        browser = null;
        browserConnectionMode = null;
        activeBrowserName = null;
        providerPages.clear();
      }
    });
  }

  // 1. Reuse cached tab for this provider if still open and on origin
  let targetPage = providerPages.get(providerKey);
  if (targetPage && !targetPage.isClosed() && targetPage.url().startsWith(provider.origin)) {
    page = targetPage;
    await page.bringToFront().catch(() => {});
    return page;
  }

  // 2. Otherwise check if the current browser already has a tab open to this tool
  const openPages = context.pages().filter((p) => !p.isClosed());
  const matchingPage = openPages.find((p) => p.url().startsWith(provider.origin));
  if (matchingPage) {
    page = matchingPage;
    providerPages.set(providerKey, page);
    await page.bringToFront().catch(() => {});
    return page;
  }

  // 3. Otherwise use a blank tab or open a new tab in the current browser
  const blankPage = openPages.find((p) => p.url() === "about:blank" || p.url().startsWith("chrome://newtab") || p.url().startsWith("edge://newtab"));
  page = blankPage || await context.newPage();
  providerPages.set(providerKey, page);
  await page.bringToFront().catch(() => {});

  // Dismiss popup overlays (e.g. ChatGPT "Stay logged out", modals)
  async function dismissPopups() {
    try {
      const closeButtons = page.locator('button[aria-label="Close"], button[aria-label="Dismiss"], button[aria-label="Dismiss announcement"], button:has-text("Stay logged out"), button:has-text("Maybe later")');
      const count = await closeButtons.count().catch(() => 0);
      for (let i = 0; i < Math.min(count, 5); i++) {
        const btn = closeButtons.nth(i);
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ timeout: 300 }).catch(() => {});
        }
      }
    } catch {}
  }

  await page.goto(provider.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator(provider.prompt.join(", ")).first().waitFor({ state: "visible", timeout: 12000 }).catch(() => {});
  await dismissPopups();

  return page;
}

async function findPromptInput(page, selectors) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.count() > 0 && await locator.isVisible().catch(() => false)) {
        return locator;
      }
    } catch {}
  }
  return null;
}

async function pollBrowserState(page, providerKey, question, initialCount) {
  const provider = PROVIDERS[providerKey];
  try {
    const result = await page.evaluate(({ responseSelector, qTrimmed, initCount }) => {
      const stopSelectors = [
        'button[data-testid*="stop" i]',
        'button[aria-label*="stop generating" i]',
        'button[aria-label*="stop response" i]',
        'button[aria-label*="Stop" i]'
      ];
      let generating = false;
      for (const sel of stopSelectors) {
        const btns = document.querySelectorAll(sel);
        for (const btn of btns) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            generating = true;
            break;
          }
        }
        if (generating) break;
      }

      function getCodeLanguage(preEl) {
        const codeEl = preEl.querySelector("code") || preEl;
        const cls = (codeEl.className || "") + " " + (preEl.className || "");
        const m = cls.match(/(?:language-|lang-)([a-z0-9_+#-]+)/i);
        if (m) return m[1].toLowerCase();
        const wrapper = preEl.closest("code-block, .md-code-block, .code-block, figure") || preEl.parentElement;
        if (wrapper) {
          const candidates = wrapper.querySelectorAll('[class*="lang" i], [class*="header" i] span, .code-block-decoration span, :scope > div > span');
          for (const el of candidates) {
            const txt = (el.textContent || "").trim().toLowerCase();
            if (txt && txt.length <= 20 && !/copy|copied|run|wrap/i.test(txt)) {
              return txt.replace(/[^a-z0-9_+#-]/g, "");
            }
          }
        }
        return "";
      }

      function extractCodeText(preEl) {
        const codeEl = preEl.querySelector("code") || preEl;
        const clone = codeEl.cloneNode(true);
        clone.querySelectorAll("button, [role='button']").forEach((b) => b.remove());
        return (clone.innerText || clone.textContent || "").replace(/\n$/, "");
      }

      function domToMarkdown(root) {
        function walk(node, listDepth) {
          if (!node) return "";
          if (node.nodeType === 3) return node.nodeValue || "";
          if (node.nodeType !== 1) return "";

          const tag = node.tagName.toLowerCase();
          if (
            tag === "button" ||
            tag === "svg" ||
            tag === "style" ||
            tag === "script" ||
            node.getAttribute("aria-hidden") === "true" ||
            (node.matches && node.matches('.code-block-decoration, .md-code-block-banner, [data-testid*="copy" i], [aria-label*="Copy" i]'))
          ) {
            return "";
          }

          if (tag === "br") return "\n";
          if (tag === "hr") return "\n\n---\n\n";

          if (tag === "pre") {
            const lang = getCodeLanguage(node);
            const code = extractCodeText(node);
            if (!code.trim()) return "";
            return `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
          }

          if (tag === "code-block" || (node.classList && node.classList.contains("md-code-block"))) {
            const pre = node.querySelector("pre");
            if (pre) return walk(pre, listDepth);
          }

          if (tag === "code") {
            const txt = (node.textContent || "").trim();
            if (!txt) return "";
            if (txt.includes("\n")) return `\n\n\`\`\`\n${txt}\n\`\`\`\n\n`;
            return `\`${txt.replace(/`/g, "\\`")}\``;
          }

          if (tag === "table") {
            const rows = Array.from(node.querySelectorAll("tr"));
            if (!rows.length) return "";
            const out = [];
            rows.forEach((tr, rIdx) => {
              const cells = Array.from(tr.children).map((c) =>
                (c.textContent || "").trim().replace(/\n+/g, " ").replace(/\|/g, "\\|")
              );
              if (!cells.length) return;
              out.push(`| ${cells.join(" | ")} |`);
              if (rIdx === 0) out.push(`| ${cells.map(() => "---").join(" | ")} |`);
            });
            return `\n\n${out.join("\n")}\n\n`;
          }

          if (tag === "ul" || tag === "ol") {
            let idx = 1;
            const items = [];
            for (const child of node.children) {
              if (child.tagName && child.tagName.toLowerCase() === "li") {
                const prefix = tag === "ol" ? `${idx++}. ` : "- ";
                const indent = "  ".repeat(listDepth);
                const itemText = Array.from(child.childNodes)
                  .map((c) => walk(c, listDepth + 1))
                  .join("")
                  .replace(/\n{3,}/g, "\n\n")
                  .trim();
                if (itemText) items.push(`${indent}${prefix}${itemText}`);
              }
            }
            return items.length ? `\n\n${items.join("\n")}\n\n` : "";
          }

          const inner = Array.from(node.childNodes).map((c) => walk(c, listDepth)).join("");

          if (tag === "h1") return `\n\n# ${inner.trim()}\n\n`;
          if (tag === "h2") return `\n\n## ${inner.trim()}\n\n`;
          if (tag === "h3") return `\n\n### ${inner.trim()}\n\n`;
          if (tag === "h4" || tag === "h5" || tag === "h6") return `\n\n#### ${inner.trim()}\n\n`;
          if (tag === "strong" || tag === "b") {
            const t = inner.trim();
            return t ? `**${t}**` : "";
          }
          if (tag === "em" || tag === "i") {
            const t = inner.trim();
            return t ? `*${t}*` : "";
          }
          if (tag === "blockquote") {
            const lines = inner.trim().split("\n").map((l) => `> ${l}`).join("\n");
            return `\n\n${lines}\n\n`;
          }
          if (tag === "li") return `${inner.trim()}\n`;
          if (tag === "p") {
            const t = inner.trim();
            return t ? `\n\n${t}\n\n` : "";
          }
          return inner;
        }

        return walk(root, 0).replace(/\n{3,}/g, "\n\n").trim();
      }

      const nodes = Array.from(document.querySelectorAll(responseSelector));
      let text = "";
      if (nodes.length > initCount) {
        const latestNode = nodes[nodes.length - 1];
        const rawLatest = (latestNode.innerText || "").trim();
        if (rawLatest && rawLatest !== qTrimmed) {
          text = domToMarkdown(latestNode) || rawLatest;
        }
      }
      return { text, generating };
    }, { responseSelector: provider.response, qTrimmed: question.trim(), initCount: initialCount });

    if (result.text) return result;

    // Fallback body parse if provider changed response container class
    const fallbackText = await extractCurrentResponse(page, providerKey, question, initialCount);
    return { text: fallbackText, generating: result.generating };
  } catch {
    return { text: "", generating: false };
  }
}

async function isGenerating(page) {
  try {
    const stopButton = page.locator(
      'button[data-testid*="stop" i], button[aria-label*="stop generating" i], button[aria-label*="stop response" i], button[aria-label*="Stop" i]'
    ).last();
    return await stopButton.isVisible().catch(() => false);
  } catch {
    return false;
  }
}

function findLastQuestionIndex(bodyText, question) {
  const qTrimmed = question.trim();
  const exactIdx = bodyText.lastIndexOf(qTrimmed);
  if (exactIdx !== -1) return { index: exactIdx, length: qTrimmed.length };

  const lines = qTrimmed.split("\n").map((l) => l.trim()).filter((l) => l.length >= 8);
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = bodyText.lastIndexOf(lines[i]);
    if (idx !== -1) return { index: idx, length: lines[i].length };
  }
  return { index: -1, length: 0 };
}

// Extract current response for a provider
async function extractCurrentResponse(page, providerKey, question, initialCount) {
  const provider = PROVIDERS[providerKey];

  // 1. Try specific response selectors with Markdown preservation first
  try {
    const latestMd = await page.evaluate(({ sel, qTrimmed, initCount }) => {
      const nodes = Array.from(document.querySelectorAll(sel));
      if (nodes.length <= initCount) return "";
      const node = nodes[nodes.length - 1];
      const raw = (node.innerText || "").trim();
      if (!raw || raw === qTrimmed) return "";
      return raw;
    }, { sel: provider.response, qTrimmed: question.trim(), initCount: initialCount });
    if (latestMd) return latestMd;
  } catch {}

  // 2. Fallback: extract answer from page body text using smart parsing
  try {
    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (!bodyText) return "";

    if (providerKey === "chatgpt") {
      // ChatGPT (logged-out): answer sits between the user's question and the "ChatGPT is AI" footer
      const { index: qIndex, length: qLen } = findLastQuestionIndex(bodyText, question);
      if (qIndex === -1) return "";
      const afterQ = bodyText.slice(qIndex + qLen).trim();
      // Strip the footer and navigation text
      const footerMatch = afterQ.match(/\n\s*ChatGPT (?:is AI|can make mistakes)/i);
      const answerBlock = footerMatch ? afterQ.slice(0, footerMatch.index).trim() : afterQ.trim();
      // Remove ChatGPT's generic nav/chrome text that sometimes appears in the chunk
      const cleaned = answerBlock
        .replace(/^Thinking\s*/i, '')
        .replace(/ChatGPT is AI.*$/s, '')
        .replace(/ChatGPT\nNew chat[\s\S]*/i, '')
        .replace(/\nChat with ChatGPT\s*$/i, '')
        .trim();
      return cleaned || "";
    }

    if (providerKey === "claude") {
      const { index: qIndex, length: qLen } = findLastQuestionIndex(bodyText, question);
      if (qIndex === -1) return "";
      const afterQ = bodyText.slice(qIndex + qLen).trim();
      return afterQ || "";
    }

    if (providerKey === "duckai") {
      const { index: qIndex, length: qLen } = findLastQuestionIndex(bodyText, question);
      if (qIndex === -1) return "";
      const afterQ = bodyText.slice(qIndex + qLen).trim();
      const cleaned = afterQ
        .replace(/Duck\.ai works best[\s\S]*$/i, "")
        .replace(/All chats are private\.[\s\S]*$/i, "")
        .replace(/\n\s*Tools\s*\n\s*Fast[\s\S]*$/i, "")
        .trim();
      return cleaned || "";
    }

    if (providerKey === "deepseek" || providerKey === "perplexity") {
      const { index: qIndex, length: qLen } = findLastQuestionIndex(bodyText, question);
      if (qIndex === -1) return "";
      const afterQ = bodyText.slice(qIndex + qLen).trim();
      return afterQ || "";
    }
  } catch {}

  return "";
}

function formatApiError(providerName, err) {
  const raw = err?.message || String(err || "Unknown API error");
  if (/API_KEY_INVALID|API key not valid/i.test(raw)) {
    return `${providerName} API key is invalid. Please check your key in Settings > Secrets or ⚙️ API Keys.`;
  }
  if (/PERMISSION_DENIED|403/i.test(raw)) {
    return `${providerName} API permission denied (403). Please verify your API key in Settings > Secrets or ⚙️ API Keys.`;
  }
  if (/RESOURCE_EXHAUSTED|429/i.test(raw)) {
    return `${providerName} API quota exceeded (429). Check your quota or billing in Settings > Secrets.`;
  }
  return `${providerName} API error: ${raw}`;
}

// Direct API Streaming helpers
async function streamDirectGemini(apiKey, question, res) {
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build"
      }
    }
  });

  const responseStream = await ai.models.generateContentStream({
    model: "gemini-4-hydrogen",
    contents: question
  });

  let fullText = "";
  for await (const chunk of responseStream) {
    const text = chunk.text || "";
    if (text) {
      fullText += text;
      res.write(`data: ${JSON.stringify({ type: "chunk", text: fullText, delta: text })}\n\n`);
    }
  }

  return fullText;
}

async function streamDirectOpenAICompatible(endpoint, model, providerName, apiKey, question, res) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: question }],
      stream: true
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`${providerName} API error (${response.status}): ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n");
    for (const line of lines) {
      const clean = line.replace(/^data:\s*/, "").trim();
      if (!clean || clean === "[DONE]") continue;
      try {
        const parsed = JSON.parse(clean);
        const delta = parsed?.choices?.[0]?.delta?.content || "";
        if (delta) {
          fullText += delta;
          res.write(`data: ${JSON.stringify({ type: "chunk", text: fullText, delta })}\n\n`);
        }
      } catch {}
    }
  }

  return fullText;
}

async function streamDirectOpenAI(apiKey, question, res) {
  return streamDirectOpenAICompatible(
    "https://api.openai.com/v1/chat/completions",
    "gpt-4o-mini",
    "OpenAI",
    apiKey,
    question,
    res
  );
}

async function streamDirectDeepSeek(apiKey, question, res) {
  return streamDirectOpenAICompatible(
    "https://api.deepseek.com/chat/completions",
    "deepseek-chat",
    "DeepSeek",
    apiKey,
    question,
    res
  );
}

async function streamDirectPerplexity(apiKey, question, res) {
  return streamDirectOpenAICompatible(
    "https://api.perplexity.ai/chat/completions",
    "sonar",
    "Perplexity",
    apiKey,
    question,
    res
  );
}

async function streamDirectDeepAI(apiKey, question, res) {
  const formBody = new URLSearchParams({ text: question });
  const response = await fetch("https://api.deepai.org/api/text-generator", {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: formBody.toString()
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`DeepAI API error (${response.status}): ${errText}`);
  }

  const data = await response.json().catch(() => ({}));
  const fullText = String(data?.output || "").trim();
  if (!fullText) {
    throw new Error("DeepAI API returned an empty response.");
  }
  res.write(`data: ${JSON.stringify({ type: "chunk", text: fullText, delta: fullText })}\n\n`);
  return fullText;
}

async function streamDirectClaude(apiKey, question, res) {
  const url = "https://api.anthropic.com/v1/messages";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-3-5-haiku-latest",
      max_tokens: 2048,
      messages: [{ role: "user", content: question }],
      stream: true
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error (${response.status}): ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n");
    for (const line of lines) {
      const clean = line.replace(/^data:\s*/, "").trim();
      if (!clean) continue;
      try {
        const parsed = JSON.parse(clean);
        if (parsed.type === "content_block_delta" && parsed.delta?.text) {
          fullText += parsed.delta.text;
          res.write(`data: ${JSON.stringify({ type: "chunk", text: fullText, delta: parsed.delta.text })}\n\n`);
        }
      } catch {}
    }
  }

  return fullText;
}

async function runDirectApiProvider(providerKey, apiKey, question, res) {
  if (providerKey === "gemini") return streamDirectGemini(apiKey, question, res);
  if (providerKey === "deepai") return streamDirectDeepAI(apiKey, question, res);
  if (providerKey === "chatgpt") return streamDirectOpenAI(apiKey, question, res);
  if (providerKey === "deepseek") return streamDirectDeepSeek(apiKey, question, res);
  if (providerKey === "perplexity") return streamDirectPerplexity(apiKey, question, res);
  if (providerKey === "claude") return streamDirectClaude(apiKey, question, res);
  if (providerKey === "duckai") {
    throw new Error("Duck.ai does not provide an external public REST API key endpoint. Switch off Direct API to use Duck.ai in Browser Bridge mode, or select a model with your saved API key.");
  }
  throw new Error("Unsupported provider for Direct API mode.");
}

// ----------------- Auth & User History Endpoints -----------------

function getAppOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${process.env.PORT || 3000}`;
  return `${proto}://${host}`;
}

app.get("/api/auth/me", async (req, res) => {
  try {
    const token = extractTokenFromRequest(req);
    const decoded = verifyTokenPayload(token);
    if (!decoded) {
      return res.json({ authenticated: false, user: null, db: getDbStatus() });
    }
    const user = await getUserById(decoded.userId);
    if (!user) {
      clearAuthCookie(res, req);
      return res.json({ authenticated: false, user: null, db: getDbStatus() });
    }
    return res.json({ authenticated: true, user, db: getDbStatus() });
  } catch (err) {
    return res.status(500).json({ authenticated: false, user: null, error: err.message });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { fullName, email, password, rememberMe } = req.body || {};
    const user = await registerUser({ fullName, email, password });
    const remember = rememberMe !== false;
    const token = require("jsonwebtoken").sign
      ? (() => {
          const jwt = require("jsonwebtoken");
          return jwt.sign(
            { sub: user.id, email: user.email, fullName: user.fullName },
            process.env.JWT_SECRET || "ai-bridge-dev-secret-key-2026",
            { expiresIn: remember ? "30d" : "24h" }
          );
        })()
      : "";
    setAuthCookie(res, req, token, remember);
    return res.status(201).json({ ok: true, user, token, rememberMe: remember });
  } catch (err) {
    return res.status(err.status || 500).json({
      ok: false,
      error: err.message || "Registration failed."
    });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password, rememberMe } = req.body || {};
    const user = await loginUser({ email, password });
    const remember = Boolean(rememberMe);
    const jwt = require("jsonwebtoken");
    const token = jwt.sign(
      { sub: user.id, email: user.email, fullName: user.fullName },
      process.env.JWT_SECRET || "ai-bridge-dev-secret-key-2026",
      { expiresIn: remember ? "30d" : "24h" }
    );
    setAuthCookie(res, req, token, remember);
    return res.json({ ok: true, user, token, rememberMe: remember });
  } catch (err) {
    return res.status(err.status || 500).json({
      ok: false,
      error: err.message || "Sign in failed."
    });
  }
});

app.post("/api/auth/logout", (req, res) => {
  clearAuthCookie(res, req);
  res.json({ ok: true });
});

app.post("/api/auth/forgot-password", async (req, res) => {
  try {
    const { email } = req.body || {};
    const result = await requestPasswordReset({
      email,
      appOrigin: getAppOrigin(req)
    });
    return res.json(result);
  } catch (err) {
    return res.status(err.status || 500).json({
      ok: false,
      error: err.message || "Could not process password reset request."
    });
  }
});

app.get("/api/auth/verify-reset-token", async (req, res) => {
  try {
    const result = await verifyResetToken(req.query?.token);
    if (!result.valid) return res.status(400).json(result);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ valid: false, error: err.message });
  }
});

app.post("/api/auth/reset-password", async (req, res) => {
  try {
    const { token, password, confirmPassword } = req.body || {};
    const result = await resetPasswordWithToken({ token, password, confirmPassword });
    return res.json(result);
  } catch (err) {
    return res.status(err.status || 500).json({
      ok: false,
      error: err.message || "Could not reset password."
    });
  }
});

// Per-user isolated Chat History endpoints
app.get("/api/chats", requireAuth, async (req, res) => {
  try {
    const chats = await listUserChats(req.user.userId);
    return res.json({ ok: true, chats });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/chats", requireAuth, async (req, res) => {
  try {
    const chat = await createUserChat({
      userId: req.user.userId,
      title: req.body?.title || "New Chat",
      provider: req.body?.provider || "gemini"
    });
    return res.status(201).json({ ok: true, chat });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/chats/:id", requireAuth, async (req, res) => {
  try {
    const chat = await getUserChatById(req.user.userId, req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: "Chat not found." });
    return res.json({ ok: true, chat });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch("/api/chats/:id", requireAuth, async (req, res) => {
  try {
    const updated = await renameUserChat({
      userId: req.user.userId,
      chatId: req.params.id,
      title: req.body?.title
    });
    if (!updated) return res.status(404).json({ ok: false, error: "Chat not found." });
    return res.json({ ok: true, chat: updated });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/chats/:id", requireAuth, async (req, res) => {
  try {
    const deleted = await deleteUserChat({
      userId: req.user.userId,
      chatId: req.params.id
    });
    if (!deleted) return res.status(404).json({ ok: false, error: "Chat not found." });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ----------------- API Endpoints -----------------

function buildFinalPrompt(rawQuestion, options = {}) {
  const screenEnriched = enrichScreenPrompt(rawQuestion);
  const interviewMode = options.interviewMode !== false;
  if (!interviewMode) return screenEnriched;

  const profileBlock = buildPersonalizedProfileBlock(options.profile || {});

  // Keep Read Screen MCQ formatting priority intact if screen OCR content is present
  if (screenEnriched.includes("[MULTIPLE-CHOICE & ACCURACY GUIDELINES]")) {
    return [
      screenEnriched,
      profileBlock,
      "[DELIVERY STYLE]\nUse clear, simple, interview-ready English with clean Markdown headings, bullets, and code blocks where helpful."
    ].filter(Boolean).join("\n\n");
  }

  const template = String(options.customTemplate || "").trim() || DEFAULT_INTERVIEW_TEMPLATE;
  return [template, profileBlock, `Question:\n${screenEnriched}`].filter(Boolean).join("\n\n");
}

// Per-user API Keys, Personalized Interview Profile & Template Settings endpoint (MongoDB backed)
app.get("/api/settings", requireAuth, async (req, res) => {
  try {
    const [userKeys, templateSettings] = await Promise.all([
      getUserApiKeys(req.user.userId),
      getUserTemplateSettings(req.user.userId)
    ]);
    res.json({
      apiKeys: userKeys,
      templateSettings,
      geminiKeySet: Boolean(userKeys.gemini),
      deepaiKeySet: Boolean(userKeys.deepai),
      chatgptKeySet: Boolean(userKeys.chatgpt),
      deepseekKeySet: Boolean(userKeys.deepseek),
      perplexityKeySet: Boolean(userKeys.perplexity),
      duckaiKeySet: Boolean(userKeys.duckai),
      claudeKeySet: Boolean(userKeys.claude),
      defaultInterviewTemplate: DEFAULT_INTERVIEW_TEMPLATE,
      db: getDbStatus(),
      configuredBrowser: isHeadlessCloudEnv()
        ? "Chromium (Cloud Headless)"
        : getBrowserChannel() === "msedge" ? "Microsoft Edge" : "Google Chrome"
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Could not load settings." });
  }
});

app.post("/api/settings", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const hasApiKeyUpdate = Boolean(
      (body.apiKeys && typeof body.apiKeys === "object") ||
      body.geminiKey !== undefined ||
      body.deepaiKey !== undefined ||
      body.chatgptKey !== undefined ||
      body.deepseekKey !== undefined ||
      body.perplexityKey !== undefined ||
      body.duckaiKey !== undefined ||
      body.claudeKey !== undefined
    );

    let savedKeys = null;
    if (hasApiKeyUpdate) {
      const incomingKeys = body.apiKeys && typeof body.apiKeys === "object" ? { ...body.apiKeys } : {};
      if (body.geminiKey !== undefined) incomingKeys.gemini = body.geminiKey;
      if (body.deepaiKey !== undefined) incomingKeys.deepai = body.deepaiKey;
      if (body.chatgptKey !== undefined) incomingKeys.chatgpt = body.chatgptKey;
      if (body.deepseekKey !== undefined) incomingKeys.deepseek = body.deepseekKey;
      if (body.perplexityKey !== undefined) incomingKeys.perplexity = body.perplexityKey;
      if (body.duckaiKey !== undefined) incomingKeys.duckai = body.duckaiKey;
      if (body.claudeKey !== undefined) incomingKeys.claude = body.claudeKey;
      savedKeys = await saveUserApiKeys(req.user.userId, incomingKeys);
    } else {
      savedKeys = await getUserApiKeys(req.user.userId);
    }

    const hasTemplateUpdate = Boolean(
      (body.templateSettings && typeof body.templateSettings === "object") ||
      body.role !== undefined ||
      body.experience !== undefined ||
      body.techStack !== undefined ||
      body.companyName !== undefined ||
      body.keyDetails !== undefined ||
      body.customTemplate !== undefined ||
      body.interviewMode !== undefined
    );

    let savedTemplate = null;
    if (hasTemplateUpdate) {
      const incomingTpl = body.templateSettings && typeof body.templateSettings === "object"
        ? { ...body.templateSettings }
        : {};
      if (body.role !== undefined) incomingTpl.role = body.role;
      if (body.experience !== undefined) incomingTpl.experience = body.experience;
      if (body.techStack !== undefined) incomingTpl.techStack = body.techStack;
      if (body.companyName !== undefined) incomingTpl.companyName = body.companyName;
      if (body.keyDetails !== undefined) incomingTpl.keyDetails = body.keyDetails;
      if (body.customTemplate !== undefined) incomingTpl.customTemplate = body.customTemplate;
      if (body.interviewMode !== undefined) incomingTpl.interviewMode = body.interviewMode;
      savedTemplate = await saveUserTemplateSettings(req.user.userId, incomingTpl);
    } else {
      savedTemplate = await getUserTemplateSettings(req.user.userId);
    }

    res.json({
      success: true,
      apiKeys: savedKeys,
      templateSettings: savedTemplate,
      message: "Your settings and interview template have been saved to MongoDB."
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Could not save settings." });
  }
});

app.post("/api/open", requireAuth, async (req, res) => {
  const providerKey = String(req.body?.provider || "").toLowerCase();
  const provider = PROVIDERS[providerKey];
  if (!provider) return res.status(400).json({ error: "Choose Gemini, ChatGPT, DeepSeek, Claude, Duck.ai, DeepAI, or Perplexity." });
  if (busy) return res.status(429).json({ error: "Wait for the current response before switching services." });

  const directApiMode = req.body?.directApiMode === true;
  if (directApiMode) {
    if (providerKey === "duckai") {
      return res.status(400).json({
        error: "Duck.ai only supports Browser Bridge mode (no public REST API). Switch off Direct API Mode to use Duck.ai, or select a model with your saved API key."
      });
    }
    const userKeys = await getUserApiKeys(req.user.userId).catch(() => ({}));
    const customKey = String(req.body?.apiKey || "").trim() || userKeys[providerKey] || "";
    if (!customKey) {
      return res.status(400).json({
        error: `No API key saved for ${provider.name}. Enter your own ${provider.name} API key in Direct API settings (this app does not use central API keys), or switch off Direct API Mode to use Browser Bridge.`
      });
    }
    return res.json({ provider: provider.name, url: provider.url, mode: "api" });
  }

  busy = true;
  try {
    const assistant = await getProviderPage(providerKey);
    res.json({
      provider: provider.name,
      url: assistant.url(),
      mode: "browser",
      browserMode: browserConnectionMode,
      browserName: activeBrowserName
    });
  } catch (error) {
    res.status(500).json({ error: error.message || `Could not open ${provider.name}.` });
  } finally {
    busy = false;
  }
});

// Local in-memory OCR fallback for web browser getDisplayMedia captures
app.post("/api/ocr", requireAuth, express.json({ limit: "25mb" }), async (req, res) => {
  if (ocrBusy) {
    return res.status(429).json({ ok: false, code: "CAPTURE_IN_PROGRESS", error: "OCR is already running. Please wait." });
  }
  const dataUrl = String(req.body?.imageDataUrl || "");
  const match = dataUrl.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    return res.status(400).json({ ok: false, error: "Invalid or empty screenshot image payload." });
  }

  ocrBusy = true;
  let imageBuffer = null;
  try {
    imageBuffer = Buffer.from(match[1], "base64");
    const result = await extractTextFromImageBuffer(imageBuffer);
    imageBuffer = null;
    if (!result.ok) {
      return res.status(422).json(result);
    }
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || "Local OCR processing failed."
    });
  } finally {
    imageBuffer = null;
    ocrBusy = false;
  }
});

// In-memory Playwright OCR capture for active Browser Bridge tab or URL (preview iframe fallback)
app.post("/api/ocr-capture", requireAuth, async (req, res) => {
  if (ocrBusy) {
    return res.status(429).json({ ok: false, code: "CAPTURE_IN_PROGRESS", error: "OCR is already running. Please wait." });
  }

  const mode = String(req.body?.mode || "active-tab");
  const rawUrl = String(req.body?.url || "").trim();

  ocrBusy = true;
  let pngBuffer = null;
  let tempBrowser = null;
  let tempPage = null;

  try {
    if (mode === "url") {
      if (!/^https?:\/\/\S+/i.test(rawUrl)) {
        return res.status(400).json({ ok: false, error: "Enter a valid http:// or https:// URL to read." });
      }
      if (context) {
        tempPage = await context.newPage();
      } else {
        const execPath = findContainerChromiumExecutable();
        tempBrowser = await chromium.launch({
          ...(execPath ? { executablePath: execPath } : {}),
          headless: true,
          args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
        });
        tempPage = await tempBrowser.newPage({ viewport: { width: 1280, height: 800 } });
      }
      await tempPage.goto(rawUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
      await tempPage.waitForTimeout(500);
      pngBuffer = await tempPage.screenshot({ type: "png" });
    } else {
      if (!page || page.isClosed()) {
        return res.status(400).json({
          ok: false,
          error: "No active Browser Bridge tab is open yet. Click an AI tool above or enter a URL to capture."
        });
      }
      pngBuffer = await page.screenshot({ type: "png" });
    }

    const result = await extractTextFromImageBuffer(pngBuffer);
    pngBuffer = null;
    if (!result.ok) {
      return res.status(422).json(result);
    }
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || "Could not capture page for local OCR."
    });
  } finally {
    pngBuffer = null;
    try { if (tempPage) await tempPage.close(); } catch {}
    try { if (tempBrowser) await tempBrowser.close(); } catch {}
    ocrBusy = false;
  }
});

// Speech-to-Text status & fast PCM transcription fallback endpoint
app.get("/api/speech/status", async (req, res) => {
  try {
    const token = extractTokenFromRequest(req);
    const decoded = verifyTokenPayload(token);
    const userKeys = decoded ? await getUserApiKeys(decoded.userId).catch(() => ({})) : {};
    res.json(getSpeechEngineInfo(userKeys.gemini || ""));
  } catch {
    res.json(getSpeechEngineInfo(""));
  }
});

app.post("/api/transcribe-pcm", requireAuth, express.raw({ type: "application/octet-stream", limit: "15mb" }), async (req, res) => {
  let pcmBuffer = null;
  try {
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      pcmBuffer = req.body;
    } else if (req.body && typeof req.body === "object" && req.body.pcm16Base64) {
      pcmBuffer = Buffer.from(String(req.body.pcm16Base64), "base64");
    }

    if (!pcmBuffer || pcmBuffer.length === 0) {
      return res.status(400).json({ ok: false, error: "Empty audio buffer." });
    }

    const userKeys = await getUserApiKeys(req.user.userId).catch(() => ({}));
    const result = await transcribePcm16(pcmBuffer, userKeys.gemini || "");
    pcmBuffer = null;
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || "Speech transcription failed."
    });
  } finally {
    pcmBuffer = null;
  }
});

// REAL-TIME STREAMING CHAT ENDPOINT (SSE) — Authenticated + Per-User Chat Persistence
app.post("/api/chat/stream", requireAuth, async (req, res) => {
  const rawQuestion = String(req.body?.message || "").trim();
  const savedTpl = await getUserTemplateSettings(req.user.userId).catch(() => ({}));
  const reqProfile = req.body?.interviewProfile && typeof req.body.interviewProfile === "object" ? req.body.interviewProfile : {};
  const mergedProfile = {
    role: reqProfile.role ?? savedTpl.role ?? "",
    experience: reqProfile.experience ?? savedTpl.experience ?? "",
    techStack: reqProfile.techStack ?? savedTpl.techStack ?? "",
    companyName: reqProfile.companyName ?? savedTpl.companyName ?? "",
    keyDetails: reqProfile.keyDetails ?? savedTpl.keyDetails ?? ""
  };
  const useInterviewMode = req.body?.interviewMode !== undefined
    ? req.body.interviewMode !== false
    : savedTpl.interviewMode !== false;
  const question = buildFinalPrompt(rawQuestion, {
    interviewMode: useInterviewMode,
    customTemplate: req.body?.customTemplate !== undefined ? req.body.customTemplate : savedTpl.customTemplate,
    profile: mergedProfile
  });
  const providerKey = String(req.body?.provider || "deepai").toLowerCase();
  const provider = PROVIDERS[providerKey];
  const directApiMode = req.body?.directApiMode === true;
  const requestedChatId = req.body?.chatId ? String(req.body.chatId) : null;

  const providerListError = "Choose Gemini, ChatGPT, DeepSeek, Claude, Duck.ai, DeepAI, or Perplexity.";
  if (!rawQuestion) return res.status(400).json({ error: "Enter a question." });
  if (!provider) return res.status(400).json({ error: providerListError });

  // Persist user message immediately under authenticated user's isolated chat
  let activeChatId = requestedChatId;
  try {
    const savedUser = await appendChatMessage({
      userId: req.user.userId,
      chatId: requestedChatId,
      role: "user",
      text: rawQuestion,
      provider: providerKey
    });
    activeChatId = savedUser.chatId;
  } catch (dbErr) {
    return res.status(500).json({ error: dbErr.message || "Could not save message to chat history." });
  }

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: "chat", chatId: activeChatId })}\n\n`);

  // Only use Direct API Mode when explicitly toggled on (directApiMode === true)
  if (directApiMode) {
    const userKeys = await getUserApiKeys(req.user.userId).catch(() => ({}));
    const customKey = String(req.body?.apiKey || "").trim() || userKeys[providerKey] || "";
    if (!customKey) {
      res.write(`data: ${JSON.stringify({
        type: "error",
        error: `No API key saved for ${provider.name}. Please add your own ${provider.name} API key in Direct API settings to get a response (this app does not provide central API keys), or turn OFF Direct API Mode to use Browser Bridge.`
      })}\n\n`);
      return res.end();
    }
    try {
      const fullText = await runDirectApiProvider(providerKey, customKey, question, res);
      if (fullText) {
        await appendChatMessage({
          userId: req.user.userId,
          chatId: activeChatId,
          role: "assistant",
          text: fullText,
          provider: provider.name
        }).catch(() => {});
      }
      res.write(`data: ${JSON.stringify({ type: "done", text: fullText, provider: provider.name, chatId: activeChatId })}\n\n`);
      return res.end();
    } catch (apiErr) {
      const friendlyError = formatApiError(provider.name, apiErr);
      console.warn("Direct API failed:", apiErr.message);
      res.write(`data: ${JSON.stringify({ type: "error", error: friendlyError })}\n\n`);
      return res.end();
    }
  }

  // Default: Browser Bridge mode — asks directly in the opened browser and streams back fast
  if (busy) {
    res.write(`data: ${JSON.stringify({ type: "error", error: "The AI service is currently busy. Please wait a moment." })}\n\n`);
    return res.end();
  }

  busy = true;
  try {
    const assistant = await getProviderPage(providerKey);

    // Dismiss any modals (ChatGPT "Stay logged out", DeepAI promo modals, etc.)
    const closeButtons = assistant.locator('button[aria-label="Close"], button[aria-label="Dismiss"], button[aria-label="Dismiss announcement"], button:has-text("Stay logged out"), button:has-text("Maybe later")');
    const closeCount = await closeButtons.count().catch(() => 0);
    for (let i = 0; i < Math.min(closeCount, 5); i++) {
      const btn = closeButtons.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 300 }).catch(() => {});
      }
    }

    // Check for login or Cloudflare verification wall
    const pageTitle = await assistant.title().catch(() => "");
    if (/Just a moment|Attention Required/i.test(pageTitle)) {
      throw new Error(`${provider.name} is showing a Cloudflare verification challenge in the headless browser. Use Gemini/DeepAI Browser Bridge, turn ON Direct API Mode, or run locally with your logged-in Chrome.`);
    }

    if (providerKey === "gemini") {
      const signIn = await assistant.locator('a[href*="ServiceLogin"]').count();
      if (signIn > 0 && !(await assistant.locator('rich-textarea [contenteditable="true"]').count())) {
        throw new Error("Please sign in to Google in the opened browser window first. Sign-in is saved permanently.");
      }
    }

    if (providerKey === "deepseek" && assistant.url().includes("/sign_in")) {
      throw new Error("DeepSeek requires signing in first. Sign in to DeepSeek in your local Chrome browser (http://127.0.0.1:9222) or AI Bridge browser profile.");
    }

    const prompt = await findPromptInput(assistant, provider.prompt);
    if (!prompt) {
      throw new Error(`${provider.name} requires login or verification in this browser session. Use Gemini/DeepAI Browser Bridge, or run locally with your logged-in Chrome.`);
    }

    // Record initial response count quickly inside page
    const initialCount = await assistant.evaluate((sel) => document.querySelectorAll(sel).length, provider.response).catch(() => 0);

    // Type prompt reliably into rich editors
    await prompt.click({ timeout: 3000 });
    await assistant.keyboard.insertText(question);
    await assistant.waitForTimeout(80);

    // Click send or press Enter
    let sent = false;
    for (const sendSel of provider.send) {
      const sendBtn = assistant.locator(sendSel).first();
      if (
        await sendBtn.count().catch(() => 0) > 0 &&
        await sendBtn.isVisible().catch(() => false) &&
        await sendBtn.isEnabled().catch(() => false)
      ) {
        await sendBtn.click({ timeout: 2000 }).catch(() => {});
        sent = true;
        break;
      }
    }
    if (!sent) {
      await assistant.keyboard.press("Enter");
    }

    // High-frequency 60ms in-page polling to stream tokens live in seconds
    let lastText = "";
    let stableCount = 0;
    const startTime = Date.now();
    const timeoutMs = 60000;

    while (Date.now() - startTime < timeoutMs) {
      await assistant.waitForTimeout(60);
      const { text: currentText, generating } = await pollBrowserState(assistant, providerKey, question, initialCount);

      if (currentText && currentText !== lastText) {
        const delta = currentText.startsWith(lastText) ? currentText.slice(lastText.length) : currentText;
        lastText = currentText;
        stableCount = 0;
        res.write(`data: ${JSON.stringify({ type: "chunk", text: currentText, delta })}\n\n`);
      } else if (currentText && currentText === lastText) {
        if (!generating) {
          stableCount++;
          // 8 polls * 60ms = ~480ms after generation stops
          if (stableCount >= 8) {
            break;
          }
        } else {
          stableCount = 0;
        }
      }
    }

    if (!lastText) {
      throw new Error(`No response received from ${provider.name}. Please check the browser window.`);
    }

    await appendChatMessage({
      userId: req.user.userId,
      chatId: activeChatId,
      role: "assistant",
      text: lastText,
      provider: provider.name
    }).catch(() => {});

    res.write(`data: ${JSON.stringify({ type: "done", text: lastText, provider: provider.name, chatId: activeChatId })}\n\n`);
    res.end();
  } catch (error) {
    res.write(`data: ${JSON.stringify({
      type: "error",
      error: error.message || "Failed to generate response.",
      hint: "Make sure you are signed in on the opened browser window if prompted."
    })}\n\n`);
    res.end();
  } finally {
    busy = false;
  }
});

// Non-streaming compatibility endpoint
app.post("/api/chat", requireAuth, async (req, res) => {
  const rawQuestion = String(req.body?.message || "").trim();
  const savedTpl = await getUserTemplateSettings(req.user.userId).catch(() => ({}));
  const reqProfile = req.body?.interviewProfile && typeof req.body.interviewProfile === "object" ? req.body.interviewProfile : {};
  const mergedProfile = {
    role: reqProfile.role ?? savedTpl.role ?? "",
    experience: reqProfile.experience ?? savedTpl.experience ?? "",
    techStack: reqProfile.techStack ?? savedTpl.techStack ?? "",
    companyName: reqProfile.companyName ?? savedTpl.companyName ?? "",
    keyDetails: reqProfile.keyDetails ?? savedTpl.keyDetails ?? ""
  };
  const useInterviewMode = req.body?.interviewMode !== undefined
    ? req.body.interviewMode !== false
    : savedTpl.interviewMode !== false;
  const question = buildFinalPrompt(rawQuestion, {
    interviewMode: useInterviewMode,
    customTemplate: req.body?.customTemplate !== undefined ? req.body.customTemplate : savedTpl.customTemplate,
    profile: mergedProfile
  });
  const providerKey = String(req.body?.provider || "deepai").toLowerCase();
  const provider = PROVIDERS[providerKey];

  if (!rawQuestion) return res.status(400).json({ error: "Enter a question." });
  if (!provider) return res.status(400).json({ error: "Choose Gemini, ChatGPT, DeepSeek, Claude, Duck.ai, DeepAI, or Perplexity." });

  const requestedChatId = req.body?.chatId ? String(req.body.chatId) : null;
  let activeChatId = requestedChatId;
  try {
    const savedUser = await appendChatMessage({
      userId: req.user.userId,
      chatId: requestedChatId,
      role: "user",
      text: rawQuestion,
      provider: providerKey
    });
    activeChatId = savedUser.chatId;
  } catch (dbErr) {
    return res.status(500).json({ error: dbErr.message || "Could not save message." });
  }

  let fullAnswer = "";
  const mockRes = {
    setHeader: () => {},
    flushHeaders: () => {},
    write: (data) => {
      const clean = data.replace(/^data:\s*/, "").trim();
      try {
        const parsed = JSON.parse(clean);
        if (parsed.type === "chunk" && parsed.text) fullAnswer = parsed.text;
        if (parsed.type === "done" && parsed.text) fullAnswer = parsed.text;
        if (parsed.type === "error") throw new Error(parsed.error);
      } catch {}
    },
    end: async () => {
      if (fullAnswer) {
        await appendChatMessage({
          userId: req.user.userId,
          chatId: activeChatId,
          role: "assistant",
          text: fullAnswer,
          provider: provider.name
        }).catch(() => {});
        res.json({ answer: fullAnswer, provider: provider.name, chatId: activeChatId });
      } else {
        res.status(500).json({ error: "No response received." });
      }
    }
  };

  const directApiMode = req.body?.directApiMode === true;
  if (directApiMode) {
    try {
      const userKeys = await getUserApiKeys(req.user.userId).catch(() => ({}));
      const customKey = String(req.body?.apiKey || "").trim() || userKeys[providerKey] || "";
      if (!customKey) {
        return res.status(400).json({
          error: `No API key saved for ${provider.name}. Add your own ${provider.name} API key in Direct API settings, or turn OFF Direct API Mode for Browser Bridge.`
        });
      }
      fullAnswer = await runDirectApiProvider(providerKey, customKey, question, mockRes);
      await mockRes.end();
      return;
    } catch (err) {
      return res.status(500).json({ error: formatApiError(provider.name, err) });
    }
  }

  // Default: Browser bridge mode
  try {
    const assistant = await getProviderPage(providerKey);

    const closeButtons = assistant.locator('button[aria-label="Close"], button[aria-label="Dismiss"], button[aria-label="Dismiss announcement"], button:has-text("Stay logged out"), button:has-text("Maybe later")');
    const closeCount = await closeButtons.count().catch(() => 0);
    for (let i = 0; i < Math.min(closeCount, 5); i++) {
      const btn = closeButtons.nth(i);
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 300 }).catch(() => {});
      }
    }

    const pageTitle = await assistant.title().catch(() => "");
    if (/Just a moment|Attention Required/i.test(pageTitle)) {
      throw new Error(`${provider.name} is showing a Cloudflare verification challenge in the headless browser. Use Gemini/DeepAI Browser Bridge, turn ON Direct API Mode, or run locally with your logged-in Chrome.`);
    }

    if (providerKey === "deepseek" && assistant.url().includes("/sign_in")) {
      throw new Error("DeepSeek requires signing in first. Sign in to DeepSeek in your local Chrome browser (http://127.0.0.1:9222) or AI Bridge browser profile.");
    }

    const prompt = await findPromptInput(assistant, provider.prompt);
    if (!prompt) throw new Error(`Could not find prompt box on ${provider.name}.`);

    const initialCount = await assistant.evaluate((sel) => document.querySelectorAll(sel).length, provider.response).catch(() => 0);

    await prompt.click({ timeout: 3000 });
    await assistant.keyboard.insertText(question);
    await assistant.waitForTimeout(80);

    let sent = false;
    for (const sendSel of provider.send) {
      const sendBtn = assistant.locator(sendSel).first();
      if (
        await sendBtn.count().catch(() => 0) > 0 &&
        await sendBtn.isVisible().catch(() => false) &&
        await sendBtn.isEnabled().catch(() => false)
      ) {
        await sendBtn.click({ timeout: 2000 }).catch(() => {});
        sent = true;
        break;
      }
    }
    if (!sent) await assistant.keyboard.press("Enter");

    let lastText = "";
    let stableCount = 0;
    const startTime = Date.now();
    while (Date.now() - startTime < 60000) {
      await assistant.waitForTimeout(60);
      const { text: current, generating } = await pollBrowserState(assistant, providerKey, question, initialCount);
      if (current && current !== lastText) {
        lastText = current;
        stableCount = 0;
      } else if (current && current === lastText && !generating) {
        stableCount++;
        if (stableCount >= 4) break;
      }
    }
    if (!lastText) throw new Error(`No answer received from ${provider.name}.`);
    await appendChatMessage({
      userId: req.user.userId,
      chatId: activeChatId,
      role: "assistant",
      text: lastText,
      provider: provider.name
    }).catch(() => {});
    res.json({ answer: lastText, provider: provider.name, chatId: activeChatId });
  } catch (error) {
    res.status(500).json({ error: error.message || "Automation failed." });
  }
});

const PORT = Number(process.env.PORT) || 3000;
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`AI Bridge running at http://0.0.0.0:${PORT}`);
  // Connect to MongoDB Atlas and warm up local Whisper asynchronously
  connectToDatabase().catch((err) => console.warn("DB init warning:", err?.message || err));
  warmUpLocalWhisper();
});

// Real-time system-audio transcription WebSocket (/ws/listen)
const listenWss = new WebSocketServer({ server, path: "/ws/listen" });

listenWss.on("connection", async (clientWs, req) => {
  // Verify user auth from query token or cookie
  let wsToken = null;
  try {
    const reqUrl = new URL(req.url || "/ws/listen", "http://localhost");
    wsToken = reqUrl.searchParams.get("token");
  } catch {}
  if (!wsToken) wsToken = extractTokenFromRequest(req);
  const wsUser = verifyTokenPayload(wsToken);
  if (!wsUser) {
    try {
      clientWs.send(JSON.stringify({ type: "error", error: "Please sign in to use Listen." }));
      clientWs.close(1008, "Unauthorized");
    } catch {}
    return;
  }
  const userKeys = await getUserApiKeys(wsUser.userId).catch(() => ({}));
  const geminiKey = userKeys.gemini || "";
  let engineInfo = getSpeechEngineInfo(geminiKey);
  let liveSession = null;
  let localQueue = Promise.resolve();
  let closed = false;

  const safeSend = (payload) => {
    if (closed || clientWs.readyState !== 1) return;
    try {
      clientWs.send(JSON.stringify(payload));
    } catch {}
  };

  if (engineInfo.engine === "gemini-live") {
    createGeminiLiveTranscriptionSession({
      apiKey: geminiKey,
      onReady: () => safeSend({ type: "ready", ...engineInfo }),
      onInterim: (text) => safeSend({ type: "interim", text }),
      onTranscript: (text) => safeSend({ type: "transcript", text }),
      onError: (err) => {
        console.warn("Gemini Live audio error, switching to local Whisper:", err?.message || err);
        liveSession = null;
        engineInfo = getSpeechEngineInfo("");
        safeSend({ type: "ready", ...engineInfo });
      }
    })
      .then((sessionObj) => {
        if (closed) {
          try { sessionObj.close(); } catch {}
          return;
        }
        liveSession = sessionObj;
      })
      .catch((err) => {
        console.warn("Gemini Live unavailable, using local Whisper:", err?.message || err);
        liveSession = null;
        engineInfo = getSpeechEngineInfo("");
        safeSend({ type: "ready", ...engineInfo });
      });
  } else {
    safeSend({ type: "ready", ...engineInfo });
  }

  clientWs.on("message", (data, isBinary) => {
    if (closed) return;

    if (!isBinary) {
      let msg = null;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {}

      if (msg?.type === "stop") {
        if (liveSession) {
          try { liveSession.close(); } catch {}
          liveSession = null;
        }
        localQueue.finally(() => {
          safeSend({ type: "stopped" });
        });
      }
      return;
    }

    const pcmBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (liveSession && engineInfo.engine === "gemini-live") {
      try {
        liveSession.sendRealtimeInput({
          audio: {
            data: pcmBuffer.toString("base64"),
            mimeType: "audio/pcm;rate=16000"
          }
        });
        return;
      } catch {
        liveSession = null;
        engineInfo = getSpeechEngineInfo("");
        safeSend({ type: "ready", ...engineInfo });
      }
    }

    // Queue utterance transcription sequentially on local Whisper
    localQueue = localQueue
      .then(async () => {
        if (closed) return;
        const result = await transcribePcm16(pcmBuffer, "");
        if (result?.text) {
          safeSend({
            type: "transcript",
            text: result.text,
            engine: result.engine,
            durationMs: result.durationMs
          });
        }
      })
      .catch((err) => {
        safeSend({ type: "error", error: err?.message || "Transcription failed." });
      });
  });

  clientWs.on("close", () => {
    closed = true;
    if (liveSession) {
      try { liveSession.close(); } catch {}
      liveSession = null;
    }
  });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log("Port 3000 is already in use; connected to existing instance.");
  } else {
    throw err;
  }
});
