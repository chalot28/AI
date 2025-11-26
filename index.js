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
  SERPER_API_KEY,    // KEY SERPER (TÌM KIẾM)
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
const MODEL_CHAT = "gemini-2.0-flash"; // Dùng bản Flash mới nhất cho nhanh

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const app = express();
app.use(express.json());

// ================== 2. QUẢN LÝ KEY (SMART ROTATION) ==================

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
          if (this.keys.length === 1) {
            await new Promise(r => setTimeout(r, 5000)); // Đợi 5s nếu chỉ có 1 key
            attempts--;
            continue;
          }
          this.rotate(); // Đổi key nếu có nhiều key
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

const chatManager = new KeyManager(GOOGLE_CHAT_KEYS, "CHAT-GEMINI");
const voiceManager = new VoiceKeyManager(VOICERSS_KEYS);

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

// ================== 6. AI & MEDIA LOGIC ==================

// 6.1 Chat Gemini (Xử lý Context từ Google Search)
async function askGemini(promptText, imageBuffer = null, searchContext = null) {
  return chatManager.executeWithRetry(async (client) => {
    const model = client.getGenerativeModel({ model: MODEL_CHAT });
    const parts = [];
    if (imageBuffer) parts.push(fileToGenerativePart(imageBuffer, "image/jpeg"));
    
    // Nếu có thông tin tìm kiếm, chèn vào prompt hệ thống
    let systemPrompt = "Bạn là trợ lý ảo thông minh.";
    if (searchContext) {
      systemPrompt += `\n[THÔNG TIN TỪ GOOGLE]\n${searchContext}\n\nHãy trả lời câu hỏi của người dùng dựa trên thông tin trên. Nếu có số liệu, hãy trích dẫn nguồn hoặc tiêu đề bài viết.`;
    }

    if (!promptText && imageBuffer) promptText = "Mô tả ảnh này.";
    parts.push({ text: `${systemPrompt}\n\nUser: ${promptText || "Xin chào"}` });
    
    const result = await model.generateContent(parts);
    return result.response.text();
  });
}

// 6.2 TÌM KIẾM GOOGLE (SERPER API) - QUAN TRỌNG NHẤT
async function performSearch(query) {
    if (!SERPER_API_KEY) {
        console.error("❌ CHƯA CÓ SERPER_API_KEY TRONG FILE .ENV");
        return null;
    }
    
    try {
        const myHeaders = new Headers();
        myHeaders.append("X-API-KEY", SERPER_API_KEY);
        myHeaders.append("Content-Type", "application/json");

        const raw = JSON.stringify({
            "q": query,
            "gl": "vn",    // Vị trí: Việt Nam
            "hl": "vi",    // Ngôn ngữ: Tiếng Việt
            "num": 5       // Lấy 5 kết quả
        });

        const requestOptions = {
            method: 'POST',
            headers: myHeaders,
            body: raw,
            redirect: 'follow'
        };

        // Gọi API Serper
        const res = await fetch("https://google.serper.dev/search", requestOptions);
        if (!res.ok) throw new Error(`Lỗi Serper API: ${res.status}`);
        
        const data = await res.json();
        
        // Kiểm tra kết quả
        if (!data.organic || data.organic.length === 0) return null;

        let context = "";
        
        // 1. Lấy câu trả lời nhanh (nếu có)
        if (data.answerBox) {
            context += `💡 TRẢ LỜI NHANH: ${data.answerBox.title || ""} - ${data.answerBox.snippet || data.answerBox.answer || ""}\n\n`;
        }
        
        // 2. Lấy danh sách bài viết (Title + Link + Snippet)
        context += data.organic.map((r, index) => 
            `[${index + 1}] ${r.title}\nLink: ${r.link}\nNội dung: ${r.snippet}`
        ).join("\n\n");

        return context;

    } catch (e) {
        console.error("Lỗi tìm kiếm Serper:", e.message);
        return null;
    }
}

// 6.3 Tạo ảnh (Flux - Pollinations)
async function generateImage(prompt) {
    const randomSeed = Math.floor(Math.random() * 1000000);
    const encodedPrompt = encodeURIComponent(prompt);
    
    // Danh sách nguồn vẽ dự phòng
    const urls = [
        `https://image.pollinations.ai/prompt/${encodedPrompt}?model=flux&width=1024&height=1024&seed=${randomSeed}&nologo=true`,
        `https://image.pollinations.ai/prompt/${encodedPrompt}?model=turbo&seed=${randomSeed}&nologo=true`,
        `https://image.pollinations.ai/prompt/${encodedPrompt}?seed=${randomSeed}&nologo=true`
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
            clearTimeout(id);
            throw error;
        }
    };

    for (let i = 0; i < urls.length; i++) {
        try {
            const buffer = await tryFetchImage(urls[i]);
            return { buffer: buffer };
        } catch (err) {
            // Thử link tiếp theo nếu lỗi
        }
    }
    throw new Error("Server vẽ đang bận, thử lại sau.");
}

// 6.4 Tạo giọng nói (VoiceRSS - Có xoay vòng)
async function generateVoice(text) {
  let attempts = voiceManager.keys.length > 0 ? voiceManager.keys.length : 1;
  while (attempts > 0) {
    try {
      const apiKey = voiceManager.getKey();
      const url = `https://api.voicerss.org/?key=${apiKey}&hl=vi-vn&c=MP3&f=44khz_16bit_stereo&src=${encodeURIComponent(text)}`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      
      // Check lỗi Text trả về thay vì Audio
      if (buffer.length < 300) {
         const errText = buffer.toString('utf-8');
         if (errText.startsWith("ERROR")) throw new Error(errText);
      }
      return buffer;
    } catch (error) {
      // Nếu lỗi do Key/Quota thì đổi Key
      if (voiceManager.keys.length > 1) {
          console.warn(`⚠️ Voice Key lỗi: ${error.message}. Đang đổi Key...`);
          voiceManager.rotate();
          attempts--;
          continue;
      }
      throw error;
    }
  }
  throw new Error("Tất cả Key VoiceRSS đều lỗi hoặc hết lượt.");
}

// ================== 7. XỬ LÝ TIN NHẮN (BOT HANDLER) ==================

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

  // Hủy tác vụ
  if (text.trim() === "//") {
    setUserProcessing(chatId, false);
    return bot.sendMessage(chatId, "✅ Đã hủy tác vụ.");
  }
  
  // === CÁC LỆNH HỆ THỐNG ===
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

  // === AI XỬ LÝ (Chat, Ảnh, Voice, Tìm kiếm) ===
  const state = getUserState(chatId);
  if (state.isProcessing) return bot.sendMessage(chatId, "⚠️ Đang bận (gõ `//` để hủy).");

  const reqId = Date.now();
  setUserProcessing(chatId, true, reqId);

  try {
    // 1. TẠO ẢNH (FLUX)
    if (text.match(/^\/img|^\/image/i)) {
      const prompt = text.replace(/^\/(img|image)\s*/i, "").trim();
      if(!prompt) { setUserProcessing(chatId, false); return bot.sendMessage(chatId, "⚠️ Thiếu mô tả ảnh."); }
      await bot.sendMessage(chatId, "🎨 Đang vẽ (Chế độ FLUX)...");
      
      const img = await generateImage(prompt);
      
      if (getUserState(chatId).requestId === reqId) {
        await bot.sendPhoto(chatId, img.buffer, { caption: `Prompt: ${prompt}\n✨ Model: FLUX` });
      }
      setUserProcessing(chatId, false);
      return;
    }

    // 2. GIỌNG NÓI (VOICE RSS)
    if (text.toLowerCase().startsWith("/voi")) {
      const contentToSpeak = text.replace(/^\/voi\s*/i, "").trim();
      if(!contentToSpeak) { setUserProcessing(chatId, false); return bot.sendMessage(chatId, "⚠️ Nhập nội dung cần đọc."); }
      await bot.sendChatAction(chatId, "record_voice");
      
      const audioBuffer = await generateVoice(contentToSpeak);
      
      if (getUserState(chatId).requestId === reqId) {
        await bot.sendVoice(chatId, audioBuffer);
      }
      setUserProcessing(chatId, false);
      return;
    }

    // 3. TÌM KIẾM GOOGLE (SERPER) - FEATURE MỚI
    let searchContext = null;
    if (text.toLowerCase().startsWith("/tim")) {
      const query = text.replace(/^\/tim\s*/i, "").trim();
      if(!query) { setUserProcessing(chatId, false); return bot.sendMessage(chatId, "⚠️ Nhập từ khóa cần tìm."); }
      
      await bot.sendMessage(chatId, `🌐 Đang tìm trên Google: *${query}*...`, { parse_mode: "Markdown" });
      
      const searchResults = await performSearch(query);
      
      if (!searchResults) {
         if (getUserState(chatId).requestId === reqId) await bot.sendMessage(chatId, "❌ Không tìm thấy kết quả hoặc lỗi Key Serper.");
         setUserProcessing(chatId, false);
         return;
      }
      
      // Lưu kết quả tìm kiếm vào biến context
      searchContext = searchResults;
      
      // Sửa lại câu hỏi để Gemini biết nhiệm vụ
      text = `User tìm kiếm: "${query}".\nDựa vào các kết quả tìm kiếm mới nhất dưới đây, hãy tổng hợp câu trả lời chi tiết và chính xác nhất cho User.`;
    }

    // 4. CHAT GEMINI (Và xử lý File/Ảnh)
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

    // Gọi Gemini (Truyền thêm searchContext nếu có)
    const ans = await askGemini(text, imageBuffer, searchContext);

    // ================== FIXED ERROR 400 HERE ==================
    if (getUserState(chatId).requestId === reqId) {
      
      // Hàm gửi tin nhắn an toàn (Tự động chuyển text thường nếu Markdown lỗi)
      const sendSafeMessage = async (contentStr) => {
        try {
          await bot.sendMessage(chatId, contentStr, { parse_mode: "Markdown" });
        } catch (e) {
          console.warn(`⚠️ Markdown lỗi (${e.message}), đang gửi lại dạng text thô...`);
          // Gửi lại không dùng parse_mode
          await bot.sendMessage(chatId, contentStr); 
        }
      };

      // Cắt tin nhắn nếu quá dài (Telegram giới hạn 4096 ký tự)
      if (ans.length > 4000) {
        const chunks = ans.match(/.{1,4000}/g) || [];
        for (const c of chunks) await sendSafeMessage(c);
      } else {
        await sendSafeMessage(ans);
      }
    }
    // ==========================================================

  } catch (err) {
    console.error(`User ${chatId} Error:`, err.message);
    if (getUserState(chatId).requestId === reqId) bot.sendMessage(chatId, `❌ Lỗi: ${err.message}`);
  } finally {
    if (getUserState(chatId).requestId === reqId) setUserProcessing(chatId, false);
  }
});

// ================== 8. SERVER & CRON JOB ==================
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

app.get("/", (req, res) => res.send("🤖 Bot V18 - FIX ERROR 400 🚀"));
app.get("/health", (req, res) => res.json({ status: "ok" }));
process.on('uncaughtException', (err) => console.error(err));
process.on('unhandledRejection', (reason) => console.error(reason));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));