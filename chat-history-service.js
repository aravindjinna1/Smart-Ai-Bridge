const { ObjectId } = require("mongodb");
const { getCollections } = require("./db");

function deriveChatTitle(firstMessage) {
  const clean = String(firstMessage || "")
    .replace(/\[SYSTEM INSTRUCTION FOR SCREEN CONTENT\][\s\S]*?--- END OF SCREEN CONTENT ---/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "New Chat";
  return clean.length > 52 ? `${clean.slice(0, 52).trim()}...` : clean;
}

async function listUserChats(userId) {
  if (!ObjectId.isValid(userId)) return [];
  const { chats } = await getCollections();
  const docs = await chats
    .find(
      { userId: new ObjectId(userId) },
      { projection: { title: 1, provider: 1, updatedAt: 1, createdAt: 1, messages: { $slice: -1 } } }
    )
    .sort({ updatedAt: -1 })
    .limit(100)
    .toArray();

  return docs.map((d) => ({
    id: String(d._id),
    title: d.title || "New Chat",
    provider: d.provider || "gemini",
    updatedAt: d.updatedAt,
    createdAt: d.createdAt,
    preview: d.messages?.[0]?.text ? String(d.messages[0].text).slice(0, 80) : ""
  }));
}

async function createUserChat({ userId, title, provider }) {
  if (!ObjectId.isValid(userId)) {
    throw new Error("Invalid user session.");
  }
  const { chats } = await getCollections();
  const now = new Date();
  const doc = {
    userId: new ObjectId(userId),
    title: String(title || "New Chat").trim() || "New Chat",
    provider: String(provider || "gemini").toLowerCase(),
    messages: [],
    createdAt: now,
    updatedAt: now
  };
  const result = await chats.insertOne(doc);
  return {
    id: String(result.insertedId),
    title: doc.title,
    provider: doc.provider,
    messages: [],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
}

async function getUserChatById(userId, chatId) {
  if (!ObjectId.isValid(userId) || !ObjectId.isValid(chatId)) {
    return null;
  }
  const { chats } = await getCollections();
  const doc = await chats.findOne({
    _id: new ObjectId(chatId),
    userId: new ObjectId(userId)
  });
  if (!doc) return null;
  return {
    id: String(doc._id),
    title: doc.title || "New Chat",
    provider: doc.provider || "gemini",
    messages: Array.isArray(doc.messages) ? doc.messages : [],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt
  };
}

async function appendChatMessage({ userId, chatId, role, text, provider }) {
  if (!ObjectId.isValid(userId)) {
    throw new Error("Invalid user session.");
  }
  const { chats } = await getCollections();
  const now = new Date();
  const msg = {
    id: new ObjectId().toString(),
    role: role === "assistant" ? "assistant" : "user",
    text: String(text || ""),
    provider: provider ? String(provider) : undefined,
    createdAt: now
  };

  if (chatId && ObjectId.isValid(chatId)) {
    const existing = await chats.findOne(
      { _id: new ObjectId(chatId), userId: new ObjectId(userId) },
      { projection: { title: 1, messages: 1 } }
    );
    if (existing) {
      const update = {
        $push: { messages: msg },
        $set: {
          updatedAt: now,
          ...(provider ? { provider: String(provider).toLowerCase() } : {})
        }
      };
      if (
        role === "user" &&
        (!existing.title || existing.title === "New Chat") &&
        (!existing.messages || existing.messages.length === 0)
      ) {
        update.$set.title = deriveChatTitle(text);
      }
      await chats.updateOne(
        { _id: new ObjectId(chatId), userId: new ObjectId(userId) },
        update
      );
      return { chatId: String(chatId), message: msg };
    }
  }

  // Create a brand new chat owned strictly by this user
  const newChat = {
    userId: new ObjectId(userId),
    title: role === "user" ? deriveChatTitle(text) : "New Chat",
    provider: String(provider || "gemini").toLowerCase(),
    messages: [msg],
    createdAt: now,
    updatedAt: now
  };
  const result = await chats.insertOne(newChat);
  return { chatId: String(result.insertedId), title: newChat.title, message: msg };
}

async function renameUserChat({ userId, chatId, title }) {
  if (!ObjectId.isValid(userId) || !ObjectId.isValid(chatId)) {
    return null;
  }
  const cleanTitle = String(title || "").trim().slice(0, 120);
  if (!cleanTitle) return null;
  const { chats } = await getCollections();
  const result = await chats.findOneAndUpdate(
    { _id: new ObjectId(chatId), userId: new ObjectId(userId) },
    { $set: { title: cleanTitle, updatedAt: new Date() } },
    { returnDocument: "after", projection: { title: 1, updatedAt: 1 } }
  );
  if (!result) return null;
  return { id: String(result._id), title: result.title, updatedAt: result.updatedAt };
}

async function deleteUserChat({ userId, chatId }) {
  if (!ObjectId.isValid(userId) || !ObjectId.isValid(chatId)) {
    return false;
  }
  const { chats } = await getCollections();
  const result = await chats.deleteOne({
    _id: new ObjectId(chatId),
    userId: new ObjectId(userId)
  });
  return result.deletedCount > 0;
}

module.exports = {
  deriveChatTitle,
  listUserChats,
  createUserChat,
  getUserChatById,
  appendChatMessage,
  renameUserChat,
  deleteUserChat
};
