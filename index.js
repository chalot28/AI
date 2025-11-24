// ================== LOAD ENV ==================
require("dotenv").config();

const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ================== FETCH POLYFILL (Node < 18) ==================
let fetchFn = global.fetch;
if (!fetchFn) {
  fetchFn = (...args) =>
    import("node-fetch").then(({ default: f }) => f(...args));
}
const fetch = fetchFn;

// ================== CẤU HÌNH CƠ BẢN ==================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const SELF_PING_URL = process.env.SELF_PING_URL;
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN) {
  console.error("❌ Thiếu TELEGRAM_TOKEN trong .env");
  process.exit(1);
}
if (!GOOGLE_API_KEY) {
  console.error("❌ Thiếu GOOGLE_API_KEY trong .env");
  process.exit(1);
}

// Telegram bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Google AI Studio (Gemini 2.5)
const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
const textModel = genAI.getGenerativeModel({
  model: "gemini-2.5-flash", 
});

// Express server
const app = express();
app.use(express.json());

// ================== LỌC TỪ CẤM ==================
const BLOCKED_WORDS = ["chửi thề", "phản động"]; // Thêm từ cấm của bạn

function containsBlockedWord(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return BLOCKED_WORDS.some((w) => lower.includes(w.toLowerCase()));
}

// ================== KỊCH BẢN CÓ SẴN (SCENARIOS) ==================
const SCENARIOS = [
  {
    name: "chao_hoi",
    pattern: /^(hi|hello|xin chào|chào bạn)/i,
    reply: "Chào bạn 👋, mình là bot hỗ trợ đây. Gõ /img + mô tả để tạo ảnh nhé!",
  },
];

function findScenario(text) {
  if (!text) return null;
  return SCENARIOS.find((s) => s.pattern.test(text));
}

// ================== KHO DỮ LIỆU TÍCH HỢP (KNOWLEDGE BASE) ==================
const KNOWLEDGE_BASE = [
  {
    keywords: ["liên hệ", "admin"],
    answer: "Liên hệ admin qua email: admin@example.com",
  },
];

function findInKnowledgeBase(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const item of KNOWLEDGE_BASE) {
    if (item.keywords.every((kw) => lower.includes(kw.toLowerCase()))) {
      return item.answer;
    }
  }
  return null;
}

// ================== HỎI GEMINI (TEXT) ==================
async function askGemini(question, extraContext = "") {
  try {
    const prompt = `
Bạn là trợ lý Telegram trả lời ngắn gọn, thân thiện bằng tiếng Việt.
Ngữ cảnh nội bộ: ${extraContext || "(không có)"}
Câu hỏi: ${question}
`;
    const result = await textModel.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    console.error("❌ Lỗi Gemini:", err);
    return "Hệ thống đang bận, thử lại sau nhé.";
  }
}

// ================== IMAGE PROVIDERS (ĐÃ SỬA) ==================

const hasDeepAI = !!process.env.DEEPAI_API_KEY;
const hasHF = !!process.env.HF_API_KEY;

const imageProviders = [
  // 1. Hugging Face (ĐÃ SỬA URL MỚI: router.huggingface.co)
  {
    name: "huggingface-sdxl",
    enabled: hasHF,
    generate: async (prompt) => {
      // Dùng URL router mới thay vì api-inference
      const res = await fetch(
        "https://router.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.HF_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ inputs: prompt }),
        }
      );

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HF_HTTP_${res.status}: ${text}`);
      }

      const arrayBuffer = await res.arrayBuffer();
      return { 
        type: "buffer", 
        buffer: Buffer.from(arrayBuffer), 
        mimeType: res.headers.get("content-type") || "image/png" 
      };
    },
  },

  // 2. Pollinations AI (MỚI THÊM - KHÔNG CẦN KEY - BACKUP CỰC TỐT)
  {
    name: "pollinations-ai",
    enabled: true, // Luôn bật vì miễn phí
    generate: async (prompt) => {
      // Mã hóa prompt để tránh lỗi ký tự đặc biệt
      const encodedPrompt = encodeURIComponent(prompt);
      const url = `https://image.pollinations.ai/prompt/${encodedPrompt}`;
      
      const res = await fetch(url);
      
      if (!res.ok) {
        throw new Error(`POLLINATIONS_HTTP_${res.status}`);
      }

      const arrayBuffer = await res.arrayBuffer();
      return {
        type: "buffer",
        buffer: Buffer.from(arrayBuffer),
        mimeType: "image/jpeg"
      };
    }
  },

  // 3. DeepAI (ĐÃ TẮT VÌ HẾT QUOTA/BẮT TRẢ TIỀN)
  {
    name: "deepai",
    enabled: false, // Đổi thành true nếu bạn nạp tiền cho DeepAI
    generate: async (prompt) => {
      const res = await fetch("https://api.deepai.org/api/text2img", {
        method: "POST",
        headers: {
          "api-key": process.env.DEEPAI_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: prompt }),
      });

      if (!res.ok) throw new Error(`DEEPAI_HTTP_${res.status}`);
      const data = await res.json();
      return { type: "url", url: data.output_url };
    },
  },
];

let currentImageProviderIndex = 0;

async function generateImageWithFallback(prompt) {
  const available = imageProviders.filter((p) => p.enabled);
  if (!available.length) throw new Error("NO_IMAGE_PROVIDERS_ENABLED");

  const total = available.length;
  // Logic thử lần lượt các provider
  for (let i = 0; i < total; i++) {
    const idx = (currentImageProviderIndex + i) % total;
    const provider = available[idx];

    console.log(`🎯 Thử provider: ${provider.name}`);

    try {
      // Timeout 30 giây để tránh treo bot
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      
      const result = await provider.generate(prompt, { signal: controller.signal });
      clearTimeout(timeout);

      currentImageProviderIndex = (idx + 1) % total;
      return { ...result, providerName: provider.name };
    } catch (err) {
      console.error(`⚠️ Provider ${provider.name} lỗi:`, err.message || err);
      continue;
    }
  }

  throw new Error("ALL_IMAGE_PROVIDERS_FAILED");
}

// ================== XỬ LÝ TIN NHẮN ==================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;

  console.log(`📩 [${chatId}] ${text}`);

  // 1. Xử lý lệnh tạo ảnh
  if (text.startsWith("/img") || text.startsWith("/image")) {
    const prompt = text.replace(/^\/(img|image)\s*/i, "").trim();
    
    if (!prompt) {
      await bot.sendMessage(chatId, "⚠️ Bạn chưa nhập mô tả. Ví dụ: `/img con mèo đang bay`");
      return;
    }

    await bot.sendMessage(chatId, "🎨 Đang vẽ tranh, chờ xíu nhé...");

    try {
      const result = await generateImageWithFallback(prompt);
      
      const caption = `🖼 Tranh của bạn đây!\n📝 Prompt: "${prompt}"\n⚡ Nguồn: ${result.providerName}`;

      if (result.type === "url") {
        await bot.sendPhoto(chatId, result.url, { caption });
      } else {
        await bot.sendPhoto(chatId, result.buffer, { caption });
      }
      console.log("✅ Đã gửi ảnh xong.");
    } catch (err) {
      console.error("❌ Lỗi tạo ảnh:", err);
      await bot.sendMessage(chatId, "😢 Xin lỗi, hệ thống vẽ tranh đang quá tải. Bạn thử lại sau nhé.");
    }
    return;
  }

  // 2. Các xử lý khác (Tắt bớt log để gọn)
  if (containsBlockedWord(text)) return bot.sendMessage(chatId, "⚠️ Ngôn từ không phù hợp.");
  
  const scenario = findScenario(text);
  if (scenario) return bot.sendMessage(chatId, scenario.reply);

  const kbAnswer = findInKnowledgeBase(text);
  if (kbAnswer) return bot.sendMessage(chatId, kbAnswer);

  // 3. Chat với Gemini
  const answer = await askGemini(text);
  await bot.sendMessage(chatId, answer, { parse_mode: "Markdown" });
});

// ================== KEEP-ALIVE & SERVER ==================
if (SELF_PING_URL) {
  setInterval(async () => {
    try {
      await fetch(`${SELF_PING_URL.replace(/\/$/, "")}/health`);
      // console.log("Ping thành công"); // Tắt log ping cho đỡ rối
    } catch (e) {}
  }, 4 * 60 * 1000);
}

app.get("/", (req, res) => res.send("Bot đang chạy ngon lành! 🚀"));
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy trên cổng ${PORT}`);
});