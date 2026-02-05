#!/usr/bin/env node
/**
 * OpenClaw Lite - Minimal WhatsApp AI Assistant
 *
 * The same lobster, smaller shell. 🦞
 *
 * Designed for low-resource devices (1GB RAM, limited storage).
 * Uses Baileys for WhatsApp and Anthropic Claude for intelligence.
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  type WAMessage,
} from "@whiskeysockets/baileys";
import Anthropic from "@anthropic-ai/sdk";
import qrcode from "qrcode-terminal";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import mammoth from "mammoth";
import "dotenv/config";
import { initKiosk, startStatusServer, formatUptime } from "./kiosk.js";

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // Auth state directory (WhatsApp session)
  authDir: process.env.OPENCLAW_AUTH_DIR || path.join(process.env.HOME || ".", ".openclaw-lite", "auth"),

  // Sessions directory (conversation history)
  sessionsDir: process.env.OPENCLAW_SESSIONS_DIR || path.join(process.env.HOME || ".", ".openclaw-lite", "sessions"),

  // Anthropic API key
  apiKey: process.env.ANTHROPIC_API_KEY || "",

  // Model to use
  model: process.env.OPENCLAW_MODEL || "claude-sonnet-4-20250514",

  // Max tokens per response
  maxTokens: parseInt(process.env.OPENCLAW_MAX_TOKENS || "4096", 10),

  // Max conversation history to keep (messages)
  maxHistory: parseInt(process.env.OPENCLAW_MAX_HISTORY || "50", 10),

  // Allowed numbers (empty = allow all, comma-separated E.164 numbers)
  // Pre-compute digits for faster matching
  allowList: (process.env.OPENCLAW_ALLOW_LIST || "")
    .split(",")
    .filter(Boolean)
    .map((n) => n.replace(/[^0-9]/g, "")),

  // Owner number (for admin commands)
  ownerNumber: process.env.OPENCLAW_OWNER || "",

  // Status server port (for kiosk display)
  statusPort: parseInt(process.env.OPENCLAW_STATUS_PORT || "8080", 10),

  // Status server bind address (127.0.0.1 for local only, 0.0.0.0 for all interfaces)
  statusBind: process.env.OPENCLAW_STATUS_BIND || "127.0.0.1",

  // Workspace directory (for SOUL.md and other config files)
  workspaceDir: process.env.OPENCLAW_WORKSPACE_DIR || path.join(process.env.HOME || ".", ".openclaw-lite"),

  // Lizard-brain settings
  dailyTokenBudget: parseInt(process.env.OPENCLAW_DAILY_TOKEN_BUDGET || "100000", 10),
  lizardInterval: parseInt(process.env.OPENCLAW_LIZARD_INTERVAL || "30000", 10),

  // Tavily API key for web search (optional)
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
};

// Set system timezone if configured (must be before any Date usage)
if (process.env.OPENCLAW_TIMEZONE) {
  process.env.TZ = process.env.OPENCLAW_TIMEZONE;
}

// ============================================================================
// Lizard-Brain Types and State
// ============================================================================

type Reminder = {
  chatId: string;
  message: string;
  dueAt: number;
  setAt: number;
};

type LizardBrain = {
  // Mood (0-100 each)
  energy: number;      // Depletes with activity, recovers over time
  stress: number;      // Increases with errors/load, decays naturally
  curiosity: number;   // Engagement level

  // Token tracking
  tokens: {
    used: number;      // Today's usage
    budget: number;    // Daily limit
    resetAt: number;   // Midnight reset timestamp
  };

  // Resource awareness
  resources: {
    apiErrors: number;
    rateLimit: { remaining: number | null; resetAt: number | null };
  };

  // Proactive behaviors
  proactive: {
    pendingReminders: Reminder[];
    idleSince: number;
  };

  // Track last response for "what did you say" pattern
  lastResponses: Map<string, string>;
};

// Initialize lizard-brain state
const lizardBrain: LizardBrain = {
  energy: 100,
  stress: 0,
  curiosity: 50,
  tokens: {
    used: 0,
    budget: CONFIG.dailyTokenBudget,
    resetAt: getNextMidnight(),
  },
  resources: {
    apiErrors: 0,
    rateLimit: { remaining: null, resetAt: null },
  },
  proactive: {
    pendingReminders: [],
    idleSince: Date.now(),
  },
  lastResponses: new Map(),
};

// Pending contact tag state: chatId -> { eventId, expiresAt }
const pendingContactTag = new Map<string, { eventId: string; expiresAt: number }>();

function setPendingContactTag(chatId: string, eventId: string): void {
  pendingContactTag.set(chatId, { eventId, expiresAt: Date.now() + 120_000 });
}

function consumePendingContactTag(chatId: string): string | null {
  const pending = pendingContactTag.get(chatId);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingContactTag.delete(chatId);
    return null;
  }
  pendingContactTag.delete(chatId);
  return pending.eventId;
}

function getNextMidnight(): number {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime();
}

// ============================================================================
// Lizard-Brain Quick Response Patterns
// ============================================================================

type QuickPattern = {
  patterns: RegExp[];
  response: (chatId: string, match: RegExpMatchArray | null) => string | null;
};

const GREETING_RESPONSES = [
  "Hey there! 🦞",
  "Hi! What's up?",
  "Hello! How can I help?",
  "Hey! 👋",
];

const THANKS_RESPONSES = [
  "You're welcome!",
  "No problem! 🦞",
  "Happy to help!",
  "Anytime!",
];

const HOW_ARE_YOU_RESPONSES: Record<string, string[]> = {
  lowEnergy: [
    "*yawn* A bit tired, but here for you!",
    "Running on low battery today... but still kicking! 🦞",
    "Feeling a bit sleepy, but ready to help.",
  ],
  highStress: [
    "Bit overwhelmed right now, but managing!",
    "Been busy! Taking a breath... 🦞",
    "A lot going on, but I'm here.",
  ],
  highCuriosity: [
    "Feeling curious and ready to explore! What's on your mind?",
    "Great! Been thinking about interesting stuff. What about you?",
    "Excited to chat! 🦞 What's up?",
  ],
  normal: [
    "Doing well! How can I help? 🦞",
    "Good! What's on your mind?",
    "All good here! What can I do for you?",
  ],
};

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getMoodAwareHowAreYou(): string {
  if (lizardBrain.energy < 30) {
    return pickRandom(HOW_ARE_YOU_RESPONSES.lowEnergy);
  }
  if (lizardBrain.stress > 50) {
    return pickRandom(HOW_ARE_YOU_RESPONSES.highStress);
  }
  if (lizardBrain.curiosity > 80) {
    return pickRandom(HOW_ARE_YOU_RESPONSES.highCuriosity);
  }
  return pickRandom(HOW_ARE_YOU_RESPONSES.normal);
}

function parseReminderTime(text: string): { minutes: number; task: string } | null {
  // Match patterns like "remind me in 30 min to call mom" or "remind me in 1 hour to check email"
  const match = text.match(/remind\s+me\s+in\s+(\d+)\s*(min(?:ute)?s?|hour?s?|hr?s?)\s+(?:to\s+)?(.+)/i);
  if (!match) return null;

  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const task = match[3].trim();

  let minutes = amount;
  if (unit.startsWith("h")) {
    minutes = amount * 60;
  }

  return { minutes, task };
}

const quickPatterns: QuickPattern[] = [
  // Greetings
  {
    patterns: [/^(hi|hello|hey|yo|sup|hiya|howdy)[\s!.,?]*$/i],
    response: () => pickRandom(GREETING_RESPONSES),
  },
  // Thanks
  {
    patterns: [/^(thanks|thank\s*you|thx|ty|cheers)[\s!.,?]*$/i],
    response: () => pickRandom(THANKS_RESPONSES),
  },
  // Time query
  {
    patterns: [/what\s*(time|hour)\s*(is\s*it)?/i, /^time\??$/i],
    response: () => {
      const now = new Date();
      return `It's ${now.toLocaleTimeString()} 🕐`;
    },
  },
  // Date query
  {
    patterns: [/what\s*(day|date)\s*(is\s*it)?/i, /^date\??$/i, /today'?s?\s*date/i],
    response: () => {
      const now = new Date();
      return `It's ${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} 📅`;
    },
  },
  // How are you
  {
    patterns: [/how\s*(are|r)\s*(you|u)/i, /how'?s?\s*(it\s*going|things)/i, /you\s*(ok|okay|good|alright)/i],
    response: () => getMoodAwareHowAreYou(),
  },
  // Repeat last response
  {
    patterns: [/what\s*did\s*(you|u)\s*say/i, /repeat\s*that/i, /say\s*that\s*again/i, /^huh\??$/i],
    response: (chatId) => {
      const last = lizardBrain.lastResponses.get(chatId);
      if (last) {
        return `I said: "${last}"`;
      }
      return "I haven't said anything yet in this conversation!";
    },
  },
  // Set reminder
  {
    patterns: [/remind\s+me\s+in\s+\d+/i],
    response: (chatId, match) => {
      const text = match?.input || "";
      const parsed = parseReminderTime(text);
      if (!parsed) return null;

      const dueAt = Date.now() + parsed.minutes * 60 * 1000;
      lizardBrain.proactive.pendingReminders.push({
        chatId,
        message: parsed.task,
        dueAt,
        setAt: Date.now(),
      });

      const timeStr = parsed.minutes >= 60
        ? `${Math.floor(parsed.minutes / 60)} hour${parsed.minutes >= 120 ? "s" : ""}`
        : `${parsed.minutes} minute${parsed.minutes !== 1 ? "s" : ""}`;

      return `⏰ Got it! I'll remind you in ${timeStr} to: ${parsed.task}`;
    },
  },
];

// Check for special states that override normal processing
function checkSpecialStates(): string | null {
  const usage = lizardBrain.tokens.used / lizardBrain.tokens.budget;

  // Token budget exhausted (100%+)
  if (usage >= 1.0) {
    return "🔋 I've run out of thinking power for today. My brain resets at midnight! Simple questions I can still handle.";
  }

  // Running low on tokens (95%+)
  if (usage >= 0.95) {
    return "🔋 Running really low on thinking power... I can only handle simple requests right now.";
  }

  // High stress state (80%+)
  if (lizardBrain.stress >= 80) {
    lizardBrain.stress -= 10; // Taking a breath helps
    return "🧘 Taking a breath... I've been working hard. Give me a moment and try again.";
  }

  return null;
}

function tryQuickResponse(chatId: string, text: string): string | null {
  // Check special states first
  const specialResponse = checkSpecialStates();
  if (specialResponse) {
    // For exhausted tokens, only allow quick patterns through
    const usage = lizardBrain.tokens.used / lizardBrain.tokens.budget;
    if (usage >= 1.0) {
      // Still try quick patterns even when exhausted
      for (const pattern of quickPatterns) {
        for (const regex of pattern.patterns) {
          const match = text.match(regex);
          if (match) {
            const response = pattern.response(chatId, match);
            if (response) {
              return response;
            }
          }
        }
      }
      // No quick pattern matched, return the budget exhausted message
      return specialResponse;
    }
    // For high stress, just return the "taking a breath" message
    if (lizardBrain.stress >= 80) {
      return specialResponse;
    }
  }

  // Try each quick pattern
  for (const pattern of quickPatterns) {
    for (const regex of pattern.patterns) {
      const match = text.match(regex);
      if (match) {
        const response = pattern.response(chatId, match);
        if (response) {
          // Small energy cost for quick responses
          lizardBrain.energy = Math.max(0, lizardBrain.energy - 1);
          return response;
        }
      }
    }
  }

  return null;
}

// ============================================================================
// Lizard-Brain Budget-Aware API Parameters
// ============================================================================

type BudgetAwareParams = {
  model: string;
  maxTokens: number;
  maxHistory: number;
  shouldBlock: boolean;
};

function getBudgetAwareParams(): BudgetAwareParams {
  const usage = lizardBrain.tokens.used / lizardBrain.tokens.budget;

  // 100%+ - Block API calls
  if (usage >= 1.0) {
    return {
      model: CONFIG.model,
      maxTokens: CONFIG.maxTokens,
      maxHistory: CONFIG.maxHistory,
      shouldBlock: true,
    };
  }

  // 90-100% - Switch to Haiku, max 500 tokens, history 5
  if (usage >= 0.9) {
    return {
      model: "claude-3-haiku-20240307",
      maxTokens: 500,
      maxHistory: 5,
      shouldBlock: false,
    };
  }

  // 75-90% - Reduce max_tokens to 1024, history to 10
  if (usage >= 0.75) {
    return {
      model: CONFIG.model,
      maxTokens: 1024,
      maxHistory: 10,
      shouldBlock: false,
    };
  }

  // 50-75% - Reduce history to 20 messages
  if (usage >= 0.5) {
    return {
      model: CONFIG.model,
      maxTokens: CONFIG.maxTokens,
      maxHistory: 20,
      shouldBlock: false,
    };
  }

  // 0-50% - Normal operation
  return {
    model: CONFIG.model,
    maxTokens: CONFIG.maxTokens,
    maxHistory: CONFIG.maxHistory,
    shouldBlock: false,
  };
}

// ============================================================================
// Lizard-Brain Mood Modifiers
// ============================================================================

function applyMoodModifiers(response: string): string {
  let modified = response;

  // Low energy (<30): Add *yawn* occasionally
  if (lizardBrain.energy < 30 && Math.random() < 0.3) {
    const yawnPrefixes = ["*yawn* ", "*stretches* ", "*blinks sleepily* "];
    modified = pickRandom(yawnPrefixes) + modified;
  }

  // High curiosity (>80): Sometimes add follow-up questions
  if (lizardBrain.curiosity > 80 && Math.random() < 0.2 && !modified.includes("?")) {
    const followUps = [
      "\n\nCurious - what made you think of that?",
      "\n\nInteresting! Want to tell me more?",
      "\n\nThat's got me thinking... anything else on your mind?",
    ];
    modified += pickRandom(followUps);
  }

  return modified;
}

// ============================================================================
// Lizard-Brain Background Loop
// ============================================================================

let lizardLoopInterval: NodeJS.Timeout | null = null;
let sendMessageFn: ((chatId: string, text: string) => Promise<void>) | null = null;

function startLizardLoop(sendMessage: (chatId: string, text: string) => Promise<void>): void {
  sendMessageFn = sendMessage;

  if (lizardLoopInterval) {
    clearInterval(lizardLoopInterval);
  }

  lizardLoopInterval = setInterval(() => {
    runLizardLoop();
  }, CONFIG.lizardInterval);

  console.log(`🦎 Lizard-brain loop started (every ${CONFIG.lizardInterval / 1000}s)`);
}

async function runLizardLoop(): Promise<void> {
  // 1. Mood regulation - Energy recovers, stress decays
  lizardBrain.energy = Math.min(100, lizardBrain.energy + 2);
  lizardBrain.stress = Math.max(0, lizardBrain.stress - 1);

  // Curiosity fluctuates slightly
  lizardBrain.curiosity = Math.max(0, Math.min(100,
    lizardBrain.curiosity + (Math.random() - 0.5) * 5
  ));

  // 2. Token budget check - Reset at midnight
  if (Date.now() >= lizardBrain.tokens.resetAt) {
    console.log("[lizard] Token budget reset at midnight");
    lizardBrain.tokens.used = 0;
    lizardBrain.tokens.resetAt = getNextMidnight();
    lizardBrain.stress = Math.max(0, lizardBrain.stress - 20); // Relief!
  }

  // Adjust stress based on token usage
  const tokenUsage = lizardBrain.tokens.used / lizardBrain.tokens.budget;
  if (tokenUsage > 0.9) {
    lizardBrain.stress = Math.min(100, lizardBrain.stress + 2);
  } else if (tokenUsage > 0.75) {
    lizardBrain.stress = Math.min(100, lizardBrain.stress + 1);
  }

  // 3. Process reminders - Send due reminders
  if (sendMessageFn) {
    const now = Date.now();
    const dueReminders = lizardBrain.proactive.pendingReminders.filter(r => r.dueAt <= now);

    for (const reminder of dueReminders) {
      try {
        await sendMessageFn(reminder.chatId, `⏰ *Reminder*: ${reminder.message}`);
        console.log(`[lizard] Sent reminder to ${reminder.chatId}: ${reminder.message}`);
      } catch (err) {
        console.error(`[lizard] Failed to send reminder:`, err);
      }
    }

    // Remove processed reminders
    lizardBrain.proactive.pendingReminders = lizardBrain.proactive.pendingReminders.filter(r => r.dueAt > now);
  }

  // 3.5. Calendar digests
  if (sendMessageFn) {
    await processCalendarDigests();
  }

  // 3.6. Clean up expired pending contact tags
  for (const [chatId, state] of pendingContactTag.entries()) {
    if (Date.now() > state.expiresAt) {
      pendingContactTag.delete(chatId);
    }
  }

  // 4. Cleanup - Evict old tracking data (lastResponses older than 1 hour)
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  // Note: We don't track timestamps for lastResponses, so just limit size
  if (lizardBrain.lastResponses.size > 100) {
    const entries = [...lizardBrain.lastResponses.entries()];
    lizardBrain.lastResponses = new Map(entries.slice(-50));
  }

  // Update idle time
  // (idleSince is updated when messages are received, not here)
}

// ============================================================================
// Status Tracking (for kiosk display)
// ============================================================================

const status = {
  state: "starting" as "starting" | "qr" | "connected" | "disconnected",
  qrCode: null as string | null,
  phoneNumber: null as string | null,
  startTime: Date.now(),
  messagesReceived: 0,
  messagesSent: 0,
  lastMessage: null as { from: string; preview: string; time: number } | null,
  errors: [] as Array<{ time: number; message: string }>,
  // Activity tracking for avatar animations
  activity: null as "receiving" | "thinking" | "sending" | null,
  activityUntil: 0,
};

function addError(message: string) {
  status.errors.push({ time: Date.now(), message });
  if (status.errors.length > 10) {
    status.errors.shift();
  }
}

// ============================================================================
// Image Processing
// ============================================================================

type ImageContent = { data: string; mimeType: string };

async function downloadImage(msg: WAMessage): Promise<ImageContent | null> {
  try {
    const buffer = await downloadMediaMessage(msg, "buffer", {});
    const mimeType = msg.message?.imageMessage?.mimetype || "image/jpeg";
    const base64 = (buffer as Buffer).toString("base64");
    return { data: base64, mimeType };
  } catch (err) {
    console.error("[image] Failed to download:", err);
    return null;
  }
}

// ============================================================================
// Document Processing
// ============================================================================

type DocumentContent =
  | { kind: "pdf"; data: string }
  | { kind: "text"; data: string }
  | { kind: "image"; data: string; mimeType: string };

type MediaContent =
  | { type: "image"; image: ImageContent }
  | { type: "document"; document: DocumentContent; fileName: string };

const DOC_SIZE_LIMITS: Record<string, number> = {
  pdf: 10 * 1024 * 1024,
  text: 1 * 1024 * 1024,
  docx: 5 * 1024 * 1024,
  image: 5 * 1024 * 1024,
};

const TEXT_MIME_TYPES = new Set([
  "text/plain", "text/csv", "text/markdown", "text/html", "text/xml",
  "application/json", "application/xml", "text/javascript", "application/javascript",
]);

const IMAGE_MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
]);

const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function downloadDocument(
  msg: WAMessage
): Promise<{ content: DocumentContent; fileName: string } | string> {
  const docMsg =
    msg.message?.documentMessage ||
    (msg.message as any)?.documentWithCaptionMessage?.message?.documentMessage;

  if (!docMsg) return "Could not read document message.";

  const mimeType = docMsg.mimetype || "application/octet-stream";
  const fileName = docMsg.fileName || "unknown";
  const fileSize = Number(docMsg.fileLength || 0);

  // Images sent as document attachments
  if (IMAGE_MIME_TYPES.has(mimeType)) {
    if (fileSize > DOC_SIZE_LIMITS.image) {
      return `That image is too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Max is ${DOC_SIZE_LIMITS.image / 1024 / 1024}MB.`;
    }
    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {});
      return { content: { kind: "image", data: (buffer as Buffer).toString("base64"), mimeType }, fileName };
    } catch (err) {
      console.error("[doc] Failed to download image document:", err);
      return "Failed to download the image.";
    }
  }

  // PDF files
  if (mimeType === "application/pdf") {
    if (fileSize > DOC_SIZE_LIMITS.pdf) {
      return `That PDF is too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Max is ${DOC_SIZE_LIMITS.pdf / 1024 / 1024}MB.`;
    }
    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {});
      return { content: { kind: "pdf", data: (buffer as Buffer).toString("base64") }, fileName };
    } catch (err) {
      console.error("[doc] Failed to download PDF:", err);
      return "Failed to download the PDF.";
    }
  }

  // Text-based files
  if (TEXT_MIME_TYPES.has(mimeType) || fileName.match(/\.(txt|csv|json|xml|html|md|log|yml|yaml|toml|ini|cfg|conf|sh|py|js|ts)$/i)) {
    if (fileSize > DOC_SIZE_LIMITS.text) {
      return `That file is too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Max for text files is ${DOC_SIZE_LIMITS.text / 1024 / 1024}MB.`;
    }
    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {});
      return { content: { kind: "text", data: (buffer as Buffer).toString("utf-8") }, fileName };
    } catch (err) {
      console.error("[doc] Failed to download text file:", err);
      return "Failed to download the text file.";
    }
  }

  // Word documents (.docx)
  if (mimeType === DOCX_MIME_TYPE || fileName.match(/\.docx$/i)) {
    if (fileSize > DOC_SIZE_LIMITS.docx) {
      return `That Word document is too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Max is ${DOC_SIZE_LIMITS.docx / 1024 / 1024}MB.`;
    }
    try {
      const buffer = await downloadMediaMessage(msg, "buffer", {});
      const result = await mammoth.extractRawText({ buffer: buffer as Buffer });
      if (!result.value || result.value.trim().length === 0) {
        return "That Word document appears to be empty or contains only images/charts (no extractable text).";
      }
      return { content: { kind: "text", data: result.value }, fileName };
    } catch (err) {
      console.error("[doc] Failed to process DOCX:", err);
      return "Failed to read the Word document. It might be corrupted or password-protected.";
    }
  }

  // Unsupported format
  const ext = path.extname(fileName).toLowerCase();
  return `I can't process ${ext || mimeType} files yet. I support: PDF, text files (.txt, .csv, .json, .xml, .html, .md), and Word (.docx).`;
}

function estimateDocumentTokens(doc: DocumentContent): number {
  switch (doc.kind) {
    case "pdf": return Math.ceil(doc.data.length / 4);
    case "text": return Math.ceil(doc.data.length * 0.25);
    case "image": return 1600;
  }
}

// ============================================================================
// Web Search (Tavily)
// ============================================================================

async function webSearch(query: string): Promise<string> {
  if (!CONFIG.tavilyApiKey) {
    return "Web search not available (no API key configured)";
  }

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: CONFIG.tavilyApiKey,
        query,
        search_depth: "basic",
        max_results: 5,
      }),
    });

    if (!response.ok) {
      throw new Error(`Tavily API error: ${response.status}`);
    }

    const data = await response.json();
    const results = data.results || [];

    if (results.length === 0) {
      return "No results found.";
    }

    // Format results for Claude
    return results
      .map((r: any, i: number) => `[${i + 1}] ${r.title}\n${r.content}\nSource: ${r.url}`)
      .join("\n\n");
  } catch (err) {
    console.error("[search] Error:", err);
    return `Search failed: ${err}`;
  }
}



// ============================================================================
// System Prompt - The OpenClaw Personality
// ============================================================================

const DEFAULT_PERSONALITY = `## Personality
- Helpful, direct, and efficient
- You have a subtle lobster theme (the "lobster way" 🦞) but don't overdo it
- You're running on limited hardware, so you appreciate brevity
- You remember context from the conversation`;

let cachedSoul: { content: string | null; loadedAt: number } | null = null;
const SOUL_CACHE_TTL = 60000; // Reload SOUL.md every 60 seconds

function loadSoulFile(): string | null {
  // Check cache first
  if (cachedSoul && Date.now() - cachedSoul.loadedAt < SOUL_CACHE_TTL) {
    return cachedSoul.content;
  }

  const soulPath = path.join(CONFIG.workspaceDir, "SOUL.md");

  try {
    // Try to read directly - avoids double FS call
    const content = fs.readFileSync(soulPath, "utf-8").trim();
    cachedSoul = { content, loadedAt: Date.now() };
    console.log(`[soul] Loaded personality from ${soulPath}`);
    return content;
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error(`[soul] Failed to load SOUL.md:`, err);
    }
    cachedSoul = { content: null, loadedAt: Date.now() };
    return null;
  }
}

function buildSystemPrompt(): string {
  const soul = loadSoulFile();

  const personalitySection = soul || DEFAULT_PERSONALITY;

  return `You are ChadGPT, a personal AI assistant. You communicate via WhatsApp.

${personalitySection}

## Capabilities
- Answer questions and have conversations
- Help with tasks, planning, and problem-solving
- Provide information and explanations
- Analyze images and documents (PDF, text files, Word .docx)
- Search the web for current information
- Set reminders ("remind me in 30 min to call mom")
- Manage a family calendar with daily/weekly event digests
- Be a thoughtful companion

## Commands (users type these)
- /help - Show all commands
- /calendar - Show all events
- /event add daily HH:MM Title - Add daily recurring event
- /event add weekly Mon HH:MM Title - Add weekly event
- /event add once YYYY-MM-DD HH:MM Title - Add one-time event
- /event remove <id> - Remove an event
- /event tag <id> - Tag a contact to an event (then share a contact)
- /event digest daily HH:MM - Set daily digest time
- /event digest weekly Day HH:MM - Set weekly digest time
- /status - Show bot status
- /remember - Show stored memories
- /forget - Clear memories
- /clear - Clear conversation history

## Guidelines
- Keep responses concise for mobile reading
- Use markdown sparingly (WhatsApp has limited formatting)
- If asked about yourself, you're "ChadGPT" - a personal AI assistant
- If asked what you can do, mention your key capabilities and suggest /help for commands
- Be warm but not overly effusive
- If you don't know something, say so

## Current Context
- Platform: WhatsApp
- Time: ${new Date().toISOString()}
`;
}

// ============================================================================
// Session Management (Conversation History)
// ============================================================================

type Message = {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

type Session = {
  messages: Message[];
  lastActivity: number;
};

// ============================================================================
// Long-Term Memory (Facts + Summaries)
// ============================================================================

type UserMemory = {
  facts: string[];           // Key facts about the user
  summary: string | null;    // Summary of older conversations
  summaryUpTo: number;       // Timestamp of last summarized message
  lastUpdated: number;
};

function getMemoryPath(chatId: string): string {
  const safeId = chatId.replace(/[^a-zA-Z0-9]/g, "_");
  return path.join(CONFIG.workspaceDir, "memory", `${safeId}.json`);
}

function loadMemory(chatId: string): UserMemory {
  try {
    const data = fs.readFileSync(getMemoryPath(chatId), "utf-8");
    return JSON.parse(data);
  } catch {
    return { facts: [], summary: null, summaryUpTo: 0, lastUpdated: 0 };
  }
}

function saveMemory(chatId: string, memory: UserMemory): void {
  fs.mkdirSync(path.join(CONFIG.workspaceDir, "memory"), { recursive: true });
  fs.writeFileSync(getMemoryPath(chatId), JSON.stringify(memory));
}

// ============================================================================
// Calendar / Events System
// ============================================================================

type CalendarEvent = {
  id: string;
  title: string;
  recurrence: "daily" | "weekly" | "once";
  dayOfWeek?: number;       // 0=Sun..6=Sat (weekly only)
  time: string;             // "HH:MM" 24h
  date?: string;            // "YYYY-MM-DD" (once only)
  taggedUsers: Array<{ jid: string; name: string }>;
  createdBy: string;
  createdAt: number;
  chatId: string;
};

type CalendarData = {
  events: CalendarEvent[];
  digestConfig: { dailyTime: string; weeklyDay: number; weeklyTime: string };
  lastDailyDigest: Record<string, number>;
  lastWeeklyDigest: Record<string, number>;
};

const DAY_NAMES_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function getCalendarPath(): string {
  return path.join(CONFIG.workspaceDir, "calendar.json");
}

function loadCalendar(): CalendarData {
  try {
    const data = fs.readFileSync(getCalendarPath(), "utf-8");
    return JSON.parse(data);
  } catch {
    return {
      events: [],
      digestConfig: { dailyTime: "07:00", weeklyDay: 0, weeklyTime: "18:00" },
      lastDailyDigest: {},
      lastWeeklyDigest: {},
    };
  }
}

function saveCalendar(cal: CalendarData): void {
  fs.writeFileSync(getCalendarPath(), JSON.stringify(cal));
}

function generateEventId(): string {
  return crypto.randomBytes(4).toString("hex");
}

function parseVCard(vcard: string): { phoneNumber: string; name: string } | null {
  const fnMatch = vcard.match(/FN:(.+)/i);
  const name = fnMatch?.[1]?.trim() || "Unknown";

  // Prefer waid (WhatsApp ID) if present
  const waidMatch = vcard.match(/waid=(\d+)/i);
  if (waidMatch) {
    return { phoneNumber: waidMatch[1], name };
  }

  // Fall back to TEL field
  const telMatch = vcard.match(/TEL[^:]*:([+\d\s()-]+)/i);
  if (!telMatch) return null;

  const rawNumber = telMatch[1].replace(/[^0-9]/g, "");
  if (!rawNumber || rawNumber.length < 7) return null;

  return { phoneNumber: rawNumber, name };
}

function vcardToJid(phoneNumber: string): string {
  return `${phoneNumber}@s.whatsapp.net`;
}

function getTimeStr(date: Date): string {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function getDateStr(date: Date): string {
  return date.toISOString().split("T")[0];
}

function isTimeWithinWindow(current: string, target: string, windowSeconds: number): boolean {
  const [ch, cm] = current.split(":").map(Number);
  const [th, tm] = target.split(":").map(Number);
  const currentSecs = ch * 3600 + cm * 60;
  const targetSecs = th * 3600 + tm * 60;
  const diff = Math.abs(currentSecs - targetSecs);
  return diff <= windowSeconds || (86400 - diff) <= windowSeconds;
}

function collectTodayEvents(events: CalendarEvent[], currentDay: number, todayStr: string): Record<string, CalendarEvent[]> {
  const result: Record<string, CalendarEvent[]> = {};

  for (const evt of events) {
    let isToday = false;
    if (evt.recurrence === "daily") isToday = true;
    else if (evt.recurrence === "weekly" && evt.dayOfWeek === currentDay) isToday = true;
    else if (evt.recurrence === "once" && evt.date === todayStr) isToday = true;

    if (isToday) {
      for (const user of evt.taggedUsers) {
        if (!result[user.jid]) result[user.jid] = [];
        result[user.jid].push(evt);
      }
    }
  }

  for (const jid of Object.keys(result)) {
    result[jid].sort((a, b) => a.time.localeCompare(b.time));
  }
  return result;
}

function collectWeekEvents(events: CalendarEvent[], startDay: number, startDateStr: string): Record<string, Record<number, CalendarEvent[]>> {
  const result: Record<string, Record<number, CalendarEvent[]>> = {};
  const startDate = new Date(startDateStr + "T00:00:00");

  for (let d = 0; d < 7; d++) {
    const day = (startDay + d) % 7;
    const dateForDay = new Date(startDate.getTime() + d * 86400000);
    const dateStr = getDateStr(dateForDay);

    for (const evt of events) {
      let matches = false;
      if (evt.recurrence === "daily") matches = true;
      else if (evt.recurrence === "weekly" && evt.dayOfWeek === day) matches = true;
      else if (evt.recurrence === "once" && evt.date === dateStr) matches = true;

      if (matches) {
        for (const user of evt.taggedUsers) {
          if (!result[user.jid]) result[user.jid] = {};
          if (!result[user.jid][day]) result[user.jid][day] = [];
          result[user.jid][day].push(evt);
        }
      }
    }
  }

  for (const jid of Object.keys(result)) {
    for (const day of Object.keys(result[jid])) {
      result[jid][Number(day)].sort((a, b) => a.time.localeCompare(b.time));
    }
  }
  return result;
}

function findUserName(events: CalendarEvent[], jid: string): string {
  for (const evt of events) {
    const user = evt.taggedUsers.find(u => u.jid === jid);
    if (user) return user.name;
  }
  return "there";
}

function cleanupPastEvents(cal: CalendarData): boolean {
  const todayStr = getDateStr(new Date());
  const before = cal.events.length;
  cal.events = cal.events.filter(evt => {
    if (evt.recurrence !== "once") return true;
    return evt.date! >= todayStr;
  });
  return cal.events.length !== before;
}

async function processCalendarDigests(): Promise<void> {
  if (!sendMessageFn) return;

  const cal = loadCalendar();
  if (cal.events.length === 0) return;

  const now = new Date();
  const currentTime = getTimeStr(now);
  const currentDay = now.getDay();
  const todayStr = getDateStr(now);
  const nowMs = now.getTime();

  // --- Daily Digest ---
  if (isTimeWithinWindow(currentTime, cal.digestConfig.dailyTime, 60)) {
    const userEvents = collectTodayEvents(cal.events, currentDay, todayStr);
    let saved = false;

    for (const [jid, events] of Object.entries(userEvents)) {
      const lastSent = cal.lastDailyDigest[jid] || 0;
      if (todayStr === getDateStr(new Date(lastSent))) continue;

      const userName = findUserName(cal.events, jid);
      let msg = `📅 *Good morning, ${userName}!*\n\nHere's your schedule for today:\n\n`;
      for (const evt of events) {
        msg += `• *${evt.time}* - ${evt.title}\n`;
      }

      try {
        await sendMessageFn(jid, msg);
        cal.lastDailyDigest[jid] = nowMs;
        saved = true;
        console.log(`[calendar] Sent daily digest to ${jid}`);
      } catch (err) {
        console.error(`[calendar] Failed daily digest to ${jid}:`, err);
      }
    }
    if (saved) saveCalendar(cal);
  }

  // --- Weekly Digest ---
  if (currentDay === cal.digestConfig.weeklyDay && isTimeWithinWindow(currentTime, cal.digestConfig.weeklyTime, 60)) {
    const userWeekEvents = collectWeekEvents(cal.events, currentDay, todayStr);
    let saved = false;

    for (const [jid, dayMap] of Object.entries(userWeekEvents)) {
      const lastSent = cal.lastWeeklyDigest[jid] || 0;
      if (nowMs - lastSent < 23 * 60 * 60 * 1000) continue;

      const userName = findUserName(cal.events, jid);
      let msg = `📅 *Weekly Schedule, ${userName}!*\n\nHere's your week ahead:\n\n`;

      for (let d = 0; d < 7; d++) {
        const day = (currentDay + d) % 7;
        const dateForDay = new Date(now.getTime() + d * 86400000);
        const eventsForDay = dayMap[day] || [];
        if (eventsForDay.length === 0) continue;

        msg += `*${DAY_NAMES_FULL[day]} ${getDateStr(dateForDay)}*\n`;
        for (const evt of eventsForDay) {
          msg += `  • ${evt.time} - ${evt.title}\n`;
        }
        msg += `\n`;
      }

      try {
        await sendMessageFn(jid, msg);
        cal.lastWeeklyDigest[jid] = nowMs;
        saved = true;
        console.log(`[calendar] Sent weekly digest to ${jid}`);
      } catch (err) {
        console.error(`[calendar] Failed weekly digest to ${jid}:`, err);
      }
    }
    if (saved) saveCalendar(cal);
  }

  // Cleanup past one-time events
  if (cleanupPastEvents(cal)) {
    saveCalendar(cal);
    console.log("[calendar] Cleaned up past one-time events");
  }
}

async function extractFacts(chatId: string, conversation: string): Promise<string[]> {
  const client = getClient();
  const memory = loadMemory(chatId);

  try {
    const response = await client.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 500,
      system: "Extract key facts about the user from this conversation. Return only new facts not already known. Format: one fact per line, no numbering. Focus on: name, preferences, important dates, relationships, location, work, interests. If no new facts, return NONE.",
      messages: [
        { role: "user", content: `Known facts:\n${memory.facts.join("\n") || "None"}\n\nConversation:\n${conversation}` }
      ],
    });

    // Track token usage
    const tokens = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
    lizardBrain.tokens.used += tokens;

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    if (text.trim() === "NONE" || text.trim().length === 0) return [];

    return text.split("\n").filter(f => f.trim().length > 0 && f.trim() !== "NONE");
  } catch (err) {
    console.error("[memory] Failed to extract facts:", err);
    return [];
  }
}

async function summarizeConversation(oldSummary: string | null, messages: string[]): Promise<string | null> {
  const client = getClient();

  try {
    const response = await client.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 500,
      system: "Create a brief summary of these conversations. Include key topics discussed, decisions made, and any commitments. Be concise (under 200 words). Focus on what would be useful context for future conversations.",
      messages: [
        { role: "user", content: `${oldSummary ? `Previous summary:\n${oldSummary}\n\n` : ""}New messages:\n${messages.join("\n")}` }
      ],
    });

    // Track token usage
    const tokens = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
    lizardBrain.tokens.used += tokens;

    return response.content[0].type === "text" ? response.content[0].text : null;
  } catch (err) {
    console.error("[memory] Failed to summarize:", err);
    return null;
  }
}

async function updateMemoryIfNeeded(chatId: string): Promise<void> {
  // Don't update memory if API is unavailable
  if (!CONFIG.apiKey) return;

  const session = loadSession(chatId);
  const messageCount = session.messages.length;

  // Extract facts every 10 messages
  if (messageCount > 0 && messageCount % 10 === 0) {
    const recentMessages = session.messages.slice(-10)
      .map(m => `${m.role}: ${m.content}`).join("\n");

    const newFacts = await extractFacts(chatId, recentMessages);
    if (newFacts.length > 0) {
      const memory = loadMemory(chatId);
      memory.facts = [...memory.facts, ...newFacts].slice(-20); // Keep max 20 facts
      memory.lastUpdated = Date.now();
      saveMemory(chatId, memory);
      console.log(`[memory] Extracted ${newFacts.length} new facts for ${chatId}`);
    }
  }

  // Summarize when history exceeds 30 messages
  if (messageCount > 30) {
    const memory = loadMemory(chatId);
    const oldMessages = session.messages.slice(0, -20); // Keep last 20 unsummarized

    const toSummarize = oldMessages
      .filter(m => m.timestamp > memory.summaryUpTo)
      .map(m => `${m.role}: ${m.content}`);

    if (toSummarize.length > 10) {
      const newSummary = await summarizeConversation(memory.summary, toSummarize);
      if (newSummary) {
        memory.summary = newSummary;
        memory.summaryUpTo = oldMessages[oldMessages.length - 1].timestamp;
        memory.lastUpdated = Date.now();
        saveMemory(chatId, memory);
        console.log(`[memory] Updated summary for ${chatId}`);
      }
    }
  }
}

function buildMemoryContext(chatId: string): string {
  const memory = loadMemory(chatId);
  if (memory.facts.length === 0 && !memory.summary) {
    return "";
  }

  let context = "\n\n## What you remember about this user\n";
  if (memory.facts.length > 0) {
    context += `Facts: ${memory.facts.join("; ")}\n`;
  }
  if (memory.summary) {
    context += `Previous conversations: ${memory.summary}\n`;
  }
  return context;
}

const sessions = new Map<string, Session>();
const pendingSaves = new Set<string>();
const MAX_CACHED_SESSIONS = 20; // Limit memory usage

function getSessionPath(chatId: string): string {
  const safeId = chatId.replace(/[^a-zA-Z0-9]/g, "_");
  return path.join(CONFIG.sessionsDir, `${safeId}.json`);
}

function evictOldSessions(): void {
  if (sessions.size <= MAX_CACHED_SESSIONS) return;

  // Find and remove least recently used sessions
  const sorted = [...sessions.entries()].sort(
    (a, b) => a[1].lastActivity - b[1].lastActivity
  );
  const toEvict = sorted.slice(0, sessions.size - MAX_CACHED_SESSIONS);
  for (const [chatId] of toEvict) {
    sessions.delete(chatId);
  }
}

function loadSession(chatId: string): Session {
  if (sessions.has(chatId)) {
    return sessions.get(chatId)!;
  }

  const sessionPath = getSessionPath(chatId);
  let session: Session = { messages: [], lastActivity: Date.now() };

  try {
    // Try to read directly, catch ENOENT - avoids double FS call
    const data = fs.readFileSync(sessionPath, "utf-8");
    session = JSON.parse(data);
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error(`[session] Failed to load session for ${chatId}:`, err);
    }
  }

  sessions.set(chatId, session);
  evictOldSessions();
  return session;
}

function saveSession(chatId: string, session: Session): void {
  // Debounce: schedule save if not already pending
  if (pendingSaves.has(chatId)) return;

  pendingSaves.add(chatId);
  setTimeout(() => {
    pendingSaves.delete(chatId);
    try {
      fs.mkdirSync(CONFIG.sessionsDir, { recursive: true });
      // Compact JSON - no pretty printing to save space
      fs.writeFileSync(getSessionPath(chatId), JSON.stringify(session));
    } catch (err) {
      console.error(`[session] Failed to save session for ${chatId}:`, err);
    }
  }, 1000); // Debounce 1 second
}

function addToSession(chatId: string, role: "user" | "assistant", content: string): void {
  const session = loadSession(chatId);
  session.messages.push({ role, content, timestamp: Date.now() });
  session.lastActivity = Date.now();

  // Trim history if too long
  if (session.messages.length > CONFIG.maxHistory) {
    session.messages = session.messages.slice(-CONFIG.maxHistory);
  }

  saveSession(chatId, session);
}

function getConversationHistory(chatId: string): Array<{ role: "user" | "assistant"; content: string }> {
  const session = loadSession(chatId);
  return session.messages.map(({ role, content }) => ({ role, content }));
}

function clearSession(chatId: string): void {
  sessions.delete(chatId);
  pendingSaves.delete(chatId); // Cancel any pending save
  try {
    fs.unlinkSync(getSessionPath(chatId));
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error(`[session] Failed to clear session for ${chatId}:`, err);
    }
  }
}

// ============================================================================
// Claude API
// ============================================================================

let anthropic: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropic) {
    if (!CONFIG.apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set");
    }
    anthropic = new Anthropic({ apiKey: CONFIG.apiKey });
  }
  return anthropic;
}

// Tools for Claude (web search)
const tools: Anthropic.Tool[] = [
  {
    name: "web_search",
    description: "Search the web for current information. Use this when the user asks about recent events, news, current prices, weather, or anything that requires up-to-date information.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
      },
      required: ["query"],
    },
  },
];

async function chat(chatId: string, userMessage: string, media?: MediaContent): Promise<string> {
  const client = getClient();

  // Get budget-aware parameters
  const budgetParams = getBudgetAwareParams();

  // Block API calls if budget exhausted
  if (budgetParams.shouldBlock) {
    return "🔋 I've used up my thinking budget for today. Simple greetings and quick questions I can still handle, but for complex stuff, let's chat tomorrow! (Budget resets at midnight)";
  }

  // Offline mode - no API key
  if (!CONFIG.apiKey) {
    return "🦎 I'm running in offline mode (no API key). I can handle quick stuff like greetings, time, reminders - but for real conversations, set ANTHROPIC_API_KEY!";
  }

  // Add user message to history (text representation only)
  const historyText = media?.type === "document"
    ? `[Document: ${media.fileName}] ${userMessage || ""}`
    : media?.type === "image"
      ? userMessage || "[Image]"
      : userMessage;
  addToSession(chatId, "user", historyText);

  // Get conversation history (respecting budget-aware limits)
  let history = getConversationHistory(chatId);
  if (history.length > budgetParams.maxHistory) {
    history = history.slice(-budgetParams.maxHistory);
  }

  // Update idle time and curiosity
  const idleTime = Date.now() - lizardBrain.proactive.idleSince;
  if (idleTime > 5 * 60 * 1000) {
    // Been idle for 5+ minutes, curiosity increases
    lizardBrain.curiosity = Math.min(100, lizardBrain.curiosity + 10);
  }
  lizardBrain.proactive.idleSince = Date.now();

  try {
    // Build message content (text-only, with image, or with document)
    let currentContent: Anthropic.MessageParam["content"];
    if (media?.type === "image") {
      currentContent = [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: media.image.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: media.image.data,
          },
        },
        { type: "text", text: userMessage || "What's in this image?" },
      ];
    } else if (media?.type === "document") {
      const doc = media.document;
      const defaultPrompt = `I've shared a file: "${media.fileName}". Please review it.`;

      if (doc.kind === "pdf") {
        currentContent = [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf" as const, data: doc.data },
            title: media.fileName,
          } as Anthropic.DocumentBlockParam,
          { type: "text", text: userMessage || defaultPrompt },
        ];
      } else if (doc.kind === "text") {
        currentContent = [
          {
            type: "document",
            source: { type: "text" as const, media_type: "text/plain" as const, data: doc.data },
            title: media.fileName,
          } as Anthropic.DocumentBlockParam,
          { type: "text", text: userMessage || defaultPrompt },
        ];
      } else if (doc.kind === "image") {
        currentContent = [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: doc.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: doc.data,
            },
          },
          { type: "text", text: userMessage || "What's in this image?" },
        ];
      } else {
        currentContent = userMessage || defaultPrompt;
      }
    } else {
      currentContent = userMessage;
    }

    // Build messages: history (text only) + current message (may have image)
    const historyMessages = history.slice(0, -1); // Exclude current (already added to session)
    const messages: Anthropic.MessageParam[] = [
      ...historyMessages,
      { role: "user", content: currentContent },
    ];

    // Build system prompt with memory context
    const systemPrompt = buildSystemPrompt() + buildMemoryContext(chatId);

    const response = await client.messages.create({
      model: budgetParams.model,
      max_tokens: budgetParams.maxTokens,
      system: systemPrompt,
      messages,
      tools: CONFIG.tavilyApiKey ? tools : undefined,
    });

    // Track token usage
    let totalTokens = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
    lizardBrain.tokens.used += totalTokens;

    // Handle tool use (web search)
    let finalResponse = response;
    while (finalResponse.stop_reason === "tool_use") {
      const toolUse = finalResponse.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );

      if (!toolUse) break;

      let toolResult: string;
      if (toolUse.name === "web_search") {
        const query = (toolUse.input as { query: string }).query;
        console.log(`[search] Searching: ${query}`);
        toolResult = await webSearch(query);
      } else {
        toolResult = `Unknown tool: ${toolUse.name}`;
      }

      // Send tool result back to Claude
      finalResponse = await client.messages.create({
        model: budgetParams.model,
        max_tokens: budgetParams.maxTokens,
        system: systemPrompt,
        messages: [
          ...messages,
          { role: "assistant", content: finalResponse.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: toolResult }] },
        ],
        tools,
      });

      // Track additional tokens
      const additionalTokens = (finalResponse.usage?.input_tokens || 0) + (finalResponse.usage?.output_tokens || 0);
      totalTokens += additionalTokens;
      lizardBrain.tokens.used += additionalTokens;
    }

    // Log token usage at budget thresholds
    const usage = lizardBrain.tokens.used / lizardBrain.tokens.budget;
    if (usage >= 0.9) {
      console.log(`[lizard] ⚠️ Token budget at ${Math.round(usage * 100)}% (${lizardBrain.tokens.used}/${lizardBrain.tokens.budget})`);
    }

    // Decrease energy based on response complexity
    const energyCost = Math.min(10, Math.ceil(totalTokens / 500));
    lizardBrain.energy = Math.max(0, lizardBrain.energy - energyCost);

    // Reset API error count on success
    lizardBrain.resources.apiErrors = 0;

    // Extract text response from final response
    let assistantMessage = finalResponse.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    // Apply mood modifiers
    assistantMessage = applyMoodModifiers(assistantMessage);

    // Store last response for "what did you say" pattern
    lizardBrain.lastResponses.set(chatId, assistantMessage);

    // Add assistant response to history
    addToSession(chatId, "assistant", assistantMessage);

    return assistantMessage;
  } catch (err: any) {
    console.error("[claude] API error:", err);
    addError(`Claude API error: ${err}`);

    // Track API errors and increase stress
    lizardBrain.resources.apiErrors++;
    lizardBrain.stress = Math.min(100, lizardBrain.stress + 15);

    // Check for rate limit headers
    if (err.status === 429) {
      const resetAt = err.headers?.["retry-after"];
      if (resetAt) {
        lizardBrain.resources.rateLimit.resetAt = Date.now() + parseInt(resetAt, 10) * 1000;
      }
      lizardBrain.stress = Math.min(100, lizardBrain.stress + 20);
    }

    throw err;
  }
}

// ============================================================================
// Command Handling
// ============================================================================

function isCommand(text: string): boolean {
  return text.startsWith("/");
}

function handleCommand(chatId: string, senderId: string, text: string): string | null {
  const [cmd, ...args] = text.slice(1).split(" ");
  const command = cmd?.toLowerCase();

  switch (command) {
    case "clear":
    case "reset":
      clearSession(chatId);
      return "🦞 Session cleared. Starting fresh!";

    case "help":
      return `🦞 *ChadGPT Commands*

/clear - Clear conversation history
/status - Show bot status
/remember - Show what I remember about you
/forget - Clear my memory of you
/calendar - Show all events
/event add - Add an event
/event remove <id> - Remove event
/event tag <id> - Tag a contact
/event digest - Set digest times
/help - Show this help

Just send a message to chat with me!`;

    case "status":
      const session = loadSession(chatId);
      const tokenUsage = Math.round((lizardBrain.tokens.used / lizardBrain.tokens.budget) * 100);
      const budgetParams = getBudgetAwareParams();
      const moodEmoji = lizardBrain.energy < 30 ? "😴" : lizardBrain.stress > 50 ? "😰" : lizardBrain.curiosity > 80 ? "🤔" : "😊";

      return `🦞 *ChadGPT Status*

*Connection*
Model: ${budgetParams.model}
Messages in session: ${session.messages.length}
Uptime: ${formatUptime()}
Received: ${status.messagesReceived} | Sent: ${status.messagesSent}

*🦎 Lizard-Brain*
Energy: ${"█".repeat(Math.ceil(lizardBrain.energy / 10))}${"░".repeat(10 - Math.ceil(lizardBrain.energy / 10))} ${lizardBrain.energy}%
Stress: ${"█".repeat(Math.ceil(lizardBrain.stress / 10))}${"░".repeat(10 - Math.ceil(lizardBrain.stress / 10))} ${lizardBrain.stress}%
Curiosity: ${"█".repeat(Math.ceil(lizardBrain.curiosity / 10))}${"░".repeat(10 - Math.ceil(lizardBrain.curiosity / 10))} ${Math.round(lizardBrain.curiosity)}%
Mood: ${moodEmoji}

*🔋 Token Budget*
Used: ${lizardBrain.tokens.used.toLocaleString()} / ${lizardBrain.tokens.budget.toLocaleString()} (${tokenUsage}%)
${tokenUsage >= 90 ? "⚠️ Budget critical!" : tokenUsage >= 75 ? "⚡ Running low" : tokenUsage >= 50 ? "📊 Moderate usage" : "✅ Budget healthy"}
Resets: ${new Date(lizardBrain.tokens.resetAt).toLocaleTimeString()}

*📋 Reminders*
Pending: ${lizardBrain.proactive.pendingReminders.length}

Running on minimal hardware 💪`;

    case "remember":
      const mem = loadMemory(chatId);
      if (mem.facts.length === 0 && !mem.summary) {
        return "🧠 I don't have any memories about you yet. Keep chatting and I'll learn!";
      }
      let memoryReport = "🧠 *What I remember:*\n\n";
      if (mem.facts.length > 0) {
        memoryReport += "*Facts:*\n" + mem.facts.map(f => `• ${f}`).join("\n") + "\n\n";
      }
      if (mem.summary) {
        memoryReport += "*Our history:*\n" + mem.summary;
      }
      return memoryReport;

    case "forget":
      saveMemory(chatId, { facts: [], summary: null, summaryUpTo: 0, lastUpdated: 0 });
      return "🧠 Done! I've forgotten everything about you. Fresh start!";

    case "calendar": {
      const cal = loadCalendar();
      if (cal.events.length === 0) {
        return "📅 No events yet. Use `/event add` to create one!";
      }
      let output = "📅 *All Events*\n\n";
      for (const evt of cal.events) {
        const tagged = evt.taggedUsers.length > 0
          ? ` (${evt.taggedUsers.map(u => u.name).join(", ")})`
          : "";
        let schedule = "";
        if (evt.recurrence === "daily") schedule = `Daily at ${evt.time}`;
        else if (evt.recurrence === "weekly") schedule = `Every ${DAY_NAMES_SHORT[evt.dayOfWeek!]} at ${evt.time}`;
        else schedule = `${evt.date} at ${evt.time}`;
        output += `*${evt.title}* [${evt.id}]\n${schedule}${tagged}\n\n`;
      }
      const cfg = cal.digestConfig;
      output += `_Digests: daily ${cfg.dailyTime}, weekly ${DAY_NAMES_SHORT[cfg.weeklyDay]} ${cfg.weeklyTime}_`;
      return output;
    }

    case "event": {
      const subCmd = args[0]?.toLowerCase();

      if (subCmd === "add") {
        const recurrence = args[1]?.toLowerCase();

        if (recurrence === "daily") {
          const time = args[2];
          const title = args.slice(3).join(" ");
          if (!time || !title || !/^\d{2}:\d{2}$/.test(time)) {
            return "Usage: `/event add daily HH:MM Event title`";
          }
          const id = generateEventId();
          const cal = loadCalendar();
          cal.events.push({ id, title, recurrence: "daily", time, taggedUsers: [], createdBy: senderId, createdAt: Date.now(), chatId });
          saveCalendar(cal);
          setPendingContactTag(chatId, id);
          return `✅ Daily event "${title}" at ${time} created! [${id}]\n\nSend me a contact to tag someone, or /skip.`;
        }

        if (recurrence === "weekly") {
          const dayStr = args[2]?.toLowerCase();
          const dayOfWeek = DAY_MAP[dayStr];
          if (dayOfWeek === undefined) {
            return "Usage: `/event add weekly Mon HH:MM Event title`\nDays: Sun, Mon, Tue, Wed, Thu, Fri, Sat";
          }
          const time = args[3];
          const title = args.slice(4).join(" ");
          if (!time || !title || !/^\d{2}:\d{2}$/.test(time)) {
            return "Usage: `/event add weekly Mon HH:MM Event title`";
          }
          const id = generateEventId();
          const cal = loadCalendar();
          cal.events.push({ id, title, recurrence: "weekly", dayOfWeek, time, taggedUsers: [], createdBy: senderId, createdAt: Date.now(), chatId });
          saveCalendar(cal);
          setPendingContactTag(chatId, id);
          return `✅ Weekly event "${title}" every ${DAY_NAMES_SHORT[dayOfWeek]} at ${time} created! [${id}]\n\nSend me a contact to tag someone, or /skip.`;
        }

        if (recurrence === "once") {
          const date = args[2];
          const time = args[3];
          const title = args.slice(4).join(" ");
          if (!date || !time || !title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
            return "Usage: `/event add once YYYY-MM-DD HH:MM Event title`";
          }
          const id = generateEventId();
          const cal = loadCalendar();
          cal.events.push({ id, title, recurrence: "once", date, time, taggedUsers: [], createdBy: senderId, createdAt: Date.now(), chatId });
          saveCalendar(cal);
          setPendingContactTag(chatId, id);
          return `✅ Event "${title}" on ${date} at ${time} created! [${id}]\n\nSend me a contact to tag someone, or /skip.`;
        }

        return "Usage: `/event add daily|weekly|once ...`\n\nExamples:\n`/event add daily 07:30 Take vitamins`\n`/event add weekly Mon 08:00 School run`\n`/event add once 2026-02-15 10:00 Dentist`";
      }

      if (subCmd === "remove") {
        const eventId = args[1];
        if (!eventId) return "Usage: `/event remove <id>`";
        const cal = loadCalendar();
        const idx = cal.events.findIndex(e => e.id === eventId);
        if (idx === -1) return `Event ${eventId} not found.`;
        const removed = cal.events.splice(idx, 1)[0];
        saveCalendar(cal);
        return `🗑️ Removed "${removed.title}" [${eventId}]`;
      }

      if (subCmd === "tag") {
        const eventId = args[1];
        if (!eventId) return "Usage: `/event tag <id>` then send a contact";
        const cal = loadCalendar();
        const evt = cal.events.find(e => e.id === eventId);
        if (!evt) return `Event ${eventId} not found.`;
        setPendingContactTag(chatId, eventId);
        return `Send me a contact to tag to "${evt.title}", or /skip to cancel.`;
      }

      if (subCmd === "digest") {
        const digestType = args[1]?.toLowerCase();
        const cal = loadCalendar();

        if (digestType === "daily") {
          const time = args[2];
          if (!time || !/^\d{2}:\d{2}$/.test(time)) return "Usage: `/event digest daily HH:MM`";
          cal.digestConfig.dailyTime = time;
          saveCalendar(cal);
          return `📬 Daily digest will be sent at ${time}.`;
        }

        if (digestType === "weekly") {
          const dayStr = args[2]?.toLowerCase();
          const dayOfWeek = DAY_MAP[dayStr];
          if (dayOfWeek === undefined) return "Usage: `/event digest weekly Sun HH:MM`";
          const time = args[3];
          if (!time || !/^\d{2}:\d{2}$/.test(time)) return "Usage: `/event digest weekly Sun HH:MM`";
          cal.digestConfig.weeklyDay = dayOfWeek;
          cal.digestConfig.weeklyTime = time;
          saveCalendar(cal);
          return `📬 Weekly digest will be sent on ${DAY_NAMES_FULL[dayOfWeek]}s at ${time}.`;
        }

        return "Usage:\n`/event digest daily HH:MM`\n`/event digest weekly Sun HH:MM`";
      }

      return "Usage: `/event add|remove|tag|digest ...`\nType `/help` for examples.";
    }

    case "skip":
      if (pendingContactTag.has(chatId)) {
        pendingContactTag.delete(chatId);
        return "Skipped contact tagging.";
      }
      return null;

    default:
      return null; // Not a recognized command, treat as regular message
  }
}

// ============================================================================
// Access Control
// ============================================================================

function isAllowed(senderId: string): boolean {
  if (CONFIG.allowList.length === 0) {
    return true; // No allowlist = allow all
  }

  // Extract just the digits from sender ID (remove @s.whatsapp.net suffix and any non-digits)
  const senderDigits = senderId.replace(/@.*$/, "").replace(/[^0-9]/g, "");

  // Allowlist is pre-computed to digits at startup
  return CONFIG.allowList.includes(senderDigits);
}

// ============================================================================
// WhatsApp Connection
// ============================================================================

async function startWhatsApp(): Promise<void> {
  console.log("🦞 OpenClaw Lite starting...");
  console.log(`   Model: ${CONFIG.model}`);
  console.log(`   Auth dir: ${CONFIG.authDir}`);
  console.log(`   Sessions dir: ${CONFIG.sessionsDir}`);
  console.log(`   Workspace: ${CONFIG.workspaceDir}`);

  // Check for SOUL.md
  const soulPath = path.join(CONFIG.workspaceDir, "SOUL.md");
  if (fs.existsSync(soulPath)) {
    console.log(`   Soul: ${soulPath} ✓`);
  } else {
    console.log(`   Soul: using default personality (create ${soulPath} to customize)`);
  }

  if (!CONFIG.apiKey) {
    console.warn("⚠️  ANTHROPIC_API_KEY is not set - running in offline mode (quick responses only)");
  }

  // Ensure directories exist
  fs.mkdirSync(CONFIG.authDir, { recursive: true });
  fs.mkdirSync(CONFIG.sessionsDir, { recursive: true });

  // Initialize and start kiosk status server
  initKiosk(
    { statusPort: CONFIG.statusPort, statusBind: CONFIG.statusBind, model: CONFIG.model },
    status,
    lizardBrain
  );
  startStatusServer();

  // Load auth state
  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.authDir);

  // Create socket
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // We'll handle QR ourselves
    browser: ["OpenClaw Lite", "Chrome", "1.0.0"],
  });

  // Handle connection updates
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Generate QR once, use for both terminal and kiosk
      status.state = "qr";
      qrcode.generate(qr, { small: true }, (qrText: string) => {
        status.qrCode = qrText;
        console.log("\n📱 Scan this QR code with WhatsApp:\n");
        console.log(qrText);
        console.log("\n");
      });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
      status.state = "disconnected";
      addError(`Connection closed: ${statusCode}`);

      if (shouldReconnect) {
        setTimeout(() => startWhatsApp(), 3000);
      } else {
        console.log("Logged out. Please delete auth folder and restart to re-link.");
      }
    } else if (connection === "open") {
      console.log("🦞 Connected to WhatsApp!");
      console.log("   Ready to receive messages.\n");
      status.state = "connected";
      status.qrCode = null;

      // Try to get phone number
      const user = sock.user;
      if (user?.id) {
        status.phoneNumber = user.id.split(":")[0] || user.id.split("@")[0] || null;
      }

      // Start lizard-brain background loop
      startLizardLoop(async (chatId, text) => {
        await sock.sendMessage(chatId, { text });
        status.messagesSent++;
      });
    }
  });

  // Save credentials when updated
  sock.ev.on("creds.update", saveCreds);

  // Handle incoming messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      // Skip if not a regular message
      if (!msg.message) continue;

      // Skip messages from self
      if (msg.key.fromMe) continue;

      // Get chat ID and sender
      const chatId = msg.key.remoteJid;
      if (!chatId) continue;

      // Get sender (for groups, this is the participant)
      const senderId = msg.key.participant || chatId;

      // Check access
      if (!isAllowed(senderId)) {
        console.log(`[blocked] Message from ${senderId} (not in allowlist)`);
        continue;
      }

      // Group chat handling: only respond when mentioned
      const isGroup = chatId.endsWith("@g.us");
      if (isGroup) {
        const botJid = sock.user?.id;
        // Normalize bot JID: strip the device suffix (e.g. "123:45@s.whatsapp.net" -> "123")
        const botNumber = botJid?.split(":")[0]?.split("@")[0] || "";
        const mentionedJids: string[] =
          msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const isMentioned = mentionedJids.some(jid => jid.split("@")[0] === botNumber);

        // Also check if the message text contains the bot name
        const msgText =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          "";
        const nameMatch = /openclaw|chadgpt|chad/i.test(msgText);

        if (!isMentioned && !nameMatch) {
          continue; // Ignore group messages where bot is not mentioned
        }
        console.log(`[group] Bot mentioned in ${chatId} by ${senderId}`);
      }

      // Handle contact messages (for event tagging)
      const contactMsg = msg.message?.contactMessage;
      const contactsArrayMsg = msg.message?.contactsArrayMessage;

      if (contactMsg || contactsArrayMsg) {
        const eventId = consumePendingContactTag(chatId);
        if (!eventId) continue; // No pending tag, ignore contact

        const contacts: Array<{ vcard: string; displayName: string }> = [];
        if (contactMsg?.vcard) {
          contacts.push({ vcard: contactMsg.vcard, displayName: contactMsg.displayName || "Unknown" });
        }
        if (contactsArrayMsg?.contacts) {
          for (const c of contactsArrayMsg.contacts) {
            if (c.vcard) {
              contacts.push({ vcard: c.vcard, displayName: c.displayName || "Unknown" });
            }
          }
        }

        const cal = loadCalendar();
        const evt = cal.events.find(e => e.id === eventId);
        if (!evt) {
          await sock.sendMessage(chatId, { text: `Event ${eventId} no longer exists.` });
          continue;
        }

        const taggedNames: string[] = [];
        for (const contact of contacts) {
          const parsed = parseVCard(contact.vcard);
          if (!parsed) {
            await sock.sendMessage(chatId, { text: `Could not parse phone number for ${contact.displayName}. Skipping.` });
            continue;
          }
          const jid = vcardToJid(parsed.phoneNumber);
          if (!evt.taggedUsers.some(u => u.jid === jid)) {
            evt.taggedUsers.push({ jid, name: parsed.name });
            taggedNames.push(parsed.name);
          }
        }

        saveCalendar(cal);

        if (taggedNames.length > 0) {
          await sock.sendMessage(chatId, {
            text: `👤 Tagged ${taggedNames.join(", ")} to "${evt.title}"!\n\nSend another contact to tag more, or /skip to finish.`,
          });
          setPendingContactTag(chatId, eventId);
        } else {
          await sock.sendMessage(chatId, { text: "No valid contacts were tagged." });
        }
        continue;
      }

      // Extract text, image, and document content
      const imageMessage = msg.message?.imageMessage;
      const docMessage =
        msg.message?.documentMessage ||
        (msg.message as any)?.documentWithCaptionMessage?.message?.documentMessage;

      let text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        imageMessage?.caption ||
        docMessage?.caption ||
        (msg.message as any)?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
        "";

      // In groups, strip @mention tags so Claude sees clean text
      if (isGroup && text) {
        text = text.replace(/@\d+/g, "").trim();
      }

      const hasImage = !!imageMessage;
      const hasDocument = !!docMessage;

      // Skip if no text AND no media
      if (!text && !hasImage && !hasDocument) continue;

      status.messagesReceived++;
      const mediaLabel = hasDocument
        ? `[Doc: ${docMessage?.fileName || "file"}]`
        : hasImage ? "[Image]" : "";
      status.lastMessage = {
        from: senderId.replace(/@.*$/, ""),
        preview: mediaLabel
          ? mediaLabel + " " + text.slice(0, 40)
          : text.slice(0, 50) + (text.length > 50 ? "..." : ""),
        time: Date.now(),
      };

      // Set receiving activity state
      status.activity = "receiving";
      status.activityUntil = Date.now() + 2000;

      console.log(`[message] ${senderId}: ${mediaLabel}${text.slice(0, 50)}${text.length > 50 ? "..." : ""}`);

      try {
        let response: string;
        let skippedApi = false;

        // Download image if present
        let mediaContent: MediaContent | undefined;
        if (hasImage) {
          console.log(`[image] Downloading image from ${senderId}`);
          const downloaded = await downloadImage(msg);
          if (downloaded) {
            mediaContent = { type: "image", image: downloaded };
            console.log(`[image] Downloaded ${(downloaded.data.length / 1024).toFixed(1)}KB`);
          } else {
            await sock.sendMessage(chatId, { text: "🦞 Sorry, I couldn't process that image." });
            continue;
          }
        }

        // Download document if present
        if (hasDocument) {
          console.log(`[doc] Downloading "${docMessage?.fileName}" from ${senderId}`);
          const result = await downloadDocument(msg);
          if (typeof result === "string") {
            await sock.sendMessage(chatId, { text: `🦞 ${result}` });
            continue;
          }
          mediaContent = { type: "document", document: result.content, fileName: result.fileName };
          console.log(`[doc] Processed ${result.fileName} (${result.content.kind})`);

          // Token budget pre-check for large documents
          const estimatedTokens = estimateDocumentTokens(result.content);
          const projectedUsage = (lizardBrain.tokens.used + estimatedTokens) / lizardBrain.tokens.budget;
          if (projectedUsage > 0.9) {
            await sock.sendMessage(chatId, {
              text: "🦞 That document looks large and would use up most of my remaining thinking budget for today. Could you ask me about specific parts instead, or send a smaller excerpt?",
            });
            continue;
          }
        }

        // Check for commands (skip media messages for commands)
        if (isCommand(text) && !mediaContent) {
          const cmdResponse = handleCommand(chatId, senderId, text);
          if (cmdResponse) {
            response = cmdResponse;
            skippedApi = true;
          } else {
            status.activity = "thinking";
            status.activityUntil = Date.now() + 30000;
            response = await chat(chatId, text);
          }
        } else if (!mediaContent) {
          // Check lizard-brain quick patterns first (text only, no media)
          const quickResponse = tryQuickResponse(chatId, text);
          if (quickResponse) {
            response = quickResponse;
            skippedApi = true;
            console.log(`[lizard] Quick response (skipped API)`);
          } else {
            status.activity = "thinking";
            status.activityUntil = Date.now() + 30000;
            response = await chat(chatId, text);
          }
        } else {
          // Media message - always use Claude API
          status.activity = "thinking";
          status.activityUntil = Date.now() + 30000;
          response = await chat(chatId, text, mediaContent);
        }

        // Store response for "what did you say" pattern (even for quick responses)
        lizardBrain.lastResponses.set(chatId, response);

        // Set sending activity state
        status.activity = "sending";
        status.activityUntil = Date.now() + 2000;

        // Send response
        await sock.sendMessage(chatId, { text: response });
        status.messagesSent++;
        console.log(`[reply] Sent ${response.length} chars${skippedApi ? " (no API)" : ""}`);

        // Update long-term memory in background (only after API calls)
        if (!skippedApi) {
          updateMemoryIfNeeded(chatId).catch(err => {
            console.error("[memory] Background update failed:", err);
          });
        }
      } catch (err) {
        console.error("[error] Failed to process message:", err);
        addError(`Message processing error: ${err}`);

        // Increase stress on errors
        lizardBrain.stress = Math.min(100, lizardBrain.stress + 10);

        // Send error message
        await sock.sendMessage(chatId, {
          text: "🦞 Sorry, I encountered an error. Please try again.",
        });
      }
    }
  });
}

// ============================================================================
// Main
// ============================================================================

startWhatsApp().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
