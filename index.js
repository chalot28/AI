// ================== 1. LOAD THƯ VIỆN & CẤU HÌNH ==================
require("dotenv").config();
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const moment = require("moment-timezone");

// Fix lỗi fetch cho Node cũ
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

const {
  TELEGRAM_TOKEN,
  GOOGLE_API_KEY,
  SELF_PING_URL,
  GOOGLE_APP_SCRIPT_URL: GAS_URL,
  PORT = 3000
} = process.env;

if (!TELEGRAM_TOKEN || !GOOGLE_API_KEY || !GAS_URL) {
  console.error("❌ LỖI: Thiếu Token, Key hoặc Link Google Script trong file .env");
  process.exit(1);
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; 
const REQUEST_TIMEOUT = 15000;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 

const app = express();
app.use(express.json());

// ================== 2. CÁC HÀM TIỆN ÍCH ==================

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

// ================== 3. KẾT NỐI GOOGLE SHEETS ==================

async function getRemindersFromSheet() {
  try {
    const res = await fetchWithTimeout(GAS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error("⚠️ Lỗi đọc Sheet:", e.message);
    return [];
  }
}

async function addReminderToSheet(chatId, targetTime, note, type) {
  const id = Date.now().toString().slice(-6);
  const payload = {
    action: "add",
    id: id,
    chatId: chatId,
    time: targetTime.toISOString(),
    note: note,
    type: type
  };
  fetchWithTimeout(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).catch(e => console.error("⚠️ Lỗi ghi Sheet:", e.message));
  return id;
}

async function deleteReminderFromSheet(id) {
  fetchWithTimeout(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete", id: id })
  }).catch(e => console.error("⚠️ Lỗi xóa Sheet:", e.message));
}

// ================== 4. QUẢN LÝ TRẠNG THÁI & AI ==================

const userStates = new Map();
function setUserProcessing(chatId, isProcessing, requestId = 0) {
  if (!isProcessing) userStates.delete(chatId);
  else userStates.set(chatId, { isProcessing, requestId });
}
function getUserState(chatId) {
  return userStates.get(chatId) || { isProcessing: false, requestId: 0 };
}

async function askGemini(promptText, imageBuffer = null) {
  try {
    const parts = [];
    if (imageBuffer) parts.push(fileToGenerativePart(imageBuffer, "image/jpeg"));
    if (!promptText && imageBuffer) promptText = "Mô tả chi tiết bức ảnh này.";
    parts.push({ text: `Bạn là trợ lý ảo hữu ích. Trả lời ngắn gọn. User: ${promptText || "Xin chào"}` });
    const result = await geminiModel.generateContent(parts);
    return result.response.text();
  } catch (err) {
    console.error("Gemini Error:", err.message);
    return "Hệ thống đang bận hoặc nội dung bị chặn.";
  }
}

async function generateImage(prompt) {
  try {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error("API Error");
    return { buffer: Buffer.from(await res.arrayBuffer()) };
  } catch (e) {
    throw new Error("Không thể vẽ tranh lúc này.");
  }
}

// ================== 5. XỬ LÝ LOGIC LỆNH (/nn) ==================

async function handleReminderCommand(chatId, text) {
  const content = text.replace(/^\/nn\s*/i, "").trim();
  if (!content) return "⚠️ Sai cú pháp.\nVD: `/nn 9:30` (mỗi ngày)\nVD: `/nn 10:30/24/11 đi họp` (1 lần)";

  const parts = content.split(" ");
  const timeStr = parts[0];
  const note = parts.slice(1).join(" ") || "Đến giờ rồi! ⏰";

  let targetTime = moment().tz("Asia/Ho_Chi_Minh");
  let type = "ONE_TIME";

  if (timeStr.includes("/")) {
    const [t, d, m] = timeStr.split("/");
    const timeObj = parseTime(t);
    if (!timeObj || isNaN(parseInt(d)) || isNaN(parseInt(m))) return "❌ Định dạng sai.";
    targetTime.hour(timeObj.h).minute(timeObj.m).second(0).date(d).month(m - 1);
    if (targetTime.isBefore(moment())) targetTime.add(1, 'year');
    type = "ONE_TIME";
  } else {
    const timeObj = parseTime(timeStr);
    if (!timeObj) return "❌ Giờ sai.";
    targetTime.hour(timeObj.h).minute(timeObj.m).second(0);
    if (targetTime.isBefore(moment())) targetTime.add(1, "days");
    type = "DAILY";
  }

  const id = await addReminderToSheet(chatId, targetTime, note, type);
  const timeDisplay = targetTime.format("HH:mm DD/MM/YYYY");
  const typeDisplay = type === "DAILY" ? "Mỗi ngày" : "Một lần";
  return `✅ Đã lưu Reminder!\n⏰ Hẹn: *${timeDisplay}*\n📝 Note: ${note}\n🔄 Loại: ${typeDisplay}\n🆔 Mã: \`${id}\``;
}

// ================== 6. BOT MESSAGE HANDLER (MAIN) ==================

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  let text = msg.text || msg.caption || "";
  const hasPhoto = msg.photo && msg.photo.length > 0;
  const hasDocument = msg.document;

  if (!text && !hasPhoto && !hasDocument) return;
  console.log(`📩 [${chatId}] ${text.substring(0, 50)}...`);

  // --- A. LỆNH HỆ THỐNG & HỦY (KHÔNG BAO GIỜ BỊ KHÓA) ---

  // 1. Hủy tác vụ
  if (text.trim() === "//") {
    setUserProcessing(chatId, false); // Mở khóa ngay lập tức
    return bot.sendMessage(chatId, "✅ Đã hủy trạng thái bận. Bạn có thể chat tiếp.");
  }

  // 2. Lệnh nhắc nhở (/nn)
  if (text.toLowerCase().startsWith("/nn")) {
    // Lệnh này chạy độc lập, KHÔNG check trạng thái bận
    const reply = await handleReminderCommand(chatId, text);
    return bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
  }

  // 3. Lệnh xem nhắc nhở (/bt)
  if (text.toLowerCase() === "/bt") {
    bot.sendMessage(chatId, "⏳ Đang tải dữ liệu...");
    const all = await getRemindersFromSheet();
    const mine = all.filter(r => r.chatId == chatId);
    if (!mine.length) return bot.sendMessage(chatId, "📭 Bạn không có lịch nhắc nào.");
    let reply = `📋 **Danh sách (${mine.length}):**\n`;
    mine.forEach(r => {
      const t = moment(r.time).tz("Asia/Ho_Chi_Minh").format("HH:mm DD/MM");
      reply += `\n🆔 \`${r.id}\` | ⏰ ${t} | 📝 ${r.note}`;
    });
    reply += `\n\n_Xóa: /dtb + mã_`;
    return bot.sendMessage(chatId, reply, { parse_mode: "Markdown" });
  }

  // 4. Lệnh xóa nhắc nhở (/dtb)
  if (text.toLowerCase().startsWith("/dtb")) {
    const id = text.replace(/\/dtb/i, "").trim();
    if(!id) return bot.sendMessage(chatId, "⚠️ Nhập mã cần xóa. VD: `/dtb 123456`");
    await deleteReminderFromSheet(id);
    return bot.sendMessage(chatId, `🗑️ Đã gửi lệnh xóa mã \`${id}\`.`);
  }

  // --- B. XỬ LÝ AI (CÓ QUEUE - CẦN KHÓA) ---
  
  // Kiểm tra xem có đang bận không
  const state = getUserState(chatId);
  if (state.isProcessing) {
    return bot.sendMessage(chatId, "⚠️ Đang xử lý lệnh trước... (gõ `//` nếu muốn hủy ngay).");
  }

  // Bắt đầu KHÓA
  const reqId = Date.now();
  setUserProcessing(chatId, true, reqId);

  try {
    // 1. Vẽ tranh (/img)
    if (text.match(/^\/img|^\/image/i)) {
      const prompt = text.replace(/^\/(img|image)\s*/i, "").trim();
      if (!prompt) {
        await bot.sendMessage(chatId, "⚠️ Thiếu nội dung vẽ.");
      } else {
        await bot.sendMessage(chatId, "🎨 Đang vẽ...");
        const img = await generateImage(prompt);
        // Chỉ gửi nếu chưa bị hủy
        if (getUserState(chatId).requestId === reqId) {
          await bot.sendPhoto(chatId, img.buffer, { caption: prompt });
        }
      }
      // QUAN TRỌNG: Mở khóa ngay sau khi xong việc vẽ
      setUserProcessing(chatId, false); 
      return; 
    }

    // 2. Chat Gemini (Text/Image/File)
    let imageBuffer = null;
    
    // Tải dữ liệu (Có thể lâu)
    if (hasDocument) await bot.sendMessage(chatId, "📂 Đang đọc file code (giới hạn 10MB)...");
    else if (hasPhoto) await bot.sendMessage(chatId, "👁️ Đang xem ảnh...");
    else bot.sendChatAction(chatId, "typing");

    if (hasPhoto) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const link = await bot.getFileLink(fileId);
      const res = await fetchWithTimeout(link);
      imageBuffer = Buffer.from(await res.arrayBuffer());
    }

    if (hasDocument) {
      if (msg.document.file_size > MAX_FILE_SIZE) throw new Error("File quá lớn (>10MB).");
      const link = await bot.getFileLink(msg.document.file_id);
      const res = await fetchWithTimeout(link);
      const content = Buffer.from(await res.arrayBuffer()).toString("utf-8");
      text += `\n\n[FILE CONTENT: ${msg.document.file_name}]\n\`\`\`\n${content}\n\`\`\``;
    }

    // Check hủy trước khi gọi AI
    if (getUserState(chatId).requestId !== reqId) return;

    // Gọi AI
    const ans = await askGemini(text, imageBuffer);

    // Gửi kết quả và MỞ KHÓA
    if (getUserState(chatId).requestId === reqId) {
      if (ans.length > 4000) {
        const chunks = ans.match(/.{1,4000}/g) || [];
        for (const c of chunks) await bot.sendMessage(chatId, c, { parse_mode: "Markdown" });
      } else {
        await bot.sendMessage(chatId, ans, { parse_mode: "Markdown" });
      }
    }
  } catch (err) {
    console.error(`Error User ${chatId}:`, err.message);
    if (getUserState(chatId).requestId === reqId) {
      bot.sendMessage(chatId, `❌ Lỗi: ${err.message}`);
    }
  } finally {
    // Đảm bảo luôn mở khóa dù có lỗi hay không (Chỉ mở nếu đúng là phiên của mình)
    if (getUserState(chatId).requestId === reqId) {
      setUserProcessing(chatId, false);
    }
  }
});

// ================== 7. CRON JOB ==================
setInterval(async () => {
  const all = await getRemindersFromSheet();
  if (!all.length) return;
  const now = moment().tz("Asia/Ho_Chi_Minh");
  for (const r of all) {
    try {
      const target = moment(r.time);
      if (now.isSameOrAfter(target, 'minute')) {
        await bot.sendMessage(r.chatId, `⏰ **NHẮC NHỞ:**\n${r.note}`, { parse_mode: "Markdown" }).catch(() => {});
        await deleteReminderFromSheet(r.id);
        if (r.type === "DAILY") {
          const nextTime = target.add(1, "days");
          await new Promise(res => setTimeout(res, 1000)); 
          await addReminderToSheet(r.chatId, nextTime, r.note, "DAILY");
        }
      }
    } catch (e) { console.error("Cron Error:", e.message); }
  }
}, 60 * 1000);

// ================== 8. SERVER ==================
if (SELF_PING_URL) setInterval(() => fetch(SELF_PING_URL + "/health").catch(() => {}), 5 * 60 * 1000);

app.get("/", (req, res) => res.send("🤖 Bot V5 - Stable & No Lock Bug 🚀"));
app.get("/health", (req, res) => res.json({ status: "ok" }));

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason, promise) => console.error('Unhandled Rejection:', reason));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));