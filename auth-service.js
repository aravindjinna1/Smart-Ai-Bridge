const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const { ObjectId } = require("mongodb");
const { getCollections } = require("./db");

const COOKIE_NAME = "ai_bridge_token";
const JWT_SECRET = process.env.JWT_SECRET || "ai-bridge-dev-secret-key-2026";
const RESET_EXPIRY_MINUTES = 30;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizeEmail(email));
}

function isValidPassword(password) {
  return typeof password === "string" && password.length > 6;
}

function hashToken(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken || "")).digest("hex");
}

function signAuthToken(user, rememberMe = false) {
  return jwt.sign(
    {
      sub: String(user.id || user._id),
      email: user.email,
      fullName: user.fullName
    },
    JWT_SECRET,
    { expiresIn: rememberMe ? "30d" : "24h" }
  );
}

function parseCookies(cookieHeader) {
  const map = {};
  if (!cookieHeader || typeof cookieHeader !== "string") return map;
  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key) {
      try {
        map[key] = decodeURIComponent(val);
      } catch {
        map[key] = val;
      }
    }
  }
  return map;
}

function extractTokenFromRequest(req) {
  const authHeader = String(req.headers?.authorization || "");
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  const cookies = parseCookies(req.headers?.cookie);
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];
  return null;
}

function setAuthCookie(res, req, token, rememberMe = false) {
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    isHttps ? "SameSite=None" : "SameSite=Lax"
  ];
  if (isHttps) parts.push("Secure");
  if (rememberMe) {
    parts.push(`Max-Age=${30 * 24 * 60 * 60}`);
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAuthCookie(res, req) {
  const isHttps = req.secure || req.headers["x-forwarded-proto"] === "https";
  const parts = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "Max-Age=0",
    isHttps ? "SameSite=None" : "SameSite=Lax"
  ];
  if (isHttps) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function verifyTokenPayload(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload?.sub || !ObjectId.isValid(payload.sub)) return null;
    return {
      userId: payload.sub,
      email: payload.email,
      fullName: payload.fullName
    };
  } catch {
    return null;
  }
}

async function requireAuth(req, res, next) {
  const token = extractTokenFromRequest(req);
  const decoded = verifyTokenPayload(token);
  if (!decoded) {
    return res.status(401).json({
      ok: false,
      code: "UNAUTHORIZED",
      error: "Please sign in to access your AI Bridge workspace and chat history."
    });
  }
  req.user = decoded;
  next();
}

async function registerUser({ fullName, email, password }) {
  const cleanName = String(fullName || "").trim();
  const cleanEmail = normalizeEmail(email);

  if (cleanName.length < 2) {
    const err = new Error("Full name must be at least 2 characters.");
    err.status = 400;
    throw err;
  }
  if (!isValidEmail(cleanEmail)) {
    const err = new Error("Please enter a valid email address.");
    err.status = 400;
    throw err;
  }
  if (!isValidPassword(password)) {
    const err = new Error("Password must be more than 6 characters (minimum 7 characters).");
    err.status = 400;
    throw err;
  }

  const { users } = await getCollections();
  const existing = await users.findOne({ email: cleanEmail });
  if (existing) {
    const err = new Error("An account with this email already exists. Please log in instead.");
    err.status = 409;
    throw err;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date();
  const result = await users.insertOne({
    fullName: cleanName,
    email: cleanEmail,
    passwordHash,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now
  });

  return {
    id: String(result.insertedId),
    fullName: cleanName,
    email: cleanEmail,
    createdAt: now
  };
}

async function loginUser({ email, password }) {
  const cleanEmail = normalizeEmail(email);
  if (!isValidEmail(cleanEmail) || !password) {
    const err = new Error("Please enter both a valid email and password.");
    err.status = 400;
    throw err;
  }

  const { users } = await getCollections();
  const user = await users.findOne({ email: cleanEmail });
  if (!user) {
    const err = new Error("Invalid email or password.");
    err.status = 401;
    throw err;
  }

  const match = await bcrypt.compare(String(password), user.passwordHash);
  if (!match) {
    const err = new Error("Invalid email or password.");
    err.status = 401;
    throw err;
  }

  await users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

  return {
    id: String(user._id),
    fullName: user.fullName,
    email: user.email
  };
}

async function getUserById(userId) {
  if (!ObjectId.isValid(userId)) return null;
  const { users } = await getCollections();
  const user = await users.findOne(
    { _id: new ObjectId(userId) },
    { projection: { passwordHash: 0 } }
  );
  if (!user) return null;
  return {
    id: String(user._id),
    fullName: user.fullName,
    email: user.email,
    createdAt: user.createdAt
  };
}

const API_KEY_PROVIDERS = ["gemini", "deepai", "chatgpt", "deepseek", "perplexity", "duckai", "claude"];

function normalizeUserApiKeys(raw = {}) {
  const cleaned = {};
  for (const key of API_KEY_PROVIDERS) {
    cleaned[key] = typeof raw?.[key] === "string" ? raw[key].trim() : "";
  }
  return cleaned;
}

async function getUserApiKeys(userId) {
  if (!ObjectId.isValid(userId)) return normalizeUserApiKeys({});
  const { users } = await getCollections();
  const user = await users.findOne(
    { _id: new ObjectId(userId) },
    { projection: { apiKeys: 1 } }
  );
  return normalizeUserApiKeys(user?.apiKeys || {});
}

async function saveUserApiKeys(userId, incomingKeys = {}) {
  if (!ObjectId.isValid(userId)) {
    const err = new Error("Invalid user session.");
    err.status = 401;
    throw err;
  }
  const existing = await getUserApiKeys(userId);
  const merged = { ...existing };
  for (const key of API_KEY_PROVIDERS) {
    if (incomingKeys[key] !== undefined) {
      merged[key] = String(incomingKeys[key] || "").trim();
    }
  }
  const { users } = await getCollections();
  await users.updateOne(
    { _id: new ObjectId(userId) },
    { $set: { apiKeys: merged, updatedAt: new Date() } }
  );
  return merged;
}

async function sendResetEmail({ toEmail, fullName, resetUrl }) {
  const mailHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; background: #0f172a; color: #e2e8f0; border-radius: 12px;">
      <h2 style="margin-top: 0; color: #f8fafc;">Reset Your AI Bridge Password</h2>
      <p>Hi ${String(fullName || "there")},</p>
      <p>We received a request to reset the password for your AI Bridge account (<strong>${toEmail}</strong>).</p>
      <p style="margin: 24px 0;">
        <a href="${resetUrl}" style="display: inline-block; padding: 12px 22px; background: #2563eb; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600;">Reset Password</a>
      </p>
      <p style="font-size: 13px; color: #94a3b8;">Or copy and paste this link into your browser:<br>${resetUrl}</p>
      <p style="font-size: 12px; color: #64748b;">This link expires in ${RESET_EXPIRY_MINUTES} minutes. If you didn't request this change, you can ignore this email.</p>
    </div>
  `;

  const mailText = `Hi ${fullName || "there"},\n\nReset your AI Bridge password using this link (expires in ${RESET_EXPIRY_MINUTES} minutes):\n${resetUrl}\n`;

  // 1. Real SMTP if configured via env vars
  const smtpHost = process.env.SMTP_HOST?.trim();
  const smtpUser = process.env.SMTP_USER?.trim() || process.env.GMAIL_USER?.trim();
  const smtpPass = process.env.SMTP_PASS?.trim() || process.env.GMAIL_APP_PASSWORD?.trim();

  if (smtpHost && smtpUser && smtpPass) {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: smtpUser, pass: smtpPass }
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || smtpUser,
      to: toEmail,
      subject: "AI Bridge — Reset Your Password",
      text: mailText,
      html: mailHtml
    });
    return { deliveryMode: "smtp", previewUrl: null };
  }

  if (smtpUser && smtpPass && process.env.GMAIL_USER) {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: smtpUser, pass: smtpPass }
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || smtpUser,
      to: toEmail,
      subject: "AI Bridge — Reset Your Password",
      text: mailText,
      html: mailHtml
    });
    return { deliveryMode: "gmail", previewUrl: null };
  }

  // 2. Fallback to Nodemailer Ethereal test account so real email sending works in dev/testing
  try {
    const testAccount = await Promise.race([
      nodemailer.createTestAccount(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Ethereal timeout")), 4500))
    ]);
    const transporter = nodemailer.createTransport({
      host: testAccount.smtp.host,
      port: testAccount.smtp.port,
      secure: testAccount.smtp.secure,
      auth: { user: testAccount.user, pass: testAccount.pass }
    });
    const info = await transporter.sendMail({
      from: '"AI Bridge Security" <no-reply@aibridge.local>',
      to: toEmail,
      subject: "AI Bridge — Reset Your Password",
      text: mailText,
      html: mailHtml
    });
    return {
      deliveryMode: "ethereal",
      previewUrl: nodemailer.getTestMessageUrl(info) || null
    };
  } catch {
    return { deliveryMode: "direct-link", previewUrl: null };
  }
}

async function requestPasswordReset({ email, appOrigin }) {
  const cleanEmail = normalizeEmail(email);
  if (!isValidEmail(cleanEmail)) {
    const err = new Error("Please enter a valid email address.");
    err.status = 400;
    throw err;
  }

  const { users, passwordResets } = await getCollections();
  const user = await users.findOne({ email: cleanEmail });
  if (!user) {
    const err = new Error("No account exists with this email address in our database.");
    err.status = 404;
    throw err;
  }

  // Invalidate prior unused reset tokens for this user
  await passwordResets.updateMany(
    { userId: user._id, used: false },
    { $set: { used: true } }
  );

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESET_EXPIRY_MINUTES * 60 * 1000);

  await passwordResets.insertOne({
    userId: user._id,
    email: user.email,
    tokenHash,
    used: false,
    createdAt: now,
    expiresAt
  });

  const cleanOrigin = String(appOrigin || "http://localhost:3000").replace(/\/+$/, "");
  const resetUrl = `${cleanOrigin}/?resetToken=${rawToken}#reset-password`;
  const emailInfo = await sendResetEmail({
    toEmail: user.email,
    fullName: user.fullName,
    resetUrl
  });

  return {
    ok: true,
    email: user.email,
    deliveryMode: emailInfo.deliveryMode,
    previewUrl: emailInfo.previewUrl,
    resetUrl: emailInfo.deliveryMode === "smtp" || emailInfo.deliveryMode === "gmail" ? null : resetUrl,
    expiresInMinutes: RESET_EXPIRY_MINUTES
  };
}

async function verifyResetToken(rawToken) {
  if (!rawToken || typeof rawToken !== "string") {
    return { valid: false, error: "Reset token is missing." };
  }
  const { passwordResets } = await getCollections();
  const doc = await passwordResets.findOne({
    tokenHash: hashToken(rawToken.trim()),
    used: false,
    expiresAt: { $gt: new Date() }
  });
  if (!doc) {
    return { valid: false, error: "This password reset link is invalid or has expired." };
  }
  return { valid: true, email: doc.email };
}

async function resetPasswordWithToken({ token, password, confirmPassword }) {
  if (!token || typeof token !== "string") {
    const err = new Error("Missing or invalid reset token.");
    err.status = 400;
    throw err;
  }
  if (!isValidPassword(password)) {
    const err = new Error("Password must be more than 6 characters (minimum 7 characters).");
    err.status = 400;
    throw err;
  }
  if (password !== confirmPassword) {
    const err = new Error("Password and Confirm Password do not match.");
    err.status = 400;
    throw err;
  }

  const { users, passwordResets } = await getCollections();
  const tokenHash = hashToken(token.trim());
  const resetDoc = await passwordResets.findOne({
    tokenHash,
    used: false,
    expiresAt: { $gt: new Date() }
  });

  if (!resetDoc) {
    const err = new Error("This password reset link is invalid or has expired.");
    err.status = 400;
    throw err;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const now = new Date();
  await users.updateOne(
    { _id: resetDoc.userId },
    { $set: { passwordHash, updatedAt: now } }
  );
  await passwordResets.updateOne(
    { _id: resetDoc._id },
    { $set: { used: true, usedAt: now } }
  );

  return { ok: true, email: resetDoc.email };
}

module.exports = {
  COOKIE_NAME,
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
  API_KEY_PROVIDERS,
  requestPasswordReset,
  verifyResetToken,
  resetPasswordWithToken
};
