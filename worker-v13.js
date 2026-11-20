/**
 * ربات درخواست کتاب — نسخه ۱۳ (Cloudflare Worker + دیتابیس D1)
 *
 * تغییرهای این نسخه نسبت به نسخه ۱۲:
 *  - ایندکس به‌جای یک کلید بزرگ KV داخل D1 (SQLite) با جستجوی FTS5 است؛
 *    هر جستجو فقط چند ردیف را می‌خواند، نه کل آرشیو را.
 *  - جستجو: نرمال‌سازی فارسی (ی/ي، ک/ك، اعراب، ارقام فارسی و عربی، نیم‌فاصله،
 *    «ها/های»)، تطبیق پیشوندی، تحمل غلط املایی، رتبه‌بندی، و دکمه انتخاب
 *    وقتی چند کتاب نزدیک هم بودند.
 *  - فیلتر درخواست بازتر شد: پیام‌های کوتاه که دقیقاً با یک کتاب بخورند هم جواب
 *    می‌گیرند؛ بحث و حرف معمولی همچنان سکوت می‌گیرد.
 *  - دیگر برای هر پیام در KV نوشته نمی‌شود (سقف نوشتن روزانه پلن رایگان).
 *  - خطاها ثبت می‌شوند و با /status دیده می‌شوند (قبلاً بی‌صدا از بین می‌رفتند).
 *  - وارد کردن ایندکس قدیمی (JSON) تکه‌تکه انجام می‌شود تا از سقف CPU پلن رایگان
 *    رد نشود (با Cron هر دقیقه یا با دستور /continue).
 *  - جلوی پردازش تکراری آپدیت گرفته شده (جدول seen در D1) تا تلگرام اگر
 *    یک آپدیت را دو بار فرستاد، ربات دو بار جواب ندهد.
 *  - ایمپورت هر مرحله ۲۰۰ کتاب است (قبلاً ۶۰) تا ایمپورت آرشیو سریع‌تر تمام شود.
 *
 * برای ایمپورت خودکار باید Cron Trigger هر دقیقه روی Worker گذاشته شود
 * (داشبورد: Triggers → Add Cron Trigger → "* * * * *" ، یا در wrangler.toml).
 *
 * متغیرهای لازم (Settings → Variables):
 *   TELEGRAM_BOT_TOKEN  (Secret)
 *   ADMIN_USER_ID       (آیدی عددی تلگرام شما — بسیار توصیه می‌شود)
 *   DB                  (D1 Database binding — اسم دقیقاً DB)
 */

const VERSION = "13";
const IA_TIMEOUT_MS = 8000;
const IMPORT_SLICE = 200; // تعداد کتاب در هر مرحله ایمپورت (هر مرحله: دانلود + پارس JSON + درج در D1؛ ۲۰۰ تا سقف پارامتر D1 را رد نمی‌کند)
const MAX_BUTTONS = 5;

/* ------------------------------------------------------------------ */
/* نرمال‌سازی فارسی                                                    */
/* ------------------------------------------------------------------ */
function normalizeFa(text) {
  return String(text || "")
    .replace(/[\u064A\u0649]/g, "\u06CC") // ي ى → ی
    .replace(/\u0643/g, "\u06A9") // ك → ک
    .replace(/[\u0629\u06C0]/g, "\u0647") // ة ۀ → ه
    .replace(/\u0624/g, "\u0648") // ؤ → و
    .replace(/[\u0623\u0625\u0622\u0671]/g, "\u0627") // أ إ آ ٱ → ا
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "") // اعراب و کشیده
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0)) // ارقام فارسی
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)) // ارقام عربی
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, " ") // نیم‌فاصله و کاراکترهای نامرئی → فاصله
    .replace(/[\u0600-\u0605\u060C\u061B\u061F\u066A-\u066D\u06D4\u06DD]/g, " ") // علائم عربی
    .replace(/[^0-9a-zA-Z\u0600-\u06FF\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// حذف «ها / های» از آخر کلمه‌های بلند
function stem(w) {
  if (w.length > 5 && w.endsWith("\u0647\u0627\u06CC")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("\u0647\u0627")) return w.slice(0, -2);
  return w;
}

function tokens(text) {
  const n = normalizeFa(text);
  return n ? n.split(" ").map(stem) : [];
}

// متنی که در FTS ذخیره می‌شود: کلمه‌های نرمال‌شده + شکل چسبیده کلمه‌های نیم‌فاصله‌دار
// (تا هم «کتاب‌خانه» و هم «کتابخانه» پیدا شود)
function ftsText(title, extra) {
  const src = String(title || "") + (extra ? " " + extra : "");
  const base = tokens(src);
  const more = [];
  for (const w of src.split(/\s+/)) {
    if (w.includes("\u200c")) more.push(...tokens(w.replace(/\u200c/g, "")));
  }
  return [...new Set([...base, ...more])].join(" ");
}

function mkSet(list) {
  return new Set(list.flatMap((w) => normalizeFa(w).split(" ")).filter(Boolean));
}

// کلمه‌هایی که از جستجو حذف می‌شوند (سلام، درخواست، فعل‌های درخواست و...)
const QUERY_STOP = mkSet([
  "کتاب", "کتابی", "رمان", "جزوه", "مقاله", "نسخه", "فایل", "pdf", "پیدیاف", "صوتی", "دانلود",
  "لینک", "لینکش", "لطفا", "لطف", "ممنون", "ممنونم", "مرسی", "تشکر", "سپاس", "سپاسگزارم",
  "سلام", "علیکم", "درود", "بخیر", "خسته", "نباشید", "ببخشید", "عزیز", "داداش", "رفیق", "دوستان",
  "میخوام", "میخواهم", "میخواستم", "میخوایم", "می‌خوام", "می‌خواهم", "می‌خواستم", "خوام", "می", "نمی",
  "دارید", "دارین", "داری", "داره", "داشتید", "داشتین", "داشتی", "دارم",
  "بفرست", "بفرستید", "بفرستین", "ارسال", "بذار", "بذارید", "بذارین", "بزار", "بزارید", "بزارین",
  "بده", "بدید", "بدین", "کن", "کنید", "بکن", "بکنید", "بگو", "بگید", "بگین",
  "پیدا", "موجود", "موجوده", "هست", "هستش", "هستین", "هستید", "نیست",
  "کسی", "اگه", "اگر", "آیا", "رو", "را", "برای", "من", "ما", "شما", "میشه", "چیه", "چیست", "چه", "خبر",
  "از", "به", "با", "در", "که", "این", "آن", "او", "تو", "هم", "یه", "یک", "اون", "همین", "هم‌چنین",
  "ها", "های", "هایی",
]);

// کلمه‌های درخواست: وجودشان یعنی پیام صریحاً درخواست کتاب است
const REQ_MARKERS = mkSet([
  "میخوام", "میخواهم", "میخواستم", "میخوایم", "می‌خوام", "می‌خواهم", "می‌خواستم",
  "دارید", "دارین", "داری", "داره", "داشتید", "داشتین", "داشتی",
  "بفرست", "بفرستید", "بفرستین", "ارسال", "دانلود", "لینک", "لینکش",
  "بذار", "بذارید", "بذارین", "بزار", "بزارید", "بزارین", "پیدا",
  "موجود", "موجوده", "هست", "هستش", "هستین", "هستید", "pdf", "پیدیاف", "نسخه", "فایل",
]);
const BOOK_START = new Set(["کتاب", "رمان", "جزوه", "مقاله", "کتابی"]);

// کلمه‌های گفت‌وگوی معمولی که به‌تنهایی هرگز درخواست کتاب نیستند
const CHATTER = mkSet([
  "سلام", "علیکم", "السلام", "درود", "مرسی", "ممنون", "ممنونم", "سپاس", "سپاسگزارم", "سپاسگذارم",
  "تشکر", "متشکرم", "خداحافظ", "بای", "باشه", "باش", "اوکی", "اوک", "چشم", "حتما", "خوب", "خوبه", "خوبم",
  "عالی", "عالیه", "دستت", "درد", "نکنه", "خسته", "نباشید", "وقت", "بخیر", "صبح", "ظهر", "عصر", "شب",
  "بله", "آره", "نه", "خیر", "لطفا", "خواهش", "تست", "چطوری", "چطورید", "خوبی", "خبر", "نیست", "هست",
  "هستش", "رفیق", "داداش", "عزیز", "جان", "جون", "کسی", "میکنم", "خیلی", "hi", "hello", "hey",
  "thanks", "thank", "you", "ok", "okay", "bye", "good", "great", "nice", "test", "yes", "no", "please",
  "از", "به", "با", "در", "که", "این", "آن", "او", "ما", "شما", "تو", "هم", "بود", "شد", "چی", "همه",
]);

function queryTokens(text) {
  const out = [];
  for (const w of tokens(text)) {
    if (!(w.length > 1 || /^\d$/.test(w))) continue;
    if (QUERY_STOP.has(w)) continue;
    if (/^(\u0645\u06CC|\u0646\u0645\u06CC)\u062E\u0648\u0627/.test(w)) continue; // میخوا… / نمیخوا…
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

// "explicit" = درخواست صریح، "soft" = پیام کوتاه که شاید اسم کتاب باشد، "none" = حرف معمولی
function classify(text) {
  const n = normalizeFa(text);
  const words = n ? n.split(" ") : [];
  if (words.length === 0 || words.length > 40) return "none";
  if (words.every((w) => CHATTER.has(w) || QUERY_STOP.has(w))) return "none";
  if (queryTokens(text).length === 0) return "none";
  if (BOOK_START.has(words[0])) return "explicit";
  if (words.some((w) => REQ_MARKERS.has(w))) return "explicit";
  if (words.length <= 6) return "soft";
  return "none";
}

/* ------------------------------------------------------------------ */
/* امتیازدهی تطابق                                                     */
/* ------------------------------------------------------------------ */
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// وزن تطابق یک کلمه جستجو با کلمه‌های عنوان: ۱ = دقیق، ۰ = بی‌ربط
function tokenWeight(q, tt) {
  let best = 0;
  for (const t of tt) {
    if (t === q) return 1;
    if (q.length >= 3 && t.startsWith(q)) best = Math.max(best, 0.92);
    else if (t.length >= 3 && q.startsWith(t) && q.length - t.length <= 3) best = Math.max(best, 0.85);
    else if (
      q.length >= 4 && t.length >= 4 && Math.abs(q.length - t.length) <= 2 &&
      lev(q, t) <= (q.length >= 8 ? 2 : 1)
    ) best = Math.max(best, 0.7);
  }
  return best;
}

function scoreBook(qt, norm, currentChat, chatId) {
  const tt = norm.split(" ");
  let sum = 0, hits = 0, matchedTitleWords = 0;
  for (const q of qt) {
    const w = tokenWeight(q, tt);
    sum += w;
    if (w > 0) { hits++; matchedTitleWords++; }
  }
  const avg = sum / qt.length;
  const precision = Math.min(1, matchedTitleWords / Math.min(tt.length, 10));
  const bonus = String(chatId) === String(currentChat) ? 0.01 : 0;
  return { hits, avg, score: 0.8 * avg + 0.2 * precision + bonus };
}

/* ------------------------------------------------------------------ */
/* دیتابیس D1                                                          */
/* ------------------------------------------------------------------ */
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  const db = env.DB;
  await db.batch([
    db.prepare(
      "CREATE TABLE IF NOT EXISTS books (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, message_id INTEGER, file_id TEXT, kind TEXT NOT NULL DEFAULT 'pdf', title TEXT NOT NULL, norm TEXT NOT NULL, copy INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)"
    ),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS uq_books_msg ON books(chat_id, message_id)"),
    db.prepare("CREATE VIRTUAL TABLE IF NOT EXISTS books_fts USING fts5(norm, tokenize='unicode61')"),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, text TEXT NOT NULL, user TEXT, user_id TEXT, created INTEGER NOT NULL)"
    ),
    db.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)"),
    db.prepare("CREATE TABLE IF NOT EXISTS seen (id INTEGER PRIMARY KEY, at INTEGER NOT NULL)"), // آپدیت‌های پردازش‌شده — جلوی جواب تکراری
  ]);
  schemaReady = true;
}

async function getMeta(env, k) {
  const r = await env.DB.prepare("SELECT v FROM meta WHERE k = ?1").bind(k).first();
  return r ? r.v : null;
}
async function setMeta(env, k, v) {
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, v).run();
}
async function delMeta(env, k) {
  await env.DB.prepare("DELETE FROM meta WHERE k = ?1").bind(k).run();
}

async function logError(env, e, where) {
  const msg = (where ? where + ": " : "") + (e && e.stack ? e.stack : String(e));
  console.error(msg);
  try {
    if (env.DB) await setMeta(env, "last_error", new Date().toISOString() + "\n" + msg.slice(0, 600));
  } catch (_) { /* نادیده */ }
}

async function isOwnerStrict(env, userId) {
  if (env.ADMIN_USER_ID && String(env.ADMIN_USER_ID).trim()) {
    return String(env.ADMIN_USER_ID).trim() === String(userId);
  }
  const owner = await getMeta(env, "owner");
  return !!owner && String(owner) === String(userId);
}
// فقط در /start خصوصی: اگر هنوز صاحبی ثبت نشده، اولین نفر صاحب می‌شود
async function claimOwnerIfNone(env, userId) {
  if (env.ADMIN_USER_ID && String(env.ADMIN_USER_ID).trim()) {
    return String(env.ADMIN_USER_ID).trim() === String(userId);
  }
  const owner = await getMeta(env, "owner");
  if (!owner) {
    await setMeta(env, "owner", String(userId));
    return true;
  }
  return String(owner) === String(userId);
}

async function isPaused(env) {
  return (await getMeta(env, "paused")) === "1";
}

/* ------------------------------------------------------------------ */
/* تلگرام                                                              */
/* ------------------------------------------------------------------ */
async function tg(env, method, body) {
  const res = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* JSON نبود */ }
  return { status: res.status, data };
}

async function sendMessage(env, chatId, text, replyTo, extra) {
  const body = { chat_id: chatId, text };
  if (replyTo) {
    body.reply_to_message_id = replyTo;
    body.allow_sending_without_reply = true;
  }
  if (extra) Object.assign(body, extra);
  return tg(env, "sendMessage", body);
}

async function sendFileById(env, method, field, chatId, fileId, caption, replyTo) {
  const body = { chat_id: chatId, [field]: fileId };
  if (caption) body.caption = caption;
  if (replyTo) {
    body.reply_to_message_id = replyTo;
    body.allow_sending_without_reply = true;
  }
  return tg(env, method, body);
}
const sendDocument = (env, c, f, cap, r) => sendFileById(env, "sendDocument", "document", c, f, cap, r);
const sendAudio = (env, c, f, cap, r) => sendFileById(env, "sendAudio", "audio", c, f, cap, r);

async function copyMsg(env, toChat, fromChat, messageId, replyTo) {
  const body = { chat_id: toChat, from_chat_id: fromChat, message_id: messageId };
  if (replyTo) {
    body.reply_to_message_id = replyTo;
    body.allow_sending_without_reply = true;
  }
  return tg(env, "copyMessage", body);
}

// ارسال یک کتاب ایندکس‌شده — فقط خود فایل، بدون لینک و بدون نام منبع
async function sendBook(env, toChat, b, replyTo) {
  const caption = "📚 " + String(b.title).slice(0, 900);
  if (b.file_id && !b.copy) {
    const r = b.kind === "audio"
      ? await sendAudio(env, toChat, b.file_id, caption, replyTo)
      : await sendDocument(env, toChat, b.file_id, caption, replyTo);
    if (r.data && r.data.ok) return true;
  }
  if (b.message_id) {
    const r = await copyMsg(env, toChat, b.chat_id, b.message_id, replyTo);
    if (r.data && r.data.ok) return true;
  }
  await sendMessage(
    env, toChat,
    "📚 " + b.title + "\n\nنتوانستم این فایل را بفرستم (ممکن است از آرشیو حذف شده باشد). مدیر گروه باخبر شد.",
    replyTo
  );
  await logError(env, "ارسال ناموفق: " + b.title + " (id " + b.id + ")", "sendBook");
  return false;
}

async function downloadTelegramFile(env, fileId) {
  const r = await tg(env, "getFile", { file_id: fileId });
  const path = r.data && r.data.ok && r.data.result && r.data.result.file_path;
  if (!path) return null;
  const res = await fetch("https://api.telegram.org/file/bot" + env.TELEGRAM_BOT_TOKEN + "/" + path);
  if (!res.ok) return null;
  return await res.text();
}

/* ------------------------------------------------------------------ */
/* ایندکس کردن                                                         */
/* ------------------------------------------------------------------ */
function fileTitleFromMessage(message) {
  const caption = (message.caption || "").trim();
  const doc = message.document || message.audio;
  const fileName = doc && doc.file_name
    ? doc.file_name.replace(/\.(pdf|epub|mobi|mp3|m4a|ogg|opus)$/i, "").replace(/[_-]+/g, " ").trim()
    : "";
  if (caption) {
    return {
      title: caption.split("\n").map((s) => s.trim()).filter(Boolean).join(" ").slice(0, 200),
      extra: fileName, // نام فایل هم در جستجو کمک می‌کند
    };
  }
  return { title: fileName, extra: "" };
}

function isBookFile(message) {
  const doc = message.document;
  if (doc) {
    const name = (doc.file_name || "").toLowerCase();
    const mt = doc.mime_type || "";
    return /\.(pdf|epub|mobi)$/.test(name) || mt.includes("pdf") || mt.includes("epub");
  }
  return !!(message.audio || message.voice);
}

async function upsertBook(env, e) {
  const db = env.DB;
  const now = Date.now();
  const ex = e.message_id
    ? await db.prepare("SELECT id FROM books WHERE chat_id = ?1 AND message_id = ?2").bind(String(e.chat_id), e.message_id).first()
    : null;
  if (ex) {
    await db.batch([
      db.prepare("UPDATE books SET title = ?2, norm = ?3, file_id = ?4, kind = ?5 WHERE id = ?1").bind(ex.id, e.title, e.norm, e.file_id || null, e.kind),
      db.prepare("DELETE FROM books_fts WHERE rowid = ?1").bind(ex.id),
      db.prepare("INSERT INTO books_fts (rowid, norm) VALUES (?1, ?2)").bind(ex.id, e.norm),
    ]);
    return "updated";
  }
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO books (chat_id, message_id, file_id, kind, title, norm, copy, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)")
      .bind(String(e.chat_id), e.message_id || null, e.file_id || null, e.kind, e.title, e.norm, now),
    db.prepare("INSERT OR REPLACE INTO books_fts (rowid, norm) SELECT last_insert_rowid(), ?1 WHERE changes() > 0").bind(e.norm),
  ]);
  return "inserted";
}

async function indexFile(env, chatId, message, titleOverride) {
  const file = message.document || message.audio || message.voice;
  if (!file || !file.file_id) return false;
  const t = fileTitleFromMessage(message);
  const title = (titleOverride || t.title || "").trim();
  if (!title) return false;
  const norm = ftsText(title, titleOverride ? "" : t.extra);
  if (!norm) return false;
  await upsertBook(env, {
    chat_id: chatId, message_id: message.message_id, file_id: file.file_id,
    kind: message.document ? "pdf" : "audio", title, norm,
  });
  return true;
}

async function deleteBook(env, id) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM books_fts WHERE rowid = ?1").bind(id),
    env.DB.prepare("DELETE FROM books WHERE id = ?1").bind(id),
  ]);
}

/* ------------------------------------------------------------------ */
/* جستجو                                                               */
/* ------------------------------------------------------------------ */
const SEARCH_SQL =
  "SELECT b.id, b.chat_id, b.message_id, b.file_id, b.kind, b.title, b.norm, b.copy, bm25(books_fts) AS rank " +
  "FROM books_fts JOIN books b ON b.id = books_fts.rowid WHERE books_fts MATCH ?1 ORDER BY rank LIMIT ?2";

async function ftsQuery(env, expr, limit) {
  try {
    const { results } = await env.DB.prepare(SEARCH_SQL).bind(expr, limit).all();
    return results || [];
  } catch (e) {
    await logError(env, e, "ftsQuery " + expr);
    return [];
  }
}

const prefixTerm = (t) => '"' + t + '"*';

// خروجی: { results: [...], tier: "A"|"B"|"C"|null, qt }
//  A = همه کلمه‌ها (پیشوندی) باید باشند؛ B = بیشتر کلمه‌ها؛ C = تحمل غلط املایی
async function findBooks(env, text, currentChat, strict) {
  const qt = queryTokens(text);
  const empty = { results: [], tier: null, qt };
  if (qt.length === 0) return empty;

  const rank = (rows, minHitFrac, minAvg) => {
    const out = [];
    for (const r of rows) {
      const s = scoreBook(qt, r.norm, currentChat, r.chat_id);
      if (s.hits / qt.length >= minHitFrac && s.avg >= minAvg) out.push({ ...r, ...s });
    }
    out.sort((a, b) => b.score - a.score || a.rank - b.rank);
    return out;
  };

  // A
  let rows = await ftsQuery(env, qt.map(prefixTerm).join(" "), 40);
  let res = rank(rows, 1, strict ? 0.85 : 0.6);
  if (res.length) return { results: res, tier: "A", qt };
  if (strict) return empty;

  // B — بیشتر کلمه‌ها (فقط وقتی چند کلمه است)
  if (qt.length >= 2) {
    rows = await ftsQuery(env, qt.map(prefixTerm).join(" OR "), 60);
    res = rank(rows, 0.6, 0.5);
    if (res.length) return { results: res, tier: "B", qt };
  }

  // C — غلط املایی: پیشوند کوتاه‌شده هر کلمه
  const cut = qt.filter((t) => t.length >= 4).map((t) => prefixTerm(t.slice(0, Math.max(3, t.length - 2))));
  if (cut.length) {
    rows = await ftsQuery(env, cut.join(" OR "), 60);
    res = rank(rows, qt.length >= 2 ? 0.6 : 1, 0.5);
    if (res.length) return { results: res, tier: "C", qt };
  }
  return empty;
}

async function replyWithResults(env, chatId, found, replyTo) {
  const { results, tier } = found;
  const top = results[0];
  const near = results.filter((r) => r.score >= top.score - 0.08);
  const seen = new Set();
  const distinct = [];
  for (const r of near) {
    if (!seen.has(r.norm)) { seen.add(r.norm); distinct.push(r); }
  }
  if (tier === "A" && distinct.length === 1) {
    await sendBook(env, chatId, top, replyTo);
    return;
  }
  const list = (tier === "A" ? distinct : results.filter((r, i, a) => a.findIndex((x) => x.norm === r.norm) === i)).slice(0, MAX_BUTTONS);
  const keyboard = list.map((r) => [{ text: String(r.title).slice(0, 60), callback_data: "bk:" + r.id }]);
  await sendMessage(
    env, chatId,
    tier === "A" ? "چند مورد نزدیک پیدا کردم. کدام را می‌خواهید؟" : "دقیقاً همین را پیدا نکردم؛ شاید منظورتان یکی از این‌هاست؟",
    replyTo,
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

/* ------------------------------------------------------------------ */
/* نسخه رایگان قانونی — Internet Archive و Open Library                */
/* ------------------------------------------------------------------ */
const asStr = (v) => String(Array.isArray(v) ? v[0] : v || "");

function relevantTitle(title, qt) {
  const tt = tokens(title);
  if (!tt.length) return false;
  let hits = 0;
  for (const q of qt) if (tokenWeight(q, tt) >= 0.85) hits++;
  return hits / qt.length >= 0.8;
}

async function iaSearch(qt, mediaType) {
  const q = "title:(" + qt.join(" AND ") + ") AND mediatype:" + mediaType;
  const url = "https://archive.org/advancedsearch.php?q=" + encodeURIComponent(q) +
    "&fl[]=identifier&fl[]=title&rows=5&output=json";
  const res = await fetch(url, { signal: AbortSignal.timeout(IA_TIMEOUT_MS) });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  const docs = (data && data.response && data.response.docs) || [];
  return docs.filter((d) => d.identifier).map((d) => ({ identifier: d.identifier, title: asStr(d.title) }));
}

async function olSearch(qt) {
  const url = "https://openlibrary.org/search.json?q=" + encodeURIComponent(qt.join(" ")) + "&has_fulltext=true&limit=5";
  const res = await fetch(url, { signal: AbortSignal.timeout(IA_TIMEOUT_MS) });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  const out = [];
  for (const d of (data && data.docs) || []) {
    for (const id of Array.isArray(d.ia) ? d.ia.slice(0, 2) : []) out.push({ identifier: id, title: asStr(d.title) });
  }
  return out;
}

async function iaMetadata(identifier) {
  const res = await fetch("https://archive.org/metadata/" + encodeURIComponent(identifier), { signal: AbortSignal.timeout(IA_TIMEOUT_MS) });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

function iaPickFile(meta, isAudio) {
  if (!meta || !Array.isArray(meta.files)) return null;
  const files = meta.files;
  if (isAudio) return files.find((f) => /\.mp3$/i.test(f.name || "")) || null;
  const id = (meta.metadata && meta.metadata.identifier) || "";
  return (
    files.find((f) => (f.name || "").toLowerCase() === id.toLowerCase() + ".pdf") ||
    files.find((f) => /_text\.pdf$/i.test(f.name || "")) ||
    files.find((f) => /\.pdf$/i.test(f.name || "")) || null
  );
}

const iaUrl = (id, name) => "https://archive.org/download/" + encodeURIComponent(id) + "/" + encodeURIComponent(name);

async function firstUsable(cands, qt, isAudio) {
  let tries = 0;
  for (const c of cands) {
    if (!relevantTitle(c.title, qt)) continue; // نتیجه بی‌ربط را هرگز نمی‌فرستیم
    if (++tries > 3) break;
    const f = iaPickFile(await iaMetadata(c.identifier), isAudio);
    if (f) return { title: c.title, url: iaUrl(c.identifier, f.name) };
  }
  return null;
}

async function searchFreeCopy(qt, rawText) {
  const wantAudio = /صوتی/.test(rawText);
  const out = {};
  try {
    if (!wantAudio) {
      let hit = await firstUsable(await iaSearch(qt, "texts"), qt, false);
      if (!hit) hit = await firstUsable(await olSearch(qt), qt, false);
      if (hit) { out.title = hit.title; out.pdfUrl = hit.url; }
    }
    if (wantAudio || !out.pdfUrl) {
      const hit = await firstUsable(await iaSearch(qt, "audio"), qt, true);
      if (hit) { out.audioTitle = hit.title; out.audioUrl = hit.url; if (!out.title) out.title = hit.title; }
    }
  } catch (e) { /* شبکه/زمان‌بندی؛ «پیدا نشد» می‌شود */ }
  return out.pdfUrl || out.audioUrl ? out : null;
}

/* ------------------------------------------------------------------ */
/* پردازش درخواست کاربر                                                */
/* ------------------------------------------------------------------ */
async function addRequest(env, chatId, text, from) {
  await env.DB.prepare("INSERT INTO requests (chat_id, text, user, user_id, created) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(String(chatId), text.slice(0, 300), from ? (from.first_name || String(from.id)) : "", from ? String(from.id) : "", Date.now()).run();
}

// mode: "explicit" | "soft"
async function handleRequest(env, { chatId, text, replyTo, from, mode }) {
  const found = await findBooks(env, text, chatId, mode === "soft");
  if (found.results.length) {
    await replyWithResults(env, chatId, found, replyTo);
    return;
  }
  if (mode === "soft") return; // پیام احتمالی؛ اگر پیدا نشد سکوت
  const qt = found.qt;
  if (!qt.length) return;

  const free = await searchFreeCopy(qt, text);
  if (!free) {
    await sendMessage(env, chatId, "😕 «" + qt.join(" ") + "» پیدا نشد.\nدرخواستت ثبت شد تا مدیر گروه ببیند.", replyTo);
    await addRequest(env, chatId, text, from);
    return;
  }
  let sent = false;
  if (free.pdfUrl) {
    const r = await sendDocument(env, chatId, free.pdfUrl, "📕 " + free.title, replyTo);
    if (r.data && r.data.ok) sent = true;
  }
  if (free.audioUrl) {
    const r = await sendAudio(env, chatId, free.audioUrl, "🎧 " + (free.audioTitle || free.title), replyTo);
    if (r.data && r.data.ok) sent = true;
  }
  if (!sent) {
    const lines = ["✅ نسخه رایگان پیدا شد:", "📕 " + free.title];
    if (free.pdfUrl) lines.push("PDF: " + free.pdfUrl);
    if (free.audioUrl) lines.push("🎧 صوتی: " + free.audioUrl);
    lines.push("فایل بزرگ است، پس لینک دانلود را فرستادم.");
    await sendMessage(env, chatId, lines.join("\n"), replyTo);
  }
}

async function handleCallback(env, cb) {
  const data = cb.data || "";
  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
  if (!data.startsWith("bk:") || !cb.message) return;
  const id = parseInt(data.slice(3), 10);
  if (!id) return;
  const b = await env.DB.prepare("SELECT id, chat_id, message_id, file_id, kind, title, copy FROM books WHERE id = ?1").bind(id).first();
  if (!b) return;
  const replyTo = cb.message.reply_to_message ? cb.message.reply_to_message.message_id : undefined;
  await sendBook(env, cb.message.chat.id, b, replyTo);
}

/* ------------------------------------------------------------------ */
/* ایمپورت ایندکس قدیمی (تکه‌تکه)                                      */
/* ------------------------------------------------------------------ */
function extractItems(data) {
  let items = null;
  if (Array.isArray(data)) items = data;
  else if (data && typeof data === "object") items = data.books || data.entries || null;
  if (!Array.isArray(items)) return null;
  return { items, topChatId: data && !Array.isArray(data) ? data.chat_id : undefined };
}

// یک مرحله از ایمپورت را انجام می‌دهد. برمی‌گرداند { status, job, ... }
async function runImportSlice(env) {
  await ensureSchema(env);
  const raw = await getMeta(env, "job");
  if (!raw) return { status: "none" };
  const job = JSON.parse(raw);

  const content = await downloadTelegramFile(env, job.file_id);
  let parsed = null;
  if (content !== null) { try { parsed = extractItems(JSON.parse(content)); } catch (e) { parsed = null; } }
  if (!parsed) {
    job.fails = (job.fails || 0) + 1;
    if (job.fails >= 5) {
      await delMeta(env, "job");
      await sendMessage(env, job.chat, "⚠️ ایمپورت متوقف شد (فایل JSON خوانده نشد). دوباره فایل را بفرست.");
      return { status: "failed", job };
    }
    await setMeta(env, "job", JSON.stringify(job));
    return { status: "retry", job };
  }

  const { items, topChatId } = parsed;
  job.total = items.length;
  const slice = items.slice(job.offset, job.offset + IMPORT_SLICE);
  const rows = [];
  for (const it of slice) {
    if (!it || typeof it !== "object") { job.invalid++; continue; }
    const title = String(it.title || "").trim().slice(0, 200);
    const mid = parseInt(it.message_id, 10);
    const rawChat = it.chat_id !== undefined && it.chat_id !== null ? it.chat_id : topChatId;
    const norm = ftsText(title);
    if (!title || !mid || mid <= 0 || rawChat === undefined || rawChat === null || !norm) { job.invalid++; continue; }
    rows.push({ chat: String(rawChat), mid, kind: it.kind === "audio" ? "audio" : "pdf", title, norm });
  }

  if (rows.length) {
    const db = env.DB;
    const now = Date.now();
    const before = await db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM books").first();
    const stmts = [];
    const PER = 19; // ۵ پارامتر × ۱۹ = ۹۵ (سقف D1: ۱۰۰)
    for (let i = 0; i < rows.length; i += PER) {
      const part = rows.slice(i, i + PER);
      const ph = part.map(() => "(?,?,?,?,?,1," + now + ")").join(",");
      stmts.push(
        db.prepare("INSERT OR IGNORE INTO books (chat_id, message_id, kind, title, norm, copy, created) VALUES " + ph)
          .bind(...part.flatMap((r) => [r.chat, r.mid, r.kind, r.title, r.norm]))
      );
    }
    stmts.push(db.prepare("INSERT OR REPLACE INTO books_fts (rowid, norm) SELECT id, norm FROM books WHERE id > ?1").bind(before.m));
    const res = await db.batch(stmts);
    let added = 0;
    for (let i = 0; i < stmts.length - 1; i++) added += (res[i].meta && res[i].meta.changes) || 0;
    job.imported += added;
    job.skipped += rows.length - added;
  }
  job.offset += slice.length;

  if (job.offset >= items.length) {
    await delMeta(env, "job");
    await sendMessage(
      env, job.chat,
      "✅ ایمپورت تمام شد:\n• " + job.imported + " کتاب جدید\n• " + job.skipped + " تکراری (رد شد)\n• " + job.invalid + " مورد خراب\nبا /stats تعداد را ببین."
    );
    return { status: "done", job };
  }
  await setMeta(env, "job", JSON.stringify(job));
  return { status: "progress", job };
}

/* ------------------------------------------------------------------ */
/* متن‌ها                                                              */
/* ------------------------------------------------------------------ */
function startText() {
  return (
    "📚 ربات درخواست کتاب — نسخه " + VERSION + "\n\n" +
    "کاربران فقط اسم کتاب را می‌نویسند؛ هیچ دستوری لازم نیست.\n\n" +
    "دستورهای مدیر:\n" +
    "/add <عنوان> — روی پیام فایل ریپلای کن تا ایندکس شود\n" +
    "/del — روی فایل ریپلای کن، یا /del <عنوان>\n" +
    "/requests — درخواست‌های پیدا‌نشده\n" +
    "/stats — آمار ایندکس\n" +
    "/status — وضعیت، آخرین خطا، پیشرفت ایمپورت\n" +
    "/import — راهنمای وارد کردن آرشیو قدیمی (فایل JSON را در خصوصی بفرست)\n" +
    "/continue — ادامه ایمپورت\n" +
    "/get <message_id> — تست کپی پیام قدیمی\n" +
    "/off و /on — خاموش/روشن"
  );
}

/* ------------------------------------------------------------------ */
/* پردازش آپدیت                                                        */
/* ------------------------------------------------------------------ */
async function handleUpdate(update, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.DB) {
    console.error("TELEGRAM_BOT_TOKEN یا DB تنظیم نشده است");
    return;
  }
  await ensureSchema(env);

  // جلوگیری از پردازش تکراری آپدیت — تلگرام گاهی یک آپدیت را دو بار می‌فرستد
  if (update.update_id !== undefined) {
    const dup = await env.DB.prepare("SELECT id FROM seen WHERE id = ?1").bind(update.update_id).first();
    if (dup) return;
    await env.DB.prepare("INSERT OR IGNORE INTO seen (id, at) VALUES (?1, ?2)").bind(update.update_id, Date.now()).run();
    // گاهی ردیف‌های قدیمی را پاک کن تا جدول بی‌نهایت بزرگ نشود
    if (update.update_id % 50 === 0) {
      await env.DB.prepare("DELETE FROM seen WHERE at < ?1").bind(Date.now() - 3600 * 1000).run();
    }
  }

  // /on و /off همیشه کار می‌کنند
  const _msg = update.message;
  if (_msg && typeof _msg.text === "string" && !(_msg.from || {}).is_bot) {
    const c = _msg.text.trim().split(/\s+/)[0].replace(/@.*$/, "").toLowerCase();
    if (c === "/on" || c === "/off") {
      if (!(await isOwnerStrict(env, (_msg.from || {}).id))) return;
      await setMeta(env, "paused", c === "/off" ? "1" : "0");
      await sendMessage(env, _msg.chat.id, c === "/on" ? "✅ ربات روشن شد." : "💤 ربات خاموش شد. برای روشن کردن /on را بفرست.", _msg.message_id);
      return;
    }
  }
  if (await isPaused(env)) return;

  if (update.callback_query) {
    await handleCallback(env, update.callback_query);
    return;
  }

  // پست چنل: فقط ایندکس
  if (update.channel_post) {
    const post = update.channel_post;
    if (post && isBookFile(post)) await indexFile(env, post.chat.id, post);
    return;
  }

  const message = update.message;
  if (!message) return;
  const chat = message.chat || {};
  const from = message.from || {};
  if (from.is_bot) return;
  const chatId = chat.id;
  const isGroup = chat.type === "group" || chat.type === "supergroup";
  const text = typeof message.text === "string" ? message.text : "";

  // فایل کتاب در گروه → ایندکس بی‌صدا
  if (isGroup && isBookFile(message)) {
    await indexFile(env, chatId, message);
    return;
  }

  // فایل JSON ایندکس قدیمی — فقط خصوصی و فقط صاحب بات
  if (!isGroup && message.document) {
    const doc = message.document;
    if ((doc.file_name || "").toLowerCase().endsWith(".json")) {
      if (!(await isOwnerStrict(env, from.id))) {
        await sendMessage(env, chatId, "⛔ فقط صاحب بات می‌تواند ایندکس وارد کند.");
        return;
      }
      if (await getMeta(env, "job")) {
        await sendMessage(env, chatId, "یک ایمپورت هنوز در جریان است. با /status ببین و با /continue ادامه بده؛ بعد از تمام شدن فایل بعدی را بفرست.");
        return;
      }
      await setMeta(env, "job", JSON.stringify({ file_id: doc.file_id, offset: 0, imported: 0, skipped: 0, invalid: 0, total: null, chat: chatId, fails: 0 }));
      const r = await runImportSlice(env);
      if (r.status === "progress") {
        await sendMessage(env, chatId, "⏳ ایمپورت شروع شد: " + r.job.offset + " از " + r.job.total + ".\nبقیه با Cron هر دقیقه پیش می‌رود؛ اگر Cron نگذاشته‌ای، چند بار /continue بفرست.");
      }
      return;
    }
    return;
  }

  if (!text) return;

  // دستورها
  if (text.startsWith("/")) {
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].replace(/@.*$/, "").toLowerCase();
    const arg = parts.slice(1).join(" ").trim();
    const owner = () => isOwnerStrict(env, from.id);
    const deny = () => sendMessage(env, chatId, "⛔ این دستور فقط برای مدیر بات است.", message.message_id);

    if (cmd === "/start" || cmd === "/help") {
      const ok = isGroup ? await owner() : await claimOwnerIfNone(env, from.id);
      if (ok) await sendMessage(env, chatId, startText());
      return;
    }

    if (cmd === "/book" || cmd === "/کتاب" || cmd === "/find") {
      if (!arg) {
        await sendMessage(env, chatId, "نام کتاب را هم بنویس. مثال:\n/book تاریخ ایران", message.message_id);
        return;
      }
      await handleRequest(env, { chatId, text: arg, replyTo: message.message_id, from, mode: "explicit" });
      return;
    }

    if (cmd === "/add" || cmd === "/index") {
      if (!(await owner())) return deny();
      const replied = message.reply_to_message;
      if (!replied || !isBookFile(replied)) {
        await sendMessage(env, chatId, "روی پیام فایل کتاب ریپلای بزن و بعد /add <عنوان> را بفرست.", message.message_id);
        return;
      }
      const ok = await indexFile(env, chatId, replied, arg || undefined);
      await sendMessage(env, chatId, ok ? "✅ به ایندکس اضافه شد." : "⚠️ نتوانستم این پیام را ایندکس کنم (عنوان یا فایل ندارد).", message.message_id);
      return;
    }

    if (cmd === "/del" || cmd === "/delete" || cmd === "/remove") {
      if (!(await owner())) return deny();
      const replied = message.reply_to_message;
      let target = null;
      if (replied) {
        target = await env.DB.prepare("SELECT id, title FROM books WHERE chat_id = ?1 AND message_id = ?2").bind(String(chatId), replied.message_id).first();
      } else if (arg) {
        const f = await findBooks(env, arg, chatId, false);
        const distinct = f.results.filter((r, i, a) => a.findIndex((x) => x.norm === r.norm) === i);
        if (distinct.length > 1 && distinct[0].score - distinct[1].score < 0.08) {
          await sendMessage(env, chatId, "چند مورد نزدیک پیدا شد؛ عنوان دقیق‌تر بنویس:\n" + distinct.slice(0, 5).map((r) => "• " + r.title).join("\n"), message.message_id);
          return;
        }
        if (distinct.length) target = distinct[0];
      }
      if (!target) {
        await sendMessage(env, chatId, "⚠️ چیزی برای حذف پیدا نشد. روی پیام فایل ریپلای بزن یا /del <عنوان> بنویس.", message.message_id);
        return;
      }
      await deleteBook(env, target.id);
      await sendMessage(env, chatId, "🗑 «" + target.title + "» از ایندکس حذف شد.", message.message_id);
      return;
    }

    if (cmd === "/get" || cmd === "/copy") {
      if (!(await owner())) return deny();
      const mid = parseInt(arg, 10);
      if (!mid || mid <= 0) {
        await sendMessage(env, chatId, "آیدی پیام را هم بنویس. مثال:\n/get 721311", message.message_id);
        return;
      }
      let fromChat = String(chatId);
      if (!isGroup) {
        const c = await env.DB.prepare("SELECT chat_id FROM books ORDER BY id LIMIT 1").first();
        if (!c) { await sendMessage(env, chatId, "هنوز گروهی را نمی‌شناسم.", message.message_id); return; }
        fromChat = c.chat_id;
      }
      const r = await copyMsg(env, chatId, fromChat, mid);
      await sendMessage(
        env, chatId,
        r.data && r.data.ok ? "✅ کپی شد — پیام " + mid + " را می‌توانم بفرستم." : "⚠️ کپی نشد (پیام " + mid + "): " + ((r.data && r.data.description) || "خطای HTTP " + r.status),
        message.message_id
      );
      return;
    }

    if (cmd === "/import") {
      if (!(await owner())) return deny();
      await sendMessage(
        env, chatId,
        isGroup
          ? "فایل JSON ایندکس را در چت خصوصی بات بفرست، نه در گروه."
          : "📥 فایل JSON ساخته‌شده با اسکریپت (book-index-*.json) را همین‌جا بفرست.\nقالب هر مورد: {\"title\": \"نام کتاب\", \"message_id\": 123, \"chat_id\": -100...}\nایمپورت تکه‌تکه (هر مرحله ۶۰ کتاب) انجام می‌شود: با Cron هر دقیقه یا با /continue.\nتکراری‌ها خودکار رد می‌شوند، پس می‌شود چند بار فرستاد.",
        message.message_id
      );
      return;
    }

    if (cmd === "/continue") {
      if (!(await owner())) return deny();
      const r = await runImportSlice(env);
      if (r.status === "none") await sendMessage(env, chatId, "ایمپورتی در جریان نیست.");
      else if (r.status === "progress") await sendMessage(env, chatId, "⏳ " + r.job.offset + " از " + r.job.total + " — دوباره /continue بفرست (یا Cron ادامه می‌دهد).");
      else if (r.status === "retry") await sendMessage(env, chatId, "⚠️ فایل خوانده نشد؛ دوباره /continue بفرست.");
      return;
    }

    if (cmd === "/requests") {
      if (!(await owner())) return deny();
      const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM requests").first();
      const { results } = await env.DB.prepare("SELECT text, user FROM requests ORDER BY id DESC LIMIT 20").all();
      if (!results || !results.length) { await sendMessage(env, chatId, "📭 درخواستی ثبت نشده است."); return; }
      const lines = ["📋 درخواست‌های پیدا‌نشده (" + total.n + " مورد — ۲۰ تای آخر):"];
      results.forEach((r, i) => lines.push((i + 1) + ". «" + r.text + "» — " + (r.user || "?")));
      await sendMessage(env, chatId, lines.join("\n"));
      return;
    }

    if (cmd === "/stats") {
      if (!(await owner())) return;
      const t = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(kind='pdf'),0) AS pdf, COALESCE(SUM(kind='audio'),0) AS audio, COALESCE(SUM(copy),0) AS cp FROM books").first();
      const h = await env.DB.prepare("SELECT COUNT(*) AS n FROM books WHERE chat_id = ?1").bind(String(chatId)).first();
      await sendMessage(
        env, chatId,
        "📊 کتاب‌های ایندکس‌شده:\n• این چت: " + h.n + "\n• همه منابع: " + t.n + " (📕 " + t.pdf + " ، 🎧 " + t.audio + ")\n• آرشیو قدیمی (کپی): " + t.cp
      );
      return;
    }

    if (cmd === "/status") {
      if (!(await owner())) return;
      const err = await getMeta(env, "last_error");
      const job = await getMeta(env, "job");
      const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM books").first();
      const rq = await env.DB.prepare("SELECT COUNT(*) AS n FROM requests").first();
      let jobLine = "ایمپورت: ندارد";
      if (job) { const j = JSON.parse(job); jobLine = "ایمپورت: " + j.offset + " از " + (j.total || "?"); }
      await sendMessage(env, chatId, "نسخه " + VERSION + "\nکتاب‌ها: " + n.n + "\nدرخواست‌های پیدا‌نشده: " + rq.n + "\n" + jobLine + "\nآخرین خطا: " + (err || "—"));
      return;
    }
    return;
  }

  // پیام متنی عادی
  if (isGroup) {
    const mode = classify(text);
    if (mode === "none") return;
    await handleRequest(env, { chatId, text, replyTo: message.message_id, from, mode });
    return;
  }
  // خصوصی: هر پیام غیرمعمولی یک درخواست است
  if (classify(text) === "none") return;
  await handleRequest(env, { chatId, text, replyTo: message.message_id, from, mode: "explicit" });
}

/* ------------------------------------------------------------------ */
/* نقطه ورود                                                           */
/* ------------------------------------------------------------------ */
export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response(
        "📚 ربات درخواست کتاب — Worker فعال است (نسخه " + VERSION + ")." + (env.DB ? "" : "\n⚠️ دیتابیس DB وصل نشده است."),
        { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }
    let update = null;
    try { update = await request.json(); } catch (e) { return new Response("OK", { status: 200 }); }
    if (!update || typeof update !== "object") return new Response("OK", { status: 200 });
    ctx.waitUntil(handleUpdate(update, env).catch((e) => logError(env, e, "handleUpdate")));
    return new Response("OK", { status: 200 });
  },

  // Cron Trigger (هر دقیقه): فقط اگر ایمپورتی در جریان باشد یک مرحله جلو می‌برد
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return;
        await ensureSchema(env);
        await env.DB.prepare("DELETE FROM seen WHERE at < ?1").bind(Date.now() - 3600 * 1000).run();
        if (await getMeta(env, "job")) await runImportSlice(env);
      })().catch((e) => logError(env, e, "scheduled"))
    );
  },
};
