require("dotenv").config();
const { MongoClient, ObjectId } = require("mongodb");
const fs = require("fs");
const path = require("path");

const DEFAULT_DB_NAME = process.env.MONGODB_DB_NAME || "ai_bridge";
const LOCAL_FALLBACK_FILE = path.join(__dirname, "data", "local-db.json");

let client = null;
let dbInstance = null;
let connectPromise = null;
let dbMode = "connecting"; // "atlas" | "local-fallback"
let lastAtlasError = null;

function toPlainComparable(val) {
  if (val instanceof ObjectId) return val.toHexString();
  if (val instanceof Date) return val.getTime();
  return val;
}

function matchesQuery(doc, query = {}) {
  for (const [key, cond] of Object.entries(query)) {
    const docVal = doc[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !(cond instanceof ObjectId)) {
      if ("$gt" in cond) {
        if (!(toPlainComparable(docVal) > toPlainComparable(cond.$gt))) return false;
      }
      if ("$lt" in cond) {
        if (!(toPlainComparable(docVal) < toPlainComparable(cond.$lt))) return false;
      }
      continue;
    }
    if (toPlainComparable(docVal) !== toPlainComparable(cond)) return false;
  }
  return true;
}

function applyProjection(doc, projection) {
  if (!doc) return null;
  const copy = { ...doc };
  if (Array.isArray(copy.messages) && projection?.messages?.$slice !== undefined) {
    const s = projection.messages.$slice;
    copy.messages = s < 0 ? copy.messages.slice(s) : copy.messages.slice(0, s);
  }
  if (!projection) return copy;
  const keys = Object.keys(projection);
  const isExclusion = keys.some((k) => projection[k] === 0);
  if (isExclusion) {
    for (const k of keys) {
      if (projection[k] === 0) delete copy[k];
    }
    return copy;
  }
  const out = { _id: copy._id };
  for (const k of keys) {
    if (projection[k] && k in copy) out[k] = copy[k];
  }
  return out;
}

function reviveDates(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(reviveDates);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if ((k === "createdAt" || k === "updatedAt" || k === "expiresAt" || k === "lastLoginAt" || k === "usedAt") && typeof v === "string") {
      const d = new Date(v);
      out[k] = Number.isNaN(d.getTime()) ? v : d;
    } else if (v && typeof v === "object") {
      out[k] = reviveDates(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function createLocalDbFallback() {
  fs.mkdirSync(path.dirname(LOCAL_FALLBACK_FILE), { recursive: true });
  let store = { users: [], password_resets: [], chats: [] };
  if (fs.existsSync(LOCAL_FALLBACK_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(LOCAL_FALLBACK_FILE, "utf8"));
      store = {
        users: reviveDates(parsed.users || []),
        password_resets: reviveDates(parsed.password_resets || []),
        chats: reviveDates(parsed.chats || [])
      };
    } catch {}
  }

  function persist() {
    fs.writeFileSync(LOCAL_FALLBACK_FILE, JSON.stringify(store, null, 2), "utf8");
  }

  function makeCollection(name) {
    if (!Array.isArray(store[name])) store[name] = [];
    return {
      collectionName: name,
      async createIndex() {},
      async findOne(query = {}, options = {}) {
        const found = store[name].find((d) => matchesQuery(d, query));
        return found ? applyProjection(found, options.projection) : null;
      },
      find(query = {}, options = {}) {
        let rows = store[name].filter((d) => matchesQuery(d, query));
        return {
          sort(sortSpec = {}) {
            const entries = Object.entries(sortSpec);
            rows = [...rows].sort((a, b) => {
              for (const [k, dir] of entries) {
                const av = toPlainComparable(a[k]) || 0;
                const bv = toPlainComparable(b[k]) || 0;
                if (av < bv) return -1 * dir;
                if (av > bv) return 1 * dir;
              }
              return 0;
            });
            return this;
          },
          limit(n) {
            rows = rows.slice(0, n);
            return this;
          },
          async toArray() {
            return rows.map((r) => applyProjection(r, options.projection));
          }
        };
      },
      async insertOne(doc) {
        const _id = doc._id ? String(doc._id) : new ObjectId().toHexString();
        const saved = { ...doc, _id };
        store[name].push(saved);
        persist();
        return { insertedId: _id };
      },
      async updateOne(query, update) {
        const doc = store[name].find((d) => matchesQuery(d, query));
        if (!doc) return { matchedCount: 0, modifiedCount: 0 };
        if (update.$set) Object.assign(doc, update.$set);
        if (update.$push) {
          for (const [k, val] of Object.entries(update.$push)) {
            if (!Array.isArray(doc[k])) doc[k] = [];
            doc[k].push(val);
          }
        }
        persist();
        return { matchedCount: 1, modifiedCount: 1 };
      },
      async updateMany(query, update) {
        let count = 0;
        for (const doc of store[name]) {
          if (matchesQuery(doc, query)) {
            if (update.$set) Object.assign(doc, update.$set);
            count++;
          }
        }
        if (count > 0) persist();
        return { matchedCount: count, modifiedCount: count };
      },
      async findOneAndUpdate(query, update, options = {}) {
        const doc = store[name].find((d) => matchesQuery(d, query));
        if (!doc) return null;
        if (update.$set) Object.assign(doc, update.$set);
        persist();
        return applyProjection(doc, options.projection);
      },
      async deleteOne(query) {
        const idx = store[name].findIndex((d) => matchesQuery(d, query));
        if (idx === -1) return { deletedCount: 0 };
        store[name].splice(idx, 1);
        persist();
        return { deletedCount: 1 };
      }
    };
  }

  return {
    collection: (name) => makeCollection(name)
  };
}

async function connectToDatabase() {
  if (dbInstance) return dbInstance;
  if (connectPromise) return connectPromise;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    dbMode = "local-fallback";
    lastAtlasError = "MONGODB_URI is not configured.";
    dbInstance = createLocalDbFallback();
    return dbInstance;
  }

  connectPromise = (async () => {
    try {
      const mongoClient = new MongoClient(uri, {
        serverSelectionTimeoutMS: 4500,
        connectTimeoutMS: 4500
      });
      await mongoClient.connect();
      const db = mongoClient.db(DEFAULT_DB_NAME);

      await Promise.all([
        db.collection("users").createIndex({ email: 1 }, { unique: true }),
        db.collection("password_resets").createIndex({ tokenHash: 1 }, { unique: true }),
        db.collection("password_resets").createIndex({ userId: 1 }),
        db.collection("password_resets").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        db.collection("chats").createIndex({ userId: 1, updatedAt: -1 })
      ]);

      client = mongoClient;
      dbInstance = db;
      dbMode = "atlas";
      lastAtlasError = null;
      console.log(`Connected to MongoDB Atlas database "${DEFAULT_DB_NAME}".`);
      return db;
    } catch (err) {
      const shortErr = (err?.message || String(err)).split("\n")[0];
      lastAtlasError = shortErr;
      dbMode = "local-fallback";
      console.warn(
        `⚠️ MongoDB Atlas connection rejected (${shortErr}). Make sure this server IP is allowed in MongoDB Atlas -> Network Access (0.0.0.0/0). Using local persistent store fallback for now.`
      );
      dbInstance = createLocalDbFallback();
      return dbInstance;
    }
  })();

  return connectPromise;
}

async function getCollections() {
  const db = await connectToDatabase();
  return {
    db,
    users: db.collection("users"),
    passwordResets: db.collection("password_resets"),
    chats: db.collection("chats")
  };
}

function getDbStatus() {
  return {
    mode: dbMode,
    database: DEFAULT_DB_NAME,
    atlasError: lastAtlasError
  };
}

async function closeDatabase() {
  if (client) {
    try {
      await client.close();
    } catch {}
  }
  client = null;
  dbInstance = null;
  connectPromise = null;
}

module.exports = {
  connectToDatabase,
  getCollections,
  getDbStatus,
  closeDatabase
};
