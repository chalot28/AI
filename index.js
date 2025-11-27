// ================== 1. LOAD THƯ VIỆN & CẤU HÌNH ==================
require("dotenv").config();
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const moment = require("moment-timezone");
const https = require('https');
const fs = require('fs'); // [MỚI] Thêm thư viện đọc file

// Fix lỗi fetch cho Node.js cũ
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

// Lấy biến môi trường
const {
  TELEGRAM_TOKEN,
  GOOGLE_CHAT_KEYS,
  VOICERSS_KEYS,
  SERPER_API_KEY,
  GROQ_API_KEY,
  OPENROUTER_API_KEY,
  SELF_PING_URL,
  GOOGLE_APP_SCRIPT_URL: GAS_URL,
  PORT = 3000
} = process.env;

// Kiểm tra biến môi trường quan trọng
if (!TELEGRAM_TOKEN || !GOOGLE_CHAT_KEYS || !GAS_URL) {
  console.error("❌ LỖI: Thiếu Token hoặc Keys cơ bản trong .env");
  process.exit(1);
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; 
const REQUEST_TIMEOUT = 60000; 
const MODEL_GEMINI = "gemini-1.5-flash"; 

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const app = express();
app.use(express.json());

// ================== 2. QUẢN LÝ KEY & BỘ NHỚ ==================

// 2.1 Quản lý Key GEMINI
class KeyManager {
  constructor(keysString, name) {
    this.name = name;
    this.keys = keysString.split(",").map(k => k.trim()).filter(k => k);
    this.currentIndex = 0;
    console.log(`✅ [${name}] Đã nạp ${this.keys.length} API Keys.`);
  }

  getCurrentClient() {
    return new GoogleGenerativeAI(this.keys[this.currentIndex]);
  }

  rotate() {
    this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    console.log(`⚠️ [${this.name}] Đổi sang Key số ${this.currentIndex + 1}...`);
  }

  async executeWithRetry(operationFunc) {
    let attempts = this.keys.length === 1 ? 3 : this.keys.length;
    while (attempts > 0) {
      try {
        const client = this.getCurrentClient();
        return await operationFunc(client);
      } catch (error) {
        const msg = (error.message || "").toLowerCase();
        console.error(`🔴 [${this.name}] Lỗi:`, msg);
        
        if (msg.includes("429") || msg.includes("quota") || msg.includes("resource_exhausted")) {
          if (this.keys.length === 1) { await new Promise(r => setTimeout(r, 5000)); attempts--; continue; }
          this.rotate(); attempts--;
        } else { throw error; }
      }
    }
    throw new Error(`[${this.name}] Hệ thống bận.`);
  }
}

// 2.2 Quản lý Key VOICE RSS
class VoiceKeyManager {
  constructor(keysString) {
    this.name = "VOICE-RSS";
    this.keys = (keysString || "").split(",").map(k => k.trim()).filter(k => k);
    this.currentIndex = 0;
  }
  getKey() {
    if (this.keys.length === 0) throw new Error("Chưa cấu hình VOICERSS_KEYS");
    return this.keys[this.currentIndex];
  }
  rotate() {
    if (this.keys.length <= 1) return;
    this.currentIndex = (this.currentIndex + 1) % this.keys.length;
  }
}

// 2.3 Quản lý ngữ cảnh Chat (Memory)
class ChatContextManager {
  constructor(maxMessages = 6, maxWords = 150) {
    this.userContexts = new Map(); 
    this.maxMessages = maxMessages; 
    this.maxWords = maxWords;       
    setInterval(() => this.cleanupInactiveUsers(), 5 * 60 * 1000);
  }

  addMessage(userId, content, role = 'user') {
    const truncatedContent = this._truncateMessage(content);
    const now = Date.now();
    let ctx = this.userContexts.get(userId);
    if (!ctx) ctx = { messages: [], lastActive: now };
    ctx.messages.push({ role, content: truncatedContent });
    if (ctx.messages.length > this.maxMessages) ctx.messages.shift();
    ctx.lastActive = now;
    this.userContexts.set(userId, ctx);
  }

  getFormattedContext(userId) {
    const ctx = this.userContexts.get(userId);
    if (!ctx || ctx.messages.length === 0) return "";
    return ctx.messages.map(m => `${m.role === 'user' ? 'User' : 'Bot'}: ${m.content}`).join("\n");
  }

  _truncateMessage(message) {
    if (!message) return "";
    return message.trim().split(/\s+/).slice(0, this.maxWords).join(' ');
  }

  cleanupInactiveUsers(maxAgeMs = 10 * 60 * 1000) { 
    const now = Date.now();
    for (const [userId, ctx] of this.userContexts.entries()) {
      if (now - ctx.lastActive > maxAgeMs) this.userContexts.delete(userId);
    }
  }
}

// 2.4 Quản lý giới hạn sử dụng (RAM Optimized)
class TemporaryUsageManager {
  constructor() {
    this.usageMap = new Map(); 
    this.lockLimit = 10;        // 10 lượt check/giờ
    this.ttlHours = 1;         
    setInterval(() => this.cleanupExpiredRecords(), 5 * 60 * 1000);
  }

  checkAndIncrement(userId, event) {
    const key = `${userId}_${event}`;
    const now = Date.now();
    let record = this.usageMap.get(key);

    if (!record || record.expiresAt < now) {
      const expiresAt = now + (this.ttlHours * 60 * 60 * 1000);
      this.usageMap.set(key, { count: 1, expiresAt });
      return { allowed: true, currentCount: 1, limit: this.lockLimit, message: `Lượt 1/${this.lockLimit}` };
    }

    if (record.count >= this.lockLimit) {
      const waitMinutes = Math.ceil((record.expiresAt - now) / 60000);
      return { allowed: false, currentCount: record.count, limit: this.lockLimit, message: `🚫 Hết lượt. Thử lại sau ${waitMinutes} phút.` };
    }

    record.count++;
    this.usageMap.set(key, record);
    return { allowed: true, currentCount: record.count, limit: this.lockLimit, message: `Lượt ${record.count}/${this.lockLimit}` };
  }

  cleanupExpiredRecords() {
    const now = Date.now();
    for (const [key, val] of this.usageMap.entries()) {
      if (val.expiresAt < now) this.usageMap.delete(key);
    }
  }
}

const chatManager = new KeyManager(GOOGLE_CHAT_KEYS, "CHAT-GEMINI");
const voiceManager = new VoiceKeyManager(VOICERSS_KEYS);
const contextManager = new ChatContextManager(); 
const usageManager = new TemporaryUsageManager(); 

// ================== 3. TIỆN ÍCH MẠNG & SEARCH ==================

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// Search Đa Chiều
async function performComprehensiveSearch(query) {
    if (!SERPER_API_KEY) return null;

    const searchTypes = [
        { q: query, type: "search" },              
        { q: `${query} fact check`, type: "news" }
    ];

    try {
        const promises = searchTypes.map(async (params) => {
            const res = await fetch("https://google.serper.dev/search", {
                method: "POST",
                headers: { "X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json" },
                body: JSON.stringify({ q: params.q, type: params.type, gl: "vn", hl: "vi", num: 5 })
            });
            if (!res.ok) return null;
            return await res.json();
        });

        const results = await Promise.all(promises);
        let combinedContext = "";

        // 1. Kết quả Search thường
        const searchData = results[0];
        if (searchData) {
            if (searchData.answerBox) combinedContext += `💡 TRẢ LỜI NHANH: ${searchData.answerBox.title || ""} - ${searchData.answerBox.snippet || searchData.answerBox.answer || ""}\n\n`;
            if (searchData.organic) combinedContext += searchData.organic.map(r => `[WEB] ${r.title}\nLink: ${r.link}\nInfo: ${r.snippet}`).join("\n\n");
        }

        // 2. Kết quả News
        const newsData = results[1];
        if (newsData && newsData.news) {
             combinedContext += "\n\n📰 TIN TỨC LIÊN QUAN:\n" + newsData.news.map(n => `[NEWS] ${n.title} (${n.date || ""})\nInfo: ${n.snippet}`).join("\n\n");
        }

        return combinedContext || null;
    } catch (e) {
        console.error("Search Error:", e);
        return null;
    }
}

async function generateImage(prompt) {
    const encoded = encodeURIComponent(prompt);
    const url = `https://image.pollinations.ai/prompt/${encoded}?model=flux&width=1024&height=1024&nologo=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Lỗi vẽ ảnh");
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 1000) throw new Error("Ảnh lỗi");
    return { buffer };
}

async function generateVoice(text) {
  let attempts = voiceManager.keys.length > 0 ? voiceManager.keys.length : 1;
  while (attempts > 0) {
    try {
      const apiKey = voiceManager.getKey();
      const url = `https://api.voicerss.org/?key=${apiKey}&hl=vi-vn&c=MP3&f=44khz_16bit_stereo&src=${encodeURIComponent(text)}`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (error) {
      if (voiceManager.keys.length > 1) { voiceManager.rotate(); attempts--; continue; }
      throw error;
    }
  }
  throw new Error("Lỗi Voice.");
}

// ================== 4. AI LOGIC ==================

function buildVerificationPrompt(query, searchContext) {
    return `
Bạn là chuyên gia kiểm chứng thông tin (Fact-Checker).
Nhiệm vụ: Phân tích thông tin dựa trên dữ liệu tìm kiếm dưới đây và trả về kết quả dưới dạng JSON.

THÔNG TIN CẦN KIỂM TRA: "${query}"

DỮ LIỆU TÌM KIẾM:
${searchContext}

YÊU CẦU:
1. Phân tích độ chính xác (Đúng/Sai/Không rõ/Một phần).
2. Đưa ra bằng chứng cụ thể.
3. Trích dẫn nguồn.

⚠️ BẮT BUỘC TRẢ LỜI ĐÚNG ĐỊNH DẠNG JSON SAU:
{
  "verified": "ĐÚNG | SAI | KHÔNG RÕ | MỘT PHẦN",
  "confidence": "CAO | TRUNG BÌNH | THẤP",
  "summary": "Tóm tắt ngắn gọn",
  "reasoning": "Giải thích chi tiết (3-4 câu)",
  "evidence": ["Bằng chứng 1", "Bằng chứng 2"],
  "sources": ["Nguồn 1", "Nguồn 2"]
}
`;
}

async function callGroq(prompt, systemPrompt) {
    if (!GROQ_API_KEY) throw new Error("No Groq");
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST", headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }], temperature: 0.3 }) 
    });
    const data = await res.json();
    return data.choices[0].message.content;
}

async function callGemini(prompt, imageBuffer, systemPrompt) {
    return chatManager.executeWithRetry(async (client) => {
        const model = client.getGenerativeModel({ model: MODEL_GEMINI });
        const parts = imageBuffer ? [{ inlineData: { data: imageBuffer.toString("base64"), mimeType: "image/jpeg" } }] : [];
        parts.push({ text: `${systemPrompt}\n\nUser: ${prompt}` });
        const res = await model.generateContent(parts);
        return res.response.text();
    });
}

async function askHybridAI(promptText, imageBuffer = null, searchContext = null, isJsonMode = false) {
    let systemPrompt = isJsonMode 
        ? "Bạn là hệ thống xử lý dữ liệu JSON. Chỉ trả về JSON thuần túy." 
        : "Bạn là trợ lý ảo hữu ích.";
    
    let finalPrompt = promptText; 
    
    if (searchContext && !isJsonMode) {
        systemPrompt += `\n\n[DỮ LIỆU TÌM KIẾM]\n${searchContext}\nTrả lời dựa trên thông tin này.`;
    }

    if (imageBuffer) return await callGemini(finalPrompt, imageBuffer, systemPrompt);

    try {
        return await callGroq(finalPrompt, systemPrompt);
    } catch (e) {
        console.warn("Groq lỗi, chuyển Gemini...");
    }

    try {
        return await callGemini(finalPrompt, null, systemPrompt);
    } catch (e) {
        throw new Error("AI bận.");
    }
}

// ================== 5. FACT CHECK CORE ==================

async function processFactCheck(chatId, query, imageBuffer = null) {
    let queryToSearch = query;
    let extractedInfo = "";
    
    if (imageBuffer) {
        const extractPrompt = "Hãy liệt kê các sự kiện, văn bản, hoặc tuyên bố chính trong bức ảnh này để tôi kiểm chứng sự thật.";
        extractedInfo = await askHybridAI(extractPrompt, imageBuffer);
        queryToSearch = `${query} ${extractedInfo}`.substring(0, 400); 
    }

    const searchContext = await performComprehensiveSearch(queryToSearch);
    if (!searchContext) return "❌ Không tìm thấy thông tin nào để kiểm chứng.";

    const verificationPrompt = buildVerificationPrompt(queryToSearch, searchContext);
    const rawJson = await askHybridAI(verificationPrompt, null, null, true);

    try {
        const jsonMatch = rawJson.match(/\{[\s\S]*\}/);
        const data = JSON.parse(jsonMatch ? jsonMatch[0] : rawJson);

        const v = data.verified.toUpperCase();
        const icon = v.includes("ĐÚNG") ? "✅" : (v.includes("SAI") ? "❌" : "⚠️");
        
        let msg = `${icon} **KẾT QUẢ KIỂM TRA:** ${data.verified}\n`;
        msg += `🔍 **Độ tin cậy:** ${data.confidence}\n\n`;
        msg += `📝 **Tóm tắt:** ${data.summary}\n\n`;
        msg += `📖 **Giải thích:** ${data.reasoning}\n\n`;
        
        if (data.evidence && data.evidence.length > 0) {
            msg += `🔎 **Bằng chứng:**\n` + data.evidence.map(e => `- ${e}`).join("\n") + "\n";
        }
        
        return msg;
    } catch (e) {
        return `⚠️ **Kết quả (Raw):**\n${rawJson}`;
    }
}

// ================== 6. BOT HANDLER ==================

async function handleReminderCommand(chatId, text) {
  const content = text.replace(/^\/nn\s*/i, "").trim();
  if (!content) return "⚠️ Sai cú pháp. VD: `/nn 9:30`";
  const parts = content.split(" ");
  const timeStr = parts[0];
  const note = parts.slice(1).join(" ") || "Reminder";
  let targetTime = moment().tz("Asia/Ho_Chi_Minh");
  let type = "ONE_TIME";

  if (timeStr.includes("/")) {
    const [t, d, m] = timeStr.split("/");
    const to = parseTime(t);
    if (!to) return "❌ Lỗi giờ.";
    targetTime.hour(to.h).minute(to.m).second(0).date(d).month(m - 1);
    if (targetTime.isBefore(moment())) targetTime.add(1, 'year');
  } else {
    const to = parseTime(timeStr);
    if (!to) return "❌ Lỗi giờ.";
    targetTime.hour(to.h).minute(to.m).second(0);
    if (targetTime.isBefore(moment())) targetTime.add(1, "days");
    type = "DAILY";
  }
  await addReminderToSheet(chatId, targetTime, note, type);
  return `✅ Đã hẹn: *${targetTime.format("HH:mm DD/MM")}*\n📝 ${note}`;
}

function parseTime(str) {
  const match = str.match(/^(\d{1,2})[:hH\s\.]?(\d{1,2})?$/);
  if (!match) return null;
  const h = parseInt(match[1]);
  const m = match[2] ? parseInt(match[2]) : 0;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

const userStates = new Map();
function setUserProcessing(chatId, isProcessing, requestId = 0) {
  if (!isProcessing) userStates.delete(chatId);
  else userStates.set(chatId, { isProcessing, requestId });
}
function getUserState(chatId) {
  return userStates.get(chatId) || { isProcessing: false, requestId: 0 };
}

bot.on("polling_error", (error) => {
    if (!error.message.includes("ECONNRESET") && !error.message.includes("ETIMEDOUT")) {
        console.log(`[Polling] ${error.message}`);
    }
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  let text = msg.text || msg.caption || "";
  const hasPhoto = msg.photo && msg.photo.length > 0;
  const hasDocument = msg.document;
  
  if (!text && !hasPhoto && !hasDocument) return;
  console.log(`📩 [${chatId}] ${text.substring(0, 30)}...`);

  // [MỚI] Lệnh /ver đọc file json
  if (text.trim().toLowerCase() === "/ver") {
      try {
          if (fs.existsSync('./version.json')) {
              const raw = fs.readFileSync('./version.json');
              const data = JSON.parse(raw);
              let reply = `🤖 **Bot Info:**\n`;
              for (const [key, value] of Object.entries(data)) {
                  reply += `- **${key}:** ${value}\n`;
              }
              return bot.sendMessage(chatId, reply, {parse_mode: "Markdown"});
          } else {
              return bot.sendMessage(chatId, "⚠️ Chưa có file version.json");
          }
      } catch (e) {
          return bot.sendMessage(chatId, "❌ Lỗi đọc version.");
      }
  }

  // Lệnh hủy
  if (text === "//") { setUserProcessing(chatId, false); return bot.sendMessage(chatId, "✅ Đã hủy."); }

  // Reminder
  if (text.toLowerCase().startsWith("/nn")) {
      const r = await handleReminderCommand(chatId, text);
      return bot.sendMessage(chatId, r, { parse_mode: "Markdown" });
  }

  // Check state
  const state = getUserState(chatId);
  if (state.isProcessing) return bot.sendMessage(chatId, "⚠️ Đang bận (gõ `//` để hủy).");

  const reqId = Date.now();
  setUserProcessing(chatId, true, reqId);

  try {
    // --- FEATURE 1: FACT CHECK (/check) ---
    if (text.toLowerCase().startsWith("/check") || text.toLowerCase().startsWith("/verify")) {
        const limit = usageManager.checkAndIncrement(chatId, "FACT_CHECK");
        if (!limit.allowed) {
            setUserProcessing(chatId, false);
            return bot.sendMessage(chatId, limit.message);
        }

        await bot.sendMessage(chatId, `🕵️ Đang xác minh... (${limit.message})`);
        
        let imageBuffer = null;
        if (hasPhoto) {
            const link = await bot.getFileLink(msg.photo[msg.photo.length - 1].file_id);
            const res = await fetchWithRetry(link);
            imageBuffer = Buffer.from(await res.arrayBuffer());
        }

        const query = text.replace(/^\/(check|verify)\s*/i, "").trim() || (hasPhoto ? "Kiểm tra bức ảnh này" : "");
        
        if (!query && !hasPhoto) {
            setUserProcessing(chatId, false);
            return bot.sendMessage(chatId, "⚠️ Nhập thông tin hoặc gửi ảnh cần kiểm tra.");
        }

        const result = await processFactCheck(chatId, query, imageBuffer);
        
        if (getUserState(chatId).requestId === reqId) {
            await bot.sendMessage(chatId, result, { parse_mode: "Markdown" }).catch(() => bot.sendMessage(chatId, result));
            contextManager.addMessage(chatId, `[Check]: ${query}`, 'user');
            contextManager.addMessage(chatId, result, 'model');
        }
        
        setUserProcessing(chatId, false);
        return;
    }

    // --- FEATURE 2: VẼ ẢNH ---
    if (text.match(/^\/img/i)) {
        const p = text.replace(/^\/img\s*/i, "").trim();
        if(!p) { setUserProcessing(chatId, false); return bot.sendMessage(chatId, "Thiếu mô tả."); }
        await bot.sendMessage(chatId, "🎨 Đang vẽ...");
        const img = await generateImage(p);
        await bot.sendPhoto(chatId, img.buffer);
        setUserProcessing(chatId, false);
        return;
    }

    // --- FEATURE 3: VOICE ---
    if (text.match(/^\/voi/i)) {
        const p = text.replace(/^\/voi\s*/i, "").trim();
        if(!p) { setUserProcessing(chatId, false); return bot.sendMessage(chatId, "Thiếu nội dung."); }
        await bot.sendChatAction(chatId, "record_voice");
        const buf = await generateVoice(p);
        await bot.sendVoice(chatId, buf);
        setUserProcessing(chatId, false);
        return;
    }

    // --- FEATURE 4: CHAT & VISION ---
    let imageBuffer = null;
    if (hasPhoto) {
        await bot.sendMessage(chatId, "👁️ Đang xem ảnh...");
        const link = await bot.getFileLink(msg.photo[msg.photo.length - 1].file_id);
        const res = await fetchWithRetry(link);
        imageBuffer = Buffer.from(await res.arrayBuffer());
    } else if (hasDocument) {
        await bot.sendMessage(chatId, "📂 Đang đọc file...");
        if (msg.document.file_size > MAX_FILE_SIZE) throw new Error("File > 10MB");
        const link = await bot.getFileLink(msg.document.file_id);
        const res = await fetchWithRetry(link);
        const content = Buffer.from(await res.arrayBuffer()).toString("utf-8");
        text += `\n[File Content]:\n${content}`;
    } else {
        bot.sendChatAction(chatId, "typing");
    }

    // Context & Search
    let contextHistory = contextManager.getFormattedContext(chatId);
    let searchContext = null;
    
    if (text.toLowerCase().startsWith("/tim")) {
        const q = text.replace(/^\/tim\s*/i, "").trim();
        await bot.sendMessage(chatId, "🌐 Đang tìm...");
        searchContext = await performComprehensiveSearch(q); 
        text = `Trả lời câu hỏi: ${q}`;
    }

    let finalPrompt = text;
    if (contextHistory && !searchContext && !text.startsWith("/")) {
        finalPrompt = `History:\n${contextHistory}\nUser: ${text}`;
    }

    // Gọi AI (Hybrid)
    let ans = await askHybridAI(finalPrompt, imageBuffer, searchContext);
    
    // Gửi tin nhắn an toàn
    const sendSafe = async (txt) => {
        try { await bot.sendMessage(chatId, txt, { parse_mode: "Markdown" }); } 
        catch { await bot.sendMessage(chatId, txt); }
    };
    
    if (ans.length > 4000) {
        for (const c of ans.match(/.{1,4000}/g)) await sendSafe(c);
    } else {
        await sendSafe(ans);
    }

    if (!text.startsWith("/")) {
        contextManager.addMessage(chatId, hasPhoto ? "[Gửi ảnh]" : text, 'user');
        contextManager.addMessage(chatId, ans, 'model');
    }

  } catch (err) {
    console.error(err);
    if (getUserState(chatId).requestId === reqId) bot.sendMessage(chatId, "❌ Lỗi: " + err.message);
  } finally {
    if (getUserState(chatId).requestId === reqId) setUserProcessing(chatId, false);
  }
});

// ================== 7. SERVER ==================

async function getRemindersFromSheet() {
    try { return await (await fetch(GAS_URL)).json(); } catch { return []; }
}
async function addReminderToSheet(chatId, t, n, type) {
    const id = Date.now().toString().slice(-6);
    fetch(GAS_URL, { method: "POST", body: JSON.stringify({ action: "add", id, chatId, time: t.toISOString(), note: n, type }) }).catch(()=>{});
}
async function deleteReminderFromSheet(id) {
    fetch(GAS_URL, { method: "POST", body: JSON.stringify({ action: "delete", id }) }).catch(()=>{});
}

setInterval(async () => {
  const all = await getRemindersFromSheet();
  if (!all.length) return;
  const now = moment().tz("Asia/Ho_Chi_Minh");
  for (const r of all) {
    try {
      const target = moment(r.time);
      if (now.isSameOrAfter(target, 'minute')) {
        bot.sendMessage(r.chatId, `⏰ **NHẮC:** ${r.note}`, { parse_mode: "Markdown" }).catch(() => {});
        deleteReminderFromSheet(r.id);
        if (r.type === "DAILY") {
          await new Promise(res => setTimeout(res, 1000));
          addReminderToSheet(r.chatId, target.add(1, "days"), r.note, "DAILY");
        }
      }
    } catch (e) {}
  }
}, 60000);

if (typeof SELF_PING_URL !== 'undefined' && SELF_PING_URL) {
  setInterval(() => fetch(SELF_PING_URL + "/health").catch(() => {}), 300000);
}

app.get("/", (req, res) => res.send("🤖 Bot Worker Active"));
app.get("/health", (req, res) => res.json({ status: "alive" }));
app.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));