// cogent42-team bot — one container per user.
// Per-bot env: OWNER_USER_ID, OWNER_EMAIL, BOT_NAME, TELEGRAM_USER_ID, TELEGRAM_BOT_TOKEN,
//              DATABASE_URL, MASTER_KEY, OPENAI_API_KEY,
//              GOOGLE_CLIENT_ID, GOOGLE_OAUTH_REDIRECT_URI, CONTROL_PLANE_PUBLIC_URL.
// Auth for the Claude Agent SDK comes from /root/.claude (bind-mounted from host CLAUDE_CODE_HOME).

import { Telegraf } from "telegraf";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pool, audit } from "@cogent42-team/db";

import { buildSystemPrompt } from "./prompt.js";
import { appendChatMessage, flushIdleSessions } from "./session.js";
import { registerInstance, heartbeat } from "./instance.js";
import { handleSlashCommand } from "./commands.js";
import { mdToTelegramHtml, startTypingLoop, chunkForTelegram } from "./format.js";

const {
  OWNER_USER_ID,
  OWNER_EMAIL,
  BOT_NAME,
  TELEGRAM_USER_ID,
  TELEGRAM_BOT_TOKEN,
} = process.env;

for (const [k, v] of Object.entries({ OWNER_USER_ID, BOT_NAME, TELEGRAM_USER_ID, TELEGRAM_BOT_TOKEN })) {
  if (!v) { console.error(`FATAL: ${k} not set`); process.exit(1); }
}

const ALLOWED_TG_ID = String(TELEGRAM_USER_ID);
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// Tunables. Defaults match what the live deployment runs.
const MAX_TURNS     = parseInt(process.env.MAX_TURNS || "50", 10);
const BOT_MODEL     = process.env.BOT_MODEL || "claude-sonnet-4-6";
const ALLOWED_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"];

// Telegram bots can download up to ~20 MB by default. Anthropic accepts ~32 MB
// PDFs and ~5 MB images. We reject anything above this cap up-front to fail
// fast rather than mid-Claude-turn.
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const UPLOAD_DIR     = "/tmp/cogent42-uploads";

await fs.mkdir(UPLOAD_DIR, { recursive: true });
await registerInstance({ userId: OWNER_USER_ID, botName: BOT_NAME });

// Reject anyone who isn't the bot's owner.
bot.use(async (ctx, next) => {
  if (String(ctx.from?.id) !== ALLOWED_TG_ID) {
    if (ctx.chat) await ctx.reply("This bot is private.").catch(() => {});
    return;
  }
  return next();
});

bot.start((ctx) =>
  ctx.reply(`Hi ${OWNER_EMAIL || ""}. I'm ${BOT_NAME}. Send me anything — text, photos, files — and I'll work on it on this server.`)
);

// ── Helpers ──────────────────────────────────────────────────────────────

async function downloadTelegramFile(ctx, fileId, suggestedName = "file") {
  const link = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(String(link));
  if (!res.ok) throw new Error(`telegram download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const safe = suggestedName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "file";
  const filePath = path.join(UPLOAD_DIR, `${Date.now()}-${safe}`);
  await fs.writeFile(filePath, buf);
  return filePath;
}

async function runAndReply(ctx, { logged, prompt }) {
  await appendChatMessage(OWNER_USER_ID, "user", logged);

  const systemAppend = await buildSystemPrompt({
    userId: OWNER_USER_ID,
    prompt: typeof prompt === "string" ? prompt : logged,
    botName: BOT_NAME,
  });

  const options = {
    maxTurns: MAX_TURNS,
    model: BOT_MODEL,
    permissionMode: "default",
    allowedTools: ALLOWED_TOOLS,
    systemPrompt: systemAppend
      ? { type: "preset", preset: "claude_code", append: systemAppend }
      : { type: "preset", preset: "claude_code" },
  };

  const stopTyping = startTypingLoop(ctx);

  let reply = "";
  try {
    for await (const msg of query({ prompt, options })) {
      if (msg.type === "result" && msg.subtype === "success") reply = msg.result || "";
    }
  } catch (err) {
    reply = `Error: ${err.message}`;
  } finally {
    stopTyping();
  }

  reply = reply || "(no response)";
  await appendChatMessage(OWNER_USER_ID, "assistant", reply);

  for (const chunk of chunkForTelegram(reply)) {
    const html = mdToTelegramHtml(chunk);
    try {
      await ctx.reply(html, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch (err) {
      console.error("HTML send failed:", err.message, "— retrying as plain text");
      await ctx.reply(chunk).catch((e) => console.error("plain send failed:", e.message));
    }
  }
}

// ── Handlers ─────────────────────────────────────────────────────────────

bot.on("text", async (ctx) => {
  const text = ctx.message.text || "";
  if (text.startsWith("/")) {
    const reply = await handleSlashCommand({ userId: OWNER_USER_ID, command: text });
    if (reply) await ctx.reply(reply, { link_preview_options: { is_disabled: true } });
    return;
  }
  await runAndReply(ctx, { logged: text, prompt: text });
});

// Photos: download the biggest size, drop it on disk, and tell Claude where
// to find it. Claude Code's Read tool natively handles images via vision, so
// we don't need streaming-input mode in the SDK.
bot.on("photo", async (ctx) => {
  const photos = ctx.message.photo || [];
  if (photos.length === 0) return;
  const largest = photos[photos.length - 1];
  const caption = ctx.message.caption || "";

  if (largest.file_size && largest.file_size > MAX_FILE_BYTES) {
    return ctx.reply(`That image is too big — max is ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB.`).catch(() => {});
  }

  let savedPath;
  try {
    savedPath = await downloadTelegramFile(ctx, largest.file_id, `${largest.file_unique_id}.jpg`);
  } catch (err) {
    return ctx.reply(`Couldn't download that image: ${err.message}`).catch(() => {});
  }

  const fileNote = `[The user just sent an image. It's saved on this server at ${savedPath}. Open it with the Read tool to see what they want help with.]`;
  const promptText = caption
    ? `${fileNote}\n\n${caption}`
    : `${fileNote}\n\nTake a look at this image and let me know what you make of it or what they likely want.`;

  await runAndReply(ctx, {
    logged: caption ? `[image] ${caption}` : "[image]",
    prompt: promptText,
  });
});

// Documents: PDFs, CSVs, code, anything attached as a "file" rather than a photo.
// Claude Code's Read tool reads PDFs and notebooks natively; for plain text /
// code / data files Read or Bash work fine. We just stage the bytes and point
// Claude at them.
bot.on("document", async (ctx) => {
  const doc = ctx.message.document;
  if (!doc) return;
  const caption = ctx.message.caption || "";

  if (doc.file_size && doc.file_size > MAX_FILE_BYTES) {
    return ctx.reply(`That file is too big — max is ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB.`).catch(() => {});
  }

  let savedPath;
  try {
    savedPath = await downloadTelegramFile(ctx, doc.file_id, doc.file_name || "document");
  } catch (err) {
    return ctx.reply(`Couldn't download that file: ${err.message}`).catch(() => {});
  }

  const niceName = doc.file_name || "file";
  const mime     = doc.mime_type || "unknown type";

  const fileNote =
    `[The user sent a file: "${niceName}" (${mime}, saved at ${savedPath}). ` +
    `Open it with the Read tool — it handles PDFs and images via vision, plain-text/code natively. ` +
    `Use Bash for formats Read can't open.]`;

  const promptText = caption
    ? `${fileNote}\n\n${caption}`
    : `${fileNote}\n\nWhat's in this and what would you like to do with it?`;

  await runAndReply(ctx, {
    logged: caption ? `[file: ${niceName}] ${caption}` : `[file: ${niceName}]`,
    prompt: promptText,
  });
});

// Background loops — every bot container runs its own sweep, scoped to its owner.
setInterval(() => heartbeat(OWNER_USER_ID).catch((e) => console.error("heartbeat:", e.message)), 30_000);
setInterval(() => flushIdleSessions(OWNER_USER_ID).catch((e) => console.error("flush:", e.message)), 30_000);

bot.launch().then(() => console.log(`[bot:${BOT_NAME}] listening for ${OWNER_EMAIL || OWNER_USER_ID}`));
process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
