/**
 * ربات مدیریت درخواست کتاب — نسخه Cloudflare Worker (وبهوک)
 * برای گروه تلگرامی «درخواست کتاب شیفتگان»
 *
 * چه کار می‌کند:
 *  ۱) هر فایل PDF یا صوتی که در گروه فرستاده شود را ایندکس می‌کند
 *     (عنوان را از کپشن یا نام فایل می‌خواند).
 *  ۲) کاربر در پیام عادی اسم کتاب را بنویسد — بدون هیچ دستوری —
 *     اگر کتاب موجود باشد، بات همان فایل را در جواب (ریپلای) همان پیام
 *     می‌فرستد. جستجو با پیام عادی است؛ هیچ دستوری لازم نیست.
 *  ۳) اگر در گروه خودت نبود، آرشیو گروه‌ها و چنل‌های دیگری که بات در
 *     آن‌ها عضو است را هم می‌گردد و از همان‌جا فایل را می‌فرستد —
 *     بدون اینکه بگوید از کجا آمده است.
 *  ۴) اگر هیچ‌جا نبود، در آرشیوهای رایگان (Internet Archive و Open Library)
 *     دنبال نسخه قانونی رایگان (PDF یا صوتی) می‌گردد.
 *  ۵) اگر هیچ‌جا پیدا نشد، درخواست را ثبت می‌کند تا مدیر ببیند (/requests).
 *
 * قوانین این نسخه (به خواست صاحب بات):
 *  - تعداد پاسخ نامحدود است: به هر درخواستی جواب می‌دهد؛ درخواست‌های
 *    ثبت‌شده هم سقف ندارند.
 *  - حجم فایل از طرف بات سقفی ندارد: بات همیشه اول خود فایل را می‌فرستد و
 *    هرگز لینک نمی‌فرستد؛ فقط اگر خود تلگرام قبول نکرد (ربات‌های تلگرام
 *    حداکثر ۵۰ مگابایت می‌توانند بفرستند) می‌گوید فایل خیلی بزرگ است.
 *    این سقف خود تلگرام است و هیچ باتی نمی‌تواند بیشتر کند.
 *  - دستورهای مدیریتی فقط از صاحب بات اجرا می‌شود (/add ،/del ،/requests ،/stats).
 *    بقیه کاربرها فقط پیام عادی می‌نویسند و جواب می‌گیرند.
 *  - بات تحت هیچ شرایطی پیام حذف نمی‌کند؛ اصلاً چنین کدی در آن نیست.
 *  - منبعی درج نمی‌شود: وقتی فایل از گروه یا چنل دیگری می‌آید، بات
 *    نمی‌گوید از کجا آمده است.
 *
 * ⚠️ دو محدودیت صادقانه:
 *  - بات فقط فایل‌هایی را می‌بیند که «بعد از اضافه شدنش» در گروه یا چنل
 *    فرستاده شوند. برای کتاب‌های قدیمی: فایل را به گروه فوروارد کن یا
 *    روی پیامش ریپلای بزن و /add را بفرست.
 *  - برای اینکه بات آرشیو گروه یا چنل دیگری را بشناسد، باید در آن گروه
 *    یا چنل هم عضو (بهتر است ادمین) باشد؛ بات نمی‌تواند سر خود وارد
 *    گروه یا چنل دیگری شود و پیام‌های قبلی‌شان را بخواند. برای چنل‌ها
 *    حتماً باید ادمین باشد.
 *  - بیشتر کتاب‌های فارسی مدرن نسخه قانونی رایگان ندارند؛ برای آن‌ها
 *    بات «پیدا نشد» می‌گوید و درخواست را ثبت می‌کند. بات فایل غیرقانونی
 *    دانلود و ارسال نمی‌کند.
 *
 * استقرار از مرورگر گوشی (بدون کامپیوتر و بدون ترمینال):
 *  ۱) حساب رایگان Cloudflare: https://dash.cloudflare.com/sign-up (فقط ایمیل)
 *  ۲) یک ربات جدید در @BotFather بسازید (با ربات هوش مصنوعی فرق دارد) و
 *     توکنش را بگیرید. در @BotFather برای این ربات Group Privacy را
 *     خاموش کنید (/setprivacy → Disable).
 *  ۳) Workers & Pages → Create Worker → کد این فایل را بچسبانید → Deploy
 *  ۴) Settings → Variables → Secret بگذارید: TELEGRAM_BOT_TOKEN
 *     (اختیاری: ADMIN_USER_ID با آیدی عددی تلگرام شما)
 *  ۵) Storage → KV یک Namespace جدا بسازید و با نام BOT_STATE به Worker
 *     وصل کنید (در Settings → Variables → KV Namespace Bindings).
 *     هر ربات باید KV جدای خودش را داشته باشد.
 *  ۶) بات را در گروه خودتان و در هر گروه یا چنل منبع دیگری ادمین کنید.
 *  ۷) وب‌هوک را با باز کردن این آدرس در مرورگر فعال کنید:
 *     https://api.telegram.org/botTOKEN/setWebhook?url=https://WORKER.workers.dev
 */

const IA_TIMEOUT_MS = 12000;

/* ------------------------------------------------------------------ */
/* نرمال‌سازی فارسی برای تطابق عنوان                                   */
/* ------------------------------------------------------------------ */
function normalizeFa(text) {
  return (text || "")
    .replace(/[ي]/g, "ی")
    .replace(/[ك]/g, "ک")
    .replace(/[ة]/g, "ه")
    .replace(/[ؤ]/g, "و")
    .replace(/[أإآ]/g, "ا")
    .replace(/[ً-ٰٖـ]/g, "") // اعراب و کشیدگی
    .replace(/‌/g, "") // نیم‌فاصله را حذف کن تا «می‌خوام» = «میخوام»
    .replace(/[«»"“”'']/g, " ")
    .replace(/[^0-9a-zA-Z\u0600-\u06FF\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const STOPWORDS = new Set([
  "کتاب", "لطفا", "لطفاً", "لطف", "میخوام", "میخواهم", "می‌خوام", "دارید",
  "داری", "دارین", "هست", "هستش", "دانلود", "نسخه", "صوتی", "pdf", "فایل",
  "بفرستید", "بفرست", "بفرستین", "ممنون", "سلام", "کسی", "اگه", "اگر",
  "رو", "را", "برای", "من", "میخواستم", "لینکش", "لینک", "چیه", "چیست",
  "چه", "خبر", "خوبی", "خوبم", "چطوری", "مرسی", "داداش", "رفیق",
]);

function queryWords(text) {
  return normalizeFa(text)
    .split(" ")
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

// کلمه‌های گفت‌وگوی معمولی که هرگز درخواست کتاب نیستند
// (مثلاً «سپاسگزارم»، «سلام»، «باشه»)
const CHATTER_WORDS = new Set([
  "سلام", "علیکم", "السلام", "مرسی", "ممنون", "ممنونم", "سپاس", "سپاسگزارم",
  "سپاسگذارم", "سپاسگزار", "تشکر", "متشکرم", "خداحافظ", "خداحافظی", "بای",
  "باشه", "باش", "اوکی", "اوک", "چشم", "حتما", "خوب", "خوبه", "خوبم", "عالی",
  "عالیه", "دستت", "درد", "نکنه", "خسته", "نباشید", "وقت", "بخیر",
  "صبح", "ظهر", "عصر", "شب", "بله", "آره", "نه", "خیر", "لطفا", "خواهش",
  "تست", "چطوری", "چطورید", "خوبی", "خبر", "نیست", "هست", "هستش", "رفیق",
  "داداش", "عزیز", "جان", "جون", "کسی", "میکنم", "می‌کنم", "خیلی",
  "hi", "hello", "hey", "thanks", "thank", "you", "ok", "okay", "bye",
  "good", "great", "nice", "test", "testing", "yes", "no", "please", "welcome",
]);

// کلمه‌های غیرمحتوایی: گفت‌وگوی معمولی + کلمه‌های ربط و فعل‌های رایج
// پیام فقط وقتی درخواست کتاب است که دست‌کم یک کلمه محتوایی داشته باشد.
const FUNCTION_WORDS = new Set([
  "از", "به", "با", "در", "که", "این", "آن", "او", "ما", "شما", "ایشان",
  "تو", "هم", "بود", "شد", "شدم", "کن", "کنید", "بکن", "بکنید", "بده",
  "بدید", "دوستان", "دوست", "لطفت", "لطفتون", "بابت", "همه", "چی",
  "فرستاد", "فرستادی", "فرستادید", "فرستادم", "فرستادن", "فرستاده",
  "فرستادین", "فرستادیم", "میکنه", "می‌کنه", "کرد", "کردم", "میکنی",
  "میشه", "بگو", "بگید", "بگین", "بفرمایید", "بفرمائید",
]);
const NON_CONTENT = new Set([...STOPWORDS, ...CHATTER_WORDS, ...FUNCTION_WORDS]);

// آیا پیام دست‌کم یک کلمه محتوایی (نام کتاب و...) دارد؟
function hasContentWords(text) {
  return normalizeFa(text)
    .split(" ")
    .some((w) => w.length > 1 && !NON_CONTENT.has(w));
}

// آیا پیام فقط حرف معمولی است و درخواست کتاب نیست؟ (در این صورت سکوت کامل)
function isChatter(text) {
  const n = normalizeFa(text);
  if (!n) return true; // فقط ایموجی یا علامت
  if (/^[0-9\s]+$/.test(n)) return true; // فقط عدد
  return !hasContentWords(text);
}

// نمره تطابق عنوان با پیام (۰ تا ۱)؛ فقط وقتی کافی است برمی‌گرداند
function titleMatchScore(titleNorm, msgNorm) {
  const tWords = titleNorm.split(" ").filter((w) => w.length > 1);
  const mWords = msgNorm.split(" ").filter((w) => w.length > 1);
  if (tWords.length === 0 || mWords.length === 0) return 0;
  if (msgNorm.includes(titleNorm)) return 1;
  const mSet = new Set(mWords);
  const tSet = new Set(tWords);
  let hitT = 0;
  for (const w of tWords) if (mSet.has(w)) hitT++;
  let hitM = 0;
  for (const w of mWords) if (tSet.has(w)) hitM++;
  const scoreT = hitT / tWords.length;
  const scoreM = hitM / mWords.length;
  // همه کلمه‌های پیام در عنوان باشد (مثلاً «تاوان» برای «تاوان مکایون»)
  if (scoreM === 1) return 0.95;
  if (tWords.length === 1) return hitT === 1 ? 1 : 0;
  return scoreT >= 0.8 && hitT >= 2 ? scoreT : 0;
}

// آیا پیام شبیه درخواست کتاب است؟ (برای جستجوی وب وقتی در آرشیو نبود)
function looksLikeRequest(text) {
  const n = normalizeFa(text);
  return (
    n.startsWith("کتاب ") ||
    n.includes(" میخوام") ||
    n.includes(" میخواهم") ||
    n.includes(" دارید") ||
    n.includes(" دانلود") ||
    n.includes(" لطفا") ||
    n.includes("لطفا ")
  );
}

/* ------------------------------------------------------------------ */
/* ذخیره وضعیت (KV)                                                    */
/* ------------------------------------------------------------------ */
const memFallback = new Map();
function kv(env) {
  return env.BOT_STATE || null;
}
async function sGet(env, key) {
  const store = kv(env);
  if (store) return await store.get(key);
  const v = memFallback.get(key);
  return v === undefined ? null : v;
}
async function sPut(env, key, value, opts) {
  const store = kv(env);
  if (store) await store.put(key, value, opts || {});
  else memFallback.set(key, value);
}

async function getIndex(env, chatId) {
  const raw = await sGet(env, "index:" + chatId);
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    } catch (e) {
      /* خراب است؛ از اول ساخته می‌شود */
    }
  }
  return [];
}
async function saveIndex(env, chatId, arr) {
  await sPut(env, "index:" + chatId, JSON.stringify(arr));
}
// همه چت‌هایی (گروه و چنل) که بات در آن‌ها فایل دیده است
async function markChatKnown(env, chatId) {
  const raw = await sGet(env, "chats");
  let ids = [];
  if (raw) {
    try {
      ids = JSON.parse(raw) || [];
    } catch (e) {
      ids = [];
    }
  }
  if (!ids.includes(String(chatId))) {
    ids.push(String(chatId));
    await sPut(env, "chats", JSON.stringify(ids));
  }
}
async function getKnownChats(env) {
  const raw = await sGet(env, "chats");
  if (!raw) return [];
  try {
    return JSON.parse(raw) || [];
  } catch (e) {
    return [];
  }
}

async function getRequests(env, chatId) {
  const raw = await sGet(env, "requests:" + chatId);
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    } catch (e) {
      /* ignore */
    }
  }
  return [];
}
// درخواست‌ها سقف ندارند و همه ذخیره می‌شوند
async function addRequest(env, chatId, entry) {
  const list = await getRequests(env, chatId);
  list.push(entry);
  await sPut(env, "requests:" + chatId, JSON.stringify(list));
}

async function isOwner(env, userId) {
  if (env.ADMIN_USER_ID && String(env.ADMIN_USER_ID).trim()) {
    return String(env.ADMIN_USER_ID).trim() === String(userId);
  }
  const owner = await sGet(env, "owner");
  if (!owner) {
    await sPut(env, "owner", String(userId));
    return true; // اولین نفری که در خصوصی /start بزند صاحب بات می‌شود
  }
  return String(owner) === String(userId);
}

/* ------------------------------------------------------------------ */
/* تلگرام — بات فقط پیام می‌فرستد؛ هرگز پیام حذف نمی‌کند              */
/* ------------------------------------------------------------------ */
async function tg(env, method, body) {
  const res = await fetch(
    "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    /* پاسخ JSON نبود */
  }
  return { status: res.status, data };
}

async function sendMessage(env, chatId, text, replyTo) {
  const body = { chat_id: chatId, text };
  if (replyTo) body.reply_to_message_id = replyTo;
  return tg(env, "sendMessage", body);
}

async function sendDocument(env, chatId, document, caption, replyTo) {
  const body = { chat_id: chatId, document };
  if (caption) body.caption = caption;
  if (replyTo) body.reply_to_message_id = replyTo;
  return tg(env, "sendDocument", body);
}

async function sendAudio(env, chatId, audio, caption, replyTo) {
  const body = { chat_id: chatId, audio };
  if (caption) body.caption = caption;
  if (replyTo) body.reply_to_message_id = replyTo;
  return tg(env, "sendAudio", body);
}

// ارسال فایل ایندکس‌شده — فقط خود فایل، بدون لینک و بدون نام منبع.
// اگر تلگرام قبول نکرد (فایل خیلی بزرگ است)، فقط همین را می‌گوید.
async function sendIndexedFile(env, replyChatId, entry, replyTo) {
  const caption = "📚 " + entry.title;
  let r;
  if (entry.kind === "audio") {
    r = await sendAudio(env, replyChatId, entry.file_id, caption, replyTo);
  } else {
    r = await sendDocument(env, replyChatId, entry.file_id, caption, replyTo);
  }
  if (r.data && r.data.ok) return true;
  await sendMessage(
    env, replyChatId,
    "📚 " + entry.title + "\n\nاین فایل خیلی بزرگ است و تلگرام اجازه نمی‌دهد بات دوباره بفرستد.",
    replyTo
  );
  return false;
}

/* ------------------------------------------------------------------ */
/* ایندکس کتاب‌ها (گروه و چنل)                                         */
/* ------------------------------------------------------------------ */
function fileTitleFromMessage(message) {
  // عنوان را از کپشن می‌خوانیم، وگرنه از نام فایل
  const caption = (message.caption || "").trim();
  if (caption) return caption.split("\n")[0].trim();
  const doc = message.document || message.audio;
  if (doc && doc.file_name) {
    return doc.file_name
      .replace(/\.(pdf|epub|mobi|mp3|m4a|ogg|opus)$/i, "")
      .replace(/[_-]+/g, " ")
      .trim();
  }
  return "";
}

function isBookFile(message) {
  const doc = message.document;
  if (doc) {
    const name = (doc.file_name || "").toLowerCase();
    return (
      /\.pdf$/.test(name) || /\.epub$/.test(name) || /\.mobi$/.test(name) ||
      (doc.mime_type || "").includes("pdf") ||
      (doc.mime_type || "").includes("epub")
    );
  }
  if (message.audio || message.voice) return true;
  return false;
}

async function indexFile(env, chatId, message, titleOverride) {
  const file = message.document || message.audio || message.voice;
  if (!file || !file.file_id) return false;
  const title = (titleOverride || fileTitleFromMessage(message) || "").trim();
  if (!title) return false;
  const norm = normalizeFa(title);
  if (!norm) return false;
  const kind = message.document ? "pdf" : "audio";
  const index = await getIndex(env, chatId);
  const existing = index.find((e) => e.file_id === file.file_id);
  if (existing) {
    existing.title = title;
    existing.norm = norm;
    existing.kind = kind;
  } else {
    index.push({
      title,
      norm,
      file_id: file.file_id,
      message_id: message.message_id,
      kind,
      date: Date.now(),
    });
  }
  await saveIndex(env, chatId, index);
  await markChatKnown(env, chatId);
  return true;
}

async function removeFromIndex(env, chatId, fileId) {
  const index = await getIndex(env, chatId);
  const next = index.filter((e) => e.file_id !== fileId);
  if (next.length === index.length) return null;
  await saveIndex(env, chatId, next);
  return index.find((e) => e.file_id === fileId);
}

// بهترین تطابق در همه چت‌های شناخته‌شده؛ گروه فعلی اولویت دارد
async function searchIndex(env, chatIds, query) {
  const msgNorm = normalizeFa(query);
  const qWords = queryWords(query);
  if (qWords.length === 0 && !msgNorm) return null;
  let best = null;
  for (const chatId of chatIds) {
    const index = await getIndex(env, chatId);
    for (const entry of index) {
      const score = titleMatchScore(entry.norm, msgNorm);
      if (score > 0 && (!best || score > best.score)) {
        best = { ...entry, groupId: chatId, score };
      }
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* جستجوی نسخه رایگان قانونی — Internet Archive و Open Library         */
/* ------------------------------------------------------------------ */
async function iaSearch(query, mediaType) {
  const q = "title:(" + query + ") AND mediatype:" + mediaType;
  const url =
    "https://archive.org/advancedsearch.php?q=" + encodeURIComponent(q) +
    "&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=language&rows=5&output=json";
  const res = await fetch(url, { signal: AbortSignal.timeout(IA_TIMEOUT_MS) });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  const docs = (data && data.response && data.response.docs) || [];
  return docs.filter((d) => d.identifier);
}

async function iaMetadata(identifier) {
  const url = "https://archive.org/metadata/" + encodeURIComponent(identifier);
  const res = await fetch(url, { signal: AbortSignal.timeout(IA_TIMEOUT_MS) });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

function iaPickFile(meta, isAudio) {
  if (!meta || !Array.isArray(meta.files)) return null;
  const files = meta.files;
  if (isAudio) {
    const mp3 = files.find((f) => /\.mp3$/i.test(f.name || "") && (f.format || "").includes("MP3"));
    const anyMp3 = files.find((f) => /\.mp3$/i.test(f.name || ""));
    return mp3 || anyMp3 || null;
  }
  const exact = files.find((f) => (f.name || "").toLowerCase() === (meta.metadata?.identifier || "") + ".pdf");
  const textPdf = files.find((f) => /_text\.pdf$/i.test(f.name || ""));
  const anyPdf = files.find((f) => /\.pdf$/i.test(f.name || ""));
  return exact || textPdf || anyPdf || null;
}

function iaDownloadUrl(identifier, fileName) {
  return (
    "https://archive.org/download/" +
    encodeURIComponent(identifier) +
    "/" +
    encodeURIComponent(fileName)
  );
}

async function olSearch(query) {
  // Open Library (آرشیو رایگان) — آیتم‌های تمام‌متن، که شناسه Internet Archive دارند
  const url =
    "https://openlibrary.org/search.json?q=" + encodeURIComponent(query) +
    "&has_fulltext=true&limit=5";
  const res = await fetch(url, { signal: AbortSignal.timeout(IA_TIMEOUT_MS) });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  const docs = (data && data.docs) || [];
  const out = [];
  for (const d of docs) {
    const ids = Array.isArray(d.ia) ? d.ia : [];
    for (const id of ids) out.push({ identifier: id, title: d.title || query });
  }
  return out;
}

async function searchFreeCopy(query) {
  // نتیجه: { title, pdfUrl?, audioUrl? } یا null
  const out = { title: query };
  try {
    const textDocs = await iaSearch(query, "texts");
    for (const doc of textDocs) {
      const meta = await iaMetadata(doc.identifier);
      const file = iaPickFile(meta, false);
      if (file) {
        out.title = doc.title || query;
        out.pdfUrl = iaDownloadUrl(doc.identifier, file.name);
        break;
      }
    }
  } catch (e) {
    /* جستجوی PDF در IA نشد؛ ادامه بده */
  }
  try {
    const audioDocs = await iaSearch(query, "audio");
    for (const doc of audioDocs) {
      const meta = await iaMetadata(doc.identifier);
      const file = iaPickFile(meta, true);
      if (file) {
        out.audioTitle = doc.title || query;
        out.audioUrl = iaDownloadUrl(doc.identifier, file.name);
        break;
      }
    }
  } catch (e) {
    /* جستجوی صوتی در IA نشد؛ ادامه بده */
  }
  if (!out.pdfUrl) {
    // آرشیو دوم: Open Library
    try {
      const olDocs = await olSearch(query);
      for (const doc of olDocs) {
        const meta = await iaMetadata(doc.identifier);
        const file = iaPickFile(meta, false);
        if (file) {
          out.title = doc.title || out.title;
          out.pdfUrl = iaDownloadUrl(doc.identifier, file.name);
          break;
        }
      }
    } catch (e) {
      /* جستجوی Open Library نشد؛ ادامه بده */
    }
  }
  if (!out.pdfUrl && !out.audioUrl) return null;
  return out;
}

/* ------------------------------------------------------------------ */
/* دستورها                                                             */
/* ------------------------------------------------------------------ */
function startText() {
  return (
    "📚 سلام! من ربات درخواست کتاب گروه هستم.\n\n" +
    "اسم کتاب را در گروه بنویسید؛ اگر کتاب موجود باشد همان فایل را " +
    "در جواب پیام‌تان می‌فرستم، وگرنه دنبال نسخه رایگان قانونیش می‌گردم.\n\n" +
    "برای جستجو هیچ دستوری لازم نیست — فقط اسم کتاب را بنویسید.\n" +
    "دستور اختیاری: /book <نام کتاب>\n" +
    "/help — راهنما"
  );
}

async function orderedSearchChats(env, currentChatId) {
  const known = await getKnownChats(env);
  const ordered = [String(currentChatId)];
  for (const id of known) {
    if (String(id) !== String(currentChatId)) ordered.push(String(id));
  }
  return ordered;
}

async function doSearch(env, searchChatIds, replyChatId, logChatId, query, replyTo, fromUser) {
  // searchChatIds: چت‌هایی که ایندکس‌شان را می‌گردیم (گروه خودت + گروه‌ها و چنل‌های منبع)
  // replyChatId: چتی که جواب باید در آن فرستاده شود
  // logChatId: گروهی که درخواست پیدا‌نشده در آن ثبت می‌شود
  const found = await searchIndex(env, searchChatIds, query);
  if (found) {
    await sendIndexedFile(env, replyChatId, found, replyTo);
    return;
  }
  // هیچ‌جا نبود → جستجوی نسخه رایگان قانونی (بدون نام بردن از منبع)
  await sendMessage(env, replyChatId, "🔎 «" + query + "» پیدا نشد؛ دارم جاهای دیگر را هم می‌گردم…", replyTo);
  const free = await searchFreeCopy(query);
  if (!free) {
    await sendMessage(
      env, replyChatId,
      "😕 «" + query + "» پیدا نشد.\nدرخواستت ثبت شد تا مدیر گروه ببیند.",
      replyTo
    );
    await addRequest(env, logChatId, {
      text: query,
      user: fromUser ? fromUser.first_name || String(fromUser.id) : "",
      userId: fromUser ? fromUser.id : null,
      date: Date.now(),
    });
    return;
  }
  let sent = false;
  if (free.pdfUrl) {
    const r = await sendDocument(env, replyChatId, free.pdfUrl, "📕 " + free.title, replyTo);
    if (r.data && r.data.ok) sent = true;
  }
  if (free.audioUrl) {
    const r = await sendAudio(env, replyChatId, free.audioUrl, "🎧 " + (free.audioTitle || free.title), replyTo);
    if (r.data && r.data.ok) sent = true;
  }
  if (!sent) {
    // فایل برای ارسال با بات خیلی بزرگ بود → لینک دانلود
    const lines = ["✅ نسخه رایگان پیدا شد:", "📕 " + free.title];
    if (free.pdfUrl) lines.push("PDF: " + free.pdfUrl);
    if (free.audioUrl) lines.push("🎧 صوتی: " + free.audioUrl);
    lines.push("فایل بزرگ است، پس لینک دانلود را فرستادم.");
    await sendMessage(env, replyChatId, lines.join("\n"), replyTo);
  }
}

async function denyNotOwner(env, chatId, replyTo) {
  await sendMessage(env, chatId, "⛔ این دستور فقط برای مدیر بات است.", replyTo);
}

/* ------------------------------------------------------------------ */
/* پردازش آپدیت تلگرام                                                 */
/* ------------------------------------------------------------------ */
async function handleUpdate(update, env) {
  if (!env.TELEGRAM_BOT_TOKEN) return;

  // جلوگیری از پردازش تکراری
  if (update.update_id !== undefined) {
    const seen = await sGet(env, "upd:" + update.update_id);
    if (seen) return;
    await sPut(env, "upd:" + update.update_id, "1", { expirationTtl: 300 });
  }

  // پست چنل: فقط فایل را ایندکس می‌کند؛ هرگز در چنل جواب نمی‌دهد
  if (update.channel_post) {
    const post = update.channel_post;
    if (post && isBookFile(post)) {
      await indexFile(env, post.chat.id, post);
    }
    return;
  }

  const message = update.message;
  if (!message) return;
  const chat = message.chat || {};
  const from = message.from || {};
  if (from.is_bot) return; // به پیام خود بات و ربات‌های دیگر جواب نمی‌دهیم
  const chatId = chat.id;
  const isGroup = chat.type === "group" || chat.type === "supergroup";
  const text = typeof message.text === "string" ? message.text : "";

  // ۱) فایل کتاب در گروه → ایندکس کن (بی‌صدا)
  if (isGroup && isBookFile(message)) {
    await indexFile(env, chatId, message);
    return;
  }

  if (!text) return;

  // ۲) دستورها
  if (text.startsWith("/")) {
    const parts = text.trim().split(/\s+/);
    const rawCmd = parts[0].replace(/@.*$/, "");
    const cmd = rawCmd.toLowerCase();
    const arg = parts.slice(1).join(" ").trim();

    if (cmd === "/start" || cmd === "/help") {
      if (!isGroup) await isOwner(env, from.id); // قفل صاحب در خصوصی
      await sendMessage(env, chatId, startText());
      return;
    }
    // جستجو: برای همه آزاد است (دستور اختیاری؛ پیام عادی هم همین کار را می‌کند)
    if (cmd === "/book" || cmd === "/کتاب" || cmd === "/find") {
      if (!arg) {
        await sendMessage(env, chatId, "نام کتاب را هم بنویس. مثال:\n/book تاریخ ایران", message.message_id);
        return;
      }
      const chats = isGroup ? await orderedSearchChats(env, chatId) : await getKnownChats(env);
      await doSearch(env, chats, chatId, isGroup ? chatId : chats[0], arg, message.message_id, from);
      return;
    }
    // دستورهای مدیریتی: فقط صاحب بات
    if (cmd === "/add" || cmd === "/index") {
      if (!(await isOwner(env, from.id))) {
        await denyNotOwner(env, chatId, message.message_id);
        return;
      }
      const replied = message.reply_to_message;
      if (!replied || !isBookFile(replied)) {
        await sendMessage(env, chatId, "روی پیام فایل کتاب ریپلای بزن و بعد /add <عنوان> را بفرست.", message.message_id);
        return;
      }
      const ok = await indexFile(env, chatId, replied, arg || undefined);
      await sendMessage(
        env, chatId,
        ok ? "✅ به ایندکس اضافه شد." : "⚠️ نتوانستم این پیام را ایندکس کنم (عنوان یا فایل ندارد).",
        message.message_id
      );
      return;
    }
    if (cmd === "/del" || cmd === "/delete" || cmd === "/remove") {
      if (!(await isOwner(env, from.id))) {
        await denyNotOwner(env, chatId, message.message_id);
        return;
      }
      const replied = message.reply_to_message;
      let removed = null;
      if (replied && isBookFile(replied)) {
        const fileId = (replied.document || replied.audio || replied.voice || {}).file_id;
        if (fileId) removed = await removeFromIndex(env, chatId, fileId);
      } else if (arg) {
        const found = await searchIndex(env, [chatId], arg);
        if (found) removed = await removeFromIndex(env, chatId, found.file_id);
      }
      await sendMessage(
        env, chatId,
        removed ? "🗑 «" + removed.title + "» از ایندکس حذف شد." : "⚠️ چیزی برای حذف پیدا نشد. روی پیام فایل ریپلای بزن یا عنوانش را بنویس: /del <عنوان>",
        message.message_id
      );
      return;
    }
    if (cmd === "/requests") {
      if (!(await isOwner(env, from.id))) {
        await denyNotOwner(env, chatId, message.message_id);
        return;
      }
      const list = await getRequests(env, chatId);
      if (list.length === 0) {
        await sendMessage(env, chatId, "📭 درخواستی ثبت نشده است.");
        return;
      }
      const last = list.slice(-20).reverse();
      const lines = ["📋 درخواست‌های پیدا‌نشده (" + list.length + " مورد — ۲۰ تای آخر):"];
      last.forEach((r, i) => {
        lines.push((i + 1) + ". «" + r.text + "» — " + (r.user || "?"));
      });
      await sendMessage(env, chatId, lines.join("\n"));
      return;
    }
    if (cmd === "/stats") {
      if (!(await isOwner(env, from.id))) return;
      let total = 0;
      let totalPdf = 0;
      let totalAudio = 0;
      const chats = await getKnownChats(env);
      for (const id of chats) {
        const idx = await getIndex(env, id);
        total += idx.length;
        totalPdf += idx.filter((e) => e.kind === "pdf").length;
        totalAudio += idx.filter((e) => e.kind === "audio").length;
      }
      const here = await getIndex(env, chatId);
      await sendMessage(
        env, chatId,
        "📊 کتاب‌های ایندکس‌شده:\n" +
          "• این گروه: " + here.length + "\n" +
          "• همه منابع با هم: " + total + " (📕 PDF: " + totalPdf + " ، 🎧 صوتی: " + totalAudio + ")"
      );
      return;
    }
    return; // دستور ناشناخته
  }

  // ۳) پیام متنی عادی در گروه: جستجوی خودکار — بدون نیاز به هیچ دستوری
  //     و بدون سقف طول پیام؛ تطابق عنوان خودش فیلتر است
  if (isGroup) {
    // حرف معمولی («سپاسگزارم»، «سلام» و...) درخواست کتاب نیست: سکوت کامل
    if (isChatter(text)) return;
    const chats = await orderedSearchChats(env, chatId);
    const found = await searchIndex(env, chats, text);
    if (found) {
      await sendIndexedFile(env, chatId, found, message.message_id);
      return;
    }
    // در آرشیو نبود: اگر پیام صریحاً درخواست کتاب است، یا پیام کوتاه
    // و عنوان‌مانند است (مثلاً فقط «تاوان»)، در آرشیوهای رایگان بگرد
    // و اگر نبود درخواست را ثبت کن. چت معمولی گروه نادیده گرفته می‌شود.
    const rawWords = text.trim().split(/\s+/).length;
    const qWords = queryWords(text);
    const q = qWords.join(" ");
    if (q && (looksLikeRequest(text) || (rawWords <= 3 && qWords.length <= 3))) {
      await doSearch(env, chats, chatId, chatId, q, message.message_id, from);
    }
    return;
  }

  // ۴) پیام متنی در چت خصوصی: جستجو در همه گروه‌ها و چنل‌هایی که بات می‌شناسد
  if (!isGroup) {
    if (isChatter(text)) return;
    const chats = await getKnownChats(env);
    if (chats.length === 0) {
      await sendMessage(env, chatId, "هنوز گروه یا چنلی را نمی‌شناسم. اول بات را در گروه کتاب اضافه کن تا آرشیوش را ایندکس کند.");
      return;
    }
    const found = await searchIndex(env, chats, text);
    if (found) {
      await sendIndexedFile(env, chatId, found, message.message_id);
      return;
    }
    if (queryWords(text).length > 0) {
      await doSearch(env, chats, chatId, chats[0], queryWords(text).join(" "), message.message_id, from);
    }
  }
}

/* ------------------------------------------------------------------ */
/* نقطه ورود Worker — وب‌هوک تلگرام                                    */
/* ------------------------------------------------------------------ */
export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("📚 ربات درخواست کتاب — Worker فعال است (نسخه ۵). فقط تلگرام باید به این آدرس POST بفرستد.", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    let update = null;
    try {
      update = await request.json();
    } catch (e) {
      return new Response("OK", { status: 200 });
    }
    if (!update || typeof update !== "object") {
      return new Response("OK", { status: 200 });
    }
    // جواب ۲۰۰ را فوراً به تلگرام بده و پردازش را در پس‌زمینه ادامه بده
    ctx.waitUntil(handleUpdate(update, env));
    return new Response("OK", { status: 200 });
  },
};
