// ================== 1. LOAD THƯ VIỆN & CẤU HÌNH ==================
require("dotenv").config();
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const moment = require("moment-timezone");
const https = require('https');

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
// [FIX 1] Dùng bản 1.5 ổn định (Google chưa public 2.5)
const MODEL_GEMINI = "gemini-2.5-flash"; 

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
        
        if (msg.includes("429") || msg.includes("quota") || msg.includes("resource_exhausted") || msg.includes("overloaded")) {
          if (this.keys.length === 1) {
            await new Promise(r => setTimeout(r, 5000));
            attempts--;
            continue;
          }
          this.rotate();
          attempts--;
        } else {
          throw error;
        }
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
    if (this.keys.length > 0) console.log(`✅ [${this.name}] Đã nạp ${this.keys.length} API Keys.`);
    else console.warn(`⚠️ [${this.name}] Chưa cấu hình Key trong .env!`);
  }
  getKey() {
    if (this.keys.length === 0) throw new Error("Chưa cấu hình VOICERSS_KEYS");
    return this.keys[this.currentIndex];
  }
  rotate() {
    if (this.keys.length <= 1) return;
    this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    console.log(`⚠️ [${this.name}] Đổi sang Key số ${this.currentIndex + 1}...`);
  }
}

// 2.3 [NEW] Quản lý ngữ cảnh Chat (Memory) - Tối ưu RAM
class ChatContextManager {
  constructor(maxMessages = 6, maxWords = 150) {
    this.userContexts = new Map(); 
    this.maxMessages = maxMessages; // Nhớ 6 câu (3 cặp hỏi đáp)
    this.maxWords = maxWords;       // Giới hạn từ mỗi câu
    
    // Tự động dọn dẹp mỗi 5 phút
    setInterval(() => this.cleanupInactiveUsers(), 5 * 60 * 1000);
  }

  // Thêm tin nhắn vào bộ nhớ
  addMessage(userId, content, role = 'user') {
    const truncatedContent = this._truncateMessage(content);
    const now = Date.now();

    let ctx = this.userContexts.get(userId);
    if (!ctx) {
      ctx = { messages: [], lastActive: now };
    }

    ctx.messages.push({ role, content: truncatedContent });

    // Sliding Window: Xóa tin cũ nếu vượt quá giới hạn
    if (ctx.messages.length > this.maxMessages) {
      ctx.messages.shift();
    }

    ctx.lastActive = now;
    this.userContexts.set(userId, ctx);
  }

  // Lấy lịch sử để gửi kèm Prompt
  getFormattedContext(userId) {
    const ctx = this.userContexts.get(userId);
    if (!ctx || ctx.messages.length === 0) return "";

    return ctx.messages
      .map(m => `${m.role === 'user' ? 'User' : 'Bot'}: ${m.content}`)
      .join("\n");
  }

  // Cắt ngắn tin nhắn để tiết kiệm Token/RAM
  _truncateMessage(message) {
    if (!message) return "";
    return message.trim().split(/\s+/).slice(0, this.maxWords).join(' ');
  }

  // Dọn rác (Garbage Collection)
  cleanupInactiveUsers(maxAgeMs = 10 * 60 * 1000) { // 10 phút expire
    const now = Date.now();
    let count = 0;
    for (const [userId, ctx] of this.userContexts.entries()) {
      if (now - ctx.lastActive > maxAgeMs) {
        this.userContexts.delete(userId);
        count++;
      }
    }
    if (count > 0) console.log(`🧹 [MEMORY] Đã dọn dẹp bộ nhớ của ${count} user.`);
  }
}

const chatManager = new KeyManager(GOOGLE_CHAT_KEYS, "CHAT-GEMINI");
const voiceManager = new VoiceKeyManager(VOICERSS_KEYS);
const contextManager = new ChatContextManager(); // Khởi tạo bộ nhớ

// ================== 3. TIỆN ÍCH MẠNG ==================

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

function parseTime(str) {
  const match = str.match(/^(\d{1,2})[:hH\s\.]?(\d{1,2})?$/);
  if (!match) return null;
  const h = parseInt(match[1]);
  const m = match[2] ? parseInt(match[2]) : 0;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

function fileToGenerativePart(buffer, mimeType) {
  return { inlineData: { data: buffer.toString("base64"), mimeType } };
}

// ================== 4. GOOGLE SHEETS ==================
async function getRemindersFromSheet() {
  try { return await (await fetchWithTimeout(GAS_URL)).json(); } catch (e) { return []; }
}
async function addReminderToSheet(chatId, t, n, type) {
  const id = Date.now().toString().slice(-6);
  fetchWithTimeout(GAS_URL, { method: "POST", body: JSON.stringify({ action: "add", id, chatId, time: t.toISOString(), note: n, type }) }).catch(console.error);
  return id;
}
async function deleteReminderFromSheet(id) {
  fetchWithTimeout(GAS_URL, { method: "POST", body: JSON.stringify({ action: "delete", id }) }).catch(console.error);
}

// ================== 5. TRẠNG THÁI ==================
const userStates = new Map();
function setUserProcessing(chatId, isProcessing, requestId = 0) {
  if (!isProcessing) userStates.delete(chatId);
  else userStates.set(chatId, { isProcessing, requestId });
}
function getUserState(chatId) {
  return userStates.get(chatId) || { isProcessing: false, requestId: 0 };
}

// ================== 6. AI LOGIC (HYBRID ROTATION) ==================

function buildSystemPrompt(searchContext) {
    let systemPrompt = "Bạn là trợ lý ảo thông minh, hữu ích và thân thiện. Hãy trả lời ngắn gọn, đúng trọng tâm.";
    if (searchContext) {
      systemPrompt += `\n\n[DỮ LIỆU TÌM KIẾM]\n${searchContext}\n\nHãy trả lời dựa trên thông tin trên. Trích dẫn nguồn nếu có.`;
    }
    return systemPrompt;
}

// 6.1 Gọi Groq API (Ưu tiên 1)
async function callGroq(prompt, systemPrompt) {
    if (!GROQ_API_KEY) throw new Error("No Groq Key");
    
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "llama-3.3-70b-versatile", 
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt }
            ],
            temperature: 0.7,
            max_tokens: 1024
        })
    });

    if (!response.ok) {
         const err = await response.text();
         throw new Error(`Groq ${response.status}: ${err}`);
    }
    const data = await response.json();
    return data.choices[0].message.content;
}

// 6.2 Gọi OpenRouter API (Ưu tiên 3)
async function callOpenRouter(prompt, systemPrompt) {
    if (!OPENROUTER_API_KEY) throw new Error("No OpenRouter Key");

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://telegram.org", 
        },
        body: JSON.stringify({
            model: "google/gemini-2.0-flash-lite-preview-02-05:free", 
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt }
            ]
        })
    });

    if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
    const data = await response.json();
    return data.choices[0].message.content;
}

// 6.3 Gọi Gemini API (Ưu tiên 2 & Vision)
async function callGemini(prompt, imageBuffer, systemPrompt) {
    return chatManager.executeWithRetry(async (client) => {
        const model = client.getGenerativeModel({ model: MODEL_GEMINI });
        const parts = [];
        if (imageBuffer) parts.push(fileToGenerativePart(imageBuffer, "image/jpeg"));
        
        if (!prompt && imageBuffer) prompt = "Mô tả ảnh này.";
        parts.push({ text: `${systemPrompt}\n\nUser: ${prompt || "Xin chào"}` });
        
        const result = await model.generateContent(parts);
        return result.response.text();
    });
}

// 6.4 MASTER FUNCTION
async function askHybridAI(promptText, imageBuffer = null, searchContext = null) {
    const systemPrompt = buildSystemPrompt(searchContext);

    // TH1: Có ảnh -> Dùng Gemini
    if (imageBuffer) {
        return await callGemini(promptText, imageBuffer, systemPrompt);
    }

    // TH2: Text Only -> Groq -> Gemini -> OpenRouter
    try {
        // Bước 1: Groq
        console.log("⚡ Thử Groq...");
        return await callGroq(promptText, systemPrompt);
    } catch (e) {
        console.warn(`⚠️ Groq lỗi (${e.message}). Chuyển sang Gemini...`);
    }

    try {
        // Bước 2: Gemini
        console.log("💎 Thử Gemini...");
        return await callGemini(promptText, null, systemPrompt);
    } catch (e) {
        console.warn(`⚠️ Gemini lỗi (${e.message}). Chuyển sang OpenRouter...`);
    }

    try {
        // Bước 3: OpenRouter
        console.log("🌐 Thử OpenRouter...");
        return await callOpenRouter(promptText, systemPrompt);
    } catch (e) {
        console.error(`❌ OpenRouter lỗi: ${e.message}`);
        throw new Error("Tất cả server AI đều bận.");
    }
}

// ================== 7. TÍNH NĂNG KHÁC ==================

// 7.1 Search
async function performSearch(query) {
    if (!SERPER_API_KEY) {
        console.error("❌ CHƯA CÓ SERPER_API_KEY");
        return null;
    }
    try {
        const myHeaders = new Headers();
        myHeaders.append("X-API-KEY", SERPER_API_KEY);
        myHeaders.append("Content-Type", "application/json");

        const raw = JSON.stringify({ "q": query, "gl": "vn", "hl": "vi", "num": 5 });
        const requestOptions = { method: 'POST', headers: myHeaders, body: raw, redirect: 'follow' };
        
        const res = await fetch("https://google.serper.dev/search", requestOptions);
        if (!res.ok) throw new Error(`Lỗi Serper API: ${res.status}`);
        
        const data = await res.json();
        if (!data.organic || data.organic.length === 0) return null;

        let context = "";
        if (data.answerBox) context += `💡 TRẢ LỜI NHANH: ${data.answerBox.title || ""} - ${data.answerBox.snippet || data.answerBox.answer || ""}\n\n`;
        context += data.organic.map((r, index) => `[${index + 1}] ${r.title}\nLink: ${r.link}\nNội dung: ${r.snippet}`).join("\n\n");
        return context;
    } catch (e) {
        console.error("Lỗi tìm kiếm:", e.message);
        return null;
    }
}

// 7.2 Image Gen
async function generateImage(prompt) {
    const randomSeed = Math.floor(Math.random() * 1000000);
    const encodedPrompt = encodeURIComponent(prompt);
    const urls = [
        `https://image.pollinations.ai/prompt/${encodedPrompt}?model=flux&width=1024&height=1024&seed=${randomSeed}&nologo=true`,
        `https://image.pollinations.ai/prompt/${encodedPrompt}?model=turbo&seed=${randomSeed}&nologo=true`
    ];
    const agent = new https.Agent({ rejectUnauthorized: false });
    const tryFetchImage = async (url) => {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), 40000); 
        try {
            const res = await fetch(url, { agent: agent, signal: controller.signal });
            clearTimeout(id);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const arrayBuffer = await res.arrayBuffer();
            if (arrayBuffer.byteLength < 1000) throw new Error("Ảnh lỗi");
            return Buffer.from(arrayBuffer);
        } catch (error) {
            clearTimeout(id); throw error;
        }
    };
    for (let i = 0; i < urls.length; i++) {
        try { return { buffer: await tryFetchImage(urls[i]) }; } catch (err) {}
    }
    throw new Error("Server vẽ bận.");
}

// 7.3 Voice
async function generateVoice(text) {
  let attempts = voiceManager.keys.length > 0 ? voiceManager.keys.length : 1;
  while (attempts > 0) {
    try {
      const apiKey = voiceManager.getKey();
      const url = `https://api.voicerss.org/?key=${apiKey}&hl=vi-vn&c=MP3&f=44khz_16bit_stereo&src=${encodeURIComponent(text)}`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 300 && buffer.toString('utf-8').startsWith("ERROR")) throw new Error(buffer.toString('utf-8'));
      return buffer;
    } catch (error) {
      if (voiceManager.keys.length > 1) {
          console.warn(`⚠️ Voice Key lỗi: ${error.message}. Đang đổi Key...`);
          voiceManager.rotate(); attempts--; continue;
      }
      throw error;
    }
  }
  throw new Error("Tất cả Key VoiceRSS lỗi.");
}

// ================== 8. BOT HANDLER (FIXED CRASH & MEMORY) ==================

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
  const id = await addReminderToSheet(chatId, targetTime, note, type);
  return `✅ Đã hẹn: *${targetTime.format("HH:mm DD/MM")}*\n📝 ${note}`;
}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  let text = msg.text || msg.caption || "";
  const hasPhoto = msg.photo && msg.photo.length > 0;
  const hasDocument = msg.document;

  if (!text && !hasPhoto && !hasDocument) return;
  console.log(`📩 [${chatId}] ${text.substring(0, 30)}...`);

  if (text.trim() === "//") {
    setUserProcessing(chatId, false);
    return bot.sendMessage(chatId, "✅ Đã hủy tác vụ.");
  }
  
  if (text.toLowerCase().startsWith("/nn")) {
    const r = await handleReminderCommand(chatId, text);
    return bot.sendMessage(chatId, r, { parse_mode: "Markdown" });
  }
  if (text.toLowerCase() === "/bt") {
    bot.sendMessage(chatId, "⏳ Đang tải...");
    const all = await getRemindersFromSheet();
    const mine = all.filter(r => r.chatId == chatId);
    if (!mine.length) return bot.sendMessage(chatId, "📭 Trống.");
    let r = mine.map(i => `\n🆔 \`${i.id}\` | ⏰ ${moment(i.time).tz("Asia/Ho_Chi_Minh").format("HH:mm DD/MM")} | ${i.note}`).join("");
    return bot.sendMessage(chatId, `📋 **Danh sách:**\n${r}\n\n_Xóa: /dtb + mã_`, { parse_mode: "Markdown" });
  }
  if (text.toLowerCase().startsWith("/dtb")) {
    const id = text.replace(/\/dtb/i, "").trim();
    await deleteReminderFromSheet(id);
    return bot.sendMessage(chatId, `🗑️ Đã xóa mã \`${id}\`.`);
  }

  const state = getUserState(chatId);
  if (state.isProcessing) return bot.sendMessage(chatId, "⚠️ Đang bận (gõ `//` để hủy).");

  const reqId = Date.now();
  setUserProcessing(chatId, true, reqId);

  try {
    // 1. TẠO ẢNH
    if (text.match(/^\/img|^\/image/i)) {
      const prompt = text.replace(/^\/(img|image)\s*/i, "").trim();
      if(!prompt) { setUserProcessing(chatId, false); return bot.sendMessage(chatId, "⚠️ Thiếu mô tả ảnh."); }
      await bot.sendMessage(chatId, "🎨 Đang vẽ (FLUX)...");
      const img = await generateImage(prompt);
      if (getUserState(chatId).requestId === reqId) await bot.sendPhoto(chatId, img.buffer);
      setUserProcessing(chatId, false);
      return;
    }

    // 2. GIỌNG NÓI
    if (text.toLowerCase().startsWith("/voi")) {
      const contentToSpeak = text.replace(/^\/voi\s*/i, "").trim();
      if(!contentToSpeak) { setUserProcessing(chatId, false); return bot.sendMessage(chatId, "⚠️ Nhập nội dung cần đọc."); }
      await bot.sendChatAction(chatId, "record_voice");
      const audioBuffer = await generateVoice(contentToSpeak);
      if (getUserState(chatId).requestId === reqId) await bot.sendVoice(chatId, audioBuffer);
      setUserProcessing(chatId, false);
      return;
    }

    // 3. TÌM KIẾM
    let searchContext = null;
    if (text.toLowerCase().startsWith("/tim")) {
      const query = text.replace(/^\/tim\s*/i, "").trim();
      if(!query) { setUserProcessing(chatId, false); return bot.sendMessage(chatId, "⚠️ Nhập từ khóa."); }
      await bot.sendMessage(chatId, `🌐 Đang tìm: *${query}*...`, { parse_mode: "Markdown" });
      const searchResults = await performSearch(query);
      if (!searchResults) {
         if (getUserState(chatId).requestId === reqId) await bot.sendMessage(chatId, "❌ Không tìm thấy kết quả.");
         setUserProcessing(chatId, false);
         return;
      }
      searchContext = searchResults;
      text = `User tìm kiếm: "${query}". Tổng hợp câu trả lời chi tiết.`;
    }

    // 4. CHAT AI HYBRID
    let imageBuffer = null;
    if (hasDocument) await bot.sendMessage(chatId, "📂 Đang đọc file...");
    else if (hasPhoto) await bot.sendMessage(chatId, "👁️ Đang xem ảnh...");
    else bot.sendChatAction(chatId, "typing");

    if (hasPhoto) {
      const link = await bot.getFileLink(msg.photo[msg.photo.length - 1].file_id);
      const res = await fetchWithRetry(link);
      imageBuffer = Buffer.from(await res.arrayBuffer());
    }
    if (hasDocument) {
      if (msg.document.file_size > MAX_FILE_SIZE) throw new Error("File > 10MB.");
      const link = await bot.getFileLink(msg.document.file_id);
      const res = await fetchWithRetry(link);
      const content = Buffer.from(await res.arrayBuffer()).toString("utf-8");
      text += `\n\n[FILE: ${msg.document.file_name}]\n\`\`\`\n${content}\n\`\`\``;
    }

    if (getUserState(chatId).requestId !== reqId) return;

    // --- [NEW] CHUẨN BỊ CONTEXT (BỘ NHỚ NGẮN HẠN) ---
    // Chỉ lấy lịch sử khi không phải search/ảnh/file để tránh nhiễu
    let finalPrompt = text;
    let contextHistory = "";
    
    if (!searchContext && !imageBuffer && !hasDocument && !text.startsWith("/")) {
       contextHistory = contextManager.getFormattedContext(chatId);
       if (contextHistory) {
         // Ghép lịch sử vào prompt
         finalPrompt = `Dưới đây là lịch sử chat trước đó (để bạn hiểu ngữ cảnh):\n---\n${contextHistory}\n---\nCâu hỏi hiện tại của User: ${text}`;
       }
    }

    // --- CALL AI ---
    let ans = await askHybridAI(finalPrompt, imageBuffer, searchContext);

    // [FIX 4] CHỐNG CRASH TELEGRAM KHI AI TRẢ VỀ RỖNG
    if (!ans || ans.trim().length === 0) {
        ans = "⚠️ Các hệ thống AI đang bận hoặc không phản hồi. Vui lòng thử lại.";
    }

    if (getUserState(chatId).requestId === reqId) {
      const sendSafeMessage = async (contentStr) => {
        try { await bot.sendMessage(chatId, contentStr, { parse_mode: "Markdown" }); } 
        catch (e) { await bot.sendMessage(chatId, contentStr); } // Fallback text thường
      };
      
      // Chia nhỏ tin nhắn nếu quá dài
      if (ans.length > 4000) {
        const chunks = ans.match(/.{1,4000}/g) || [];
        for (const c of chunks) await sendSafeMessage(c);
      } else {
        await sendSafeMessage(ans);
      }
      
      // --- [NEW] LƯU VÀO BỘ NHỚ ---
      // Chỉ lưu nếu là chat thường
      if (!text.startsWith("/") && !searchContext && !imageBuffer) {
        contextManager.addMessage(chatId, text, 'user');
        contextManager.addMessage(chatId, ans, 'model');
      }
    }

  } catch (err) {
    console.error(`User ${chatId} Error:`, err.message);
    if (getUserState(chatId).requestId === reqId) bot.sendMessage(chatId, `❌ Lỗi: ${err.message}`);
  } finally {
    if (getUserState(chatId).requestId === reqId) setUserProcessing(chatId, false);
  }
});

// ================== 9. SERVER ==================
setInterval(async () => {
  const all = await getRemindersFromSheet();
  if (!all.length) return;
  const now = moment().tz("Asia/Ho_Chi_Minh");
  for (const r of all) {
    try {
      const target = moment(r.time);
      if (now.isSameOrAfter(target, 'minute')) {
        await bot.sendMessage(r.chatId, `⏰ **NHẮC:** ${r.note}`, { parse_mode: "Markdown" }).catch(() => {});
        await deleteReminderFromSheet(r.id);
        if (r.type === "DAILY") {
          await new Promise(res => setTimeout(res, 1000));
          await addReminderToSheet(r.chatId, target.add(1, "days"), r.note, "DAILY");
        }
      }
    } catch (e) {}
  }
}, 60000);

if (typeof SELF_PING_URL !== 'undefined' && SELF_PING_URL) {
  setInterval(() => fetch(SELF_PING_URL + "/health").catch(() => {}), 300000);
}

app.get("/", (req, res) => res.send("🤖 Bot V20.1 - MEMORY UPGRADE 🧠"));
app.get("/health", (req, res) => res.json({ status: "ok" }));
process.on('uncaughtException', (err) => console.error(err));
process.on('unhandledRejection', (reason) => console.error(reason));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));