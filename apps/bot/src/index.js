// cogent42-team bot — one container per user.
// Per-bot env: OWNER_USER_ID, OWNER_EMAIL, BOT_NAME, TELEGRAM_USER_ID, TELEGRAM_BOT_TOKEN,
//              DATABASE_URL, MASTER_KEY, OPENAI_API_KEY.
// Auth for the Claude Agent SDK comes from /root/.claude (bind-mounted from host CLAUDE_CODE_HOME).

import { Telegraf } from "telegraf";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { pool, audit } from "@cogent42-team/db";

import { buildSystemPrompt } from "./prompt.js";
import { appendChatMessage, flushIdleSessions } from "./session.js";
import { registerInstance, heartbeat } from "./instance.js";
import { handleSlashCommand } from "./commands.js";

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

await registerInstance({ userId: OWNER_USER_ID, botName: BOT_NAME });

// Reject anyone who isn't the bot's owner.
bot.use(async (ctx, next) => {
  if (String(ctx.from?.id) !== ALLOWED_TG_ID) {
    if (ctx.chat) await ctx.reply("This bot is private.").catch(() => {});
    return;
  }
  return next();
});

bot.start((ctx) => ctx.reply(`Hi ${OWNER_EMAIL || ""}. I'm ${BOT_NAME}. Send me anything and I'll work on it on this server.`));

bot.on("text", async (ctx) => {
  const text = ctx.message.text || "";
  if (text.startsWith("/")) {
    const reply = await handleSlashCommand({ userId: OWNER_USER_ID, command: text });
    if (reply) await ctx.reply(reply);
    return;
  }

  await appendChatMessage(OWNER_USER_ID, "user", text);

  // Build system prompt with hybrid-retrieved knowledge for THIS query.
  const systemAppend = await buildSystemPrompt({ userId: OWNER_USER_ID, prompt: text, botName: BOT_NAME });

  const options = {
    maxTurns: 12,
    model: "claude-opus-4-6",
    permissionMode: "default",
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
    systemPrompt: systemAppend
      ? { type: "preset", preset: "claude_code", append: systemAppend }
      : { type: "preset", preset: "claude_code" },
  };

  let reply = "";
  try {
    for await (const msg of query({ prompt: text, options })) {
      if (msg.type === "result" && msg.subtype === "success") reply = msg.result || "";
    }
  } catch (err) {
    reply = `Error: ${err.message}`;
  }

  reply = reply || "(no response)";
  await appendChatMessage(OWNER_USER_ID, "assistant", reply);

  // Telegram caps messages at 4096 chars; chunk if needed.
  for (const chunk of chunkText(reply, 4000)) {
    await ctx.reply(chunk).catch((e) => console.error("send failed:", e.message));
  }
});

function chunkText(s, n) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

// Background loops — every bot container runs its own sweep, scoped to its owner.
setInterval(() => heartbeat(OWNER_USER_ID).catch((e) => console.error("heartbeat:", e.message)), 30_000);
setInterval(() => flushIdleSessions(OWNER_USER_ID).catch((e) => console.error("flush:", e.message)), 30_000);

bot.launch().then(() => console.log(`[bot:${BOT_NAME}] listening for ${OWNER_EMAIL || OWNER_USER_ID}`));
process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
