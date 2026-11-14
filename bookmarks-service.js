const { ObjectId } = require("mongodb");
const { getCollections } = require("./db");

async function listUserBookmarks(userId) {
  if (!ObjectId.isValid(userId)) return [];
  const { bookmarks } = await getCollections();
  const docs = await bookmarks
    .find({ userId: new ObjectId(userId) })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();

  return docs.map((d) => ({
    id: String(d._id),
    chatId: d.chatId ? String(d.chatId) : null,
    question: String(d.question || ""),
    answer: String(d.answer || ""),
    provider: String(d.provider || ""),
    answerStyle: String(d.answerStyle || "deep_technical"),
    topic: String(d.topic || "General"),
    notes: String(d.notes || ""),
    createdAt: d.createdAt
  }));
}

async function createUserBookmark({ userId, chatId, question, answer, provider, answerStyle, topic, notes }) {
  if (!ObjectId.isValid(userId)) {
    const err = new Error("Invalid user session.");
    err.status = 401;
    throw err;
  }
  const cleanQuestion = String(question || "").trim();
  const cleanAnswer = String(answer || "").trim();
  if (!cleanQuestion && !cleanAnswer) {
    const err = new Error("Question or answer content is required to bookmark.");
    err.status = 400;
    throw err;
  }

  const { bookmarks } = await getCollections();
  const now = new Date();
  const doc = {
    userId: new ObjectId(userId),
    chatId: chatId && ObjectId.isValid(chatId) ? new ObjectId(chatId) : null,
    question: cleanQuestion.slice(0, 3000),
    answer: cleanAnswer.slice(0, 12000),
    provider: String(provider || "").trim().slice(0, 40),
    answerStyle: String(answerStyle || "deep_technical").trim().slice(0, 40) || "deep_technical",
    topic: String(topic || "Weak Topic").trim().slice(0, 80) || "Weak Topic",
    notes: String(notes || "").trim().slice(0, 1000),
    createdAt: now
  };
  const result = await bookmarks.insertOne(doc);
  return {
    id: String(result.insertedId),
    chatId: doc.chatId ? String(doc.chatId) : null,
    question: doc.question,
    answer: doc.answer,
    provider: doc.provider,
    answerStyle: doc.answerStyle,
    topic: doc.topic,
    notes: doc.notes,
    createdAt: doc.createdAt
  };
}

async function deleteUserBookmark({ userId, bookmarkId }) {
  if (!ObjectId.isValid(userId) || !ObjectId.isValid(bookmarkId)) {
    return false;
  }
  const { bookmarks } = await getCollections();
  const res = await bookmarks.deleteOne({
    _id: new ObjectId(bookmarkId),
    userId: new ObjectId(userId)
  });
  return res.deletedCount > 0;
}

module.exports = {
  listUserBookmarks,
  createUserBookmark,
  deleteUserBookmark
};
