// LLM-driven fact extraction via Claude Agent SDK.
// Uses the same SDK the bot uses — no direct Anthropic API calls anywhere.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { CATEGORIES } from "@cogent42-team/shared/categories";

const CHAT_PROMPT = `You are a knowledge extractor for a team brain. Given a transcript between a single user and their AI agent, extract facts worth remembering for future sessions.

CATEGORIES (use exactly one per fact):
- "server"     — server specs, OS, installed software, ports, services
- "project"    — codebases, repos, tech stack, architecture decisions
- "preference" — how the user likes things done (PRIVATE, never shared with team)
- "decision"  — important choices that affect future work
- "bug"        — known issues, workarounds
- "config"     — env vars, service configs (NOT secrets)
- "rule"       — hard constraints, user corrections (PRIVATE, never shared)
- "workflow"   — proven multi-step approaches
- "mistake"    — failures and how they were fixed
- "personal"   — anything about the user themselves, family, salary, health, feelings about coworkers (ALWAYS PRIVATE)

IMPORTANCE:
- "permanent" — rules, credentials, core infra, long-term preferences. Never forget.
- "normal"    — temporary context, one-off tasks, may become stale.

CRITICAL PRIVACY RULES:
- Mark "personal" for any first-person sensitive content (compensation, health, family, opinions about coworkers).
- Mark "preference" or "rule" for things specific to this user's working style. These never reach teammates.
- Anything else (project, decision, server, bug, config, workflow, mistake) is shared with the team — only extract if it's genuinely useful to teammates.
- When in doubt about whether a fact is sensitive, classify as "personal".

Return ONLY a valid JSON array. Each entry: {"fact": "...", "category": "...", "importance": "permanent"|"normal"}.
Return [] if nothing new is worth remembering. No prose, no markdown.`;

const GMAIL_PROMPT = `You are a knowledge extractor for a team brain. Given a sent email (or thread the user participated in), extract facts worth remembering.

CATEGORIES: ${CATEGORIES.join(", ")}.

This content is from a SENT email — it's something the user explicitly wrote and chose to externalize. Bias toward extracting decisions, commitments, status updates, and project-relevant information. Do not extract small-talk, salutations, or pleasantries.

Privacy: emails about compensation, HR matters, health, or anyone's personal life → category "personal". Project/work content → its appropriate category.

Return ONLY a valid JSON array of {"fact","category","importance"} entries, or [] if nothing useful.`;

async function runExtraction(prompt) {
  let resultText = "";
  for await (const msg of query({
    prompt,
    options: {
      maxTurns: 1,
      model: "claude-sonnet-4-6",
      permissionMode: "plan",        // no tools, just generation
      allowedTools: [],
    },
  })) {
    if (msg.type === "result" && msg.subtype === "success") resultText = msg.result || "";
  }
  const m = resultText.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function extractFromChat(job) {
  const messages = job.payload?.messages || [];
  if (messages.length < 3) return [];
  const transcript = messages
    .slice(-30)
    .map((m) => `${m.role}: ${String(m.content).slice(0, 800)}`)
    .join("\n\n");
  return runExtraction(`${CHAT_PROMPT}\n\nTranscript:\n${transcript}`);
}

export async function extractFromGmail(job) {
  const { subject = "", from = "", to = "", date = "", body = "" } = job.payload || {};
  if (!body || body.length < 40) return [];
  const trimmed = String(body).slice(0, 6000);
  return runExtraction(
    `${GMAIL_PROMPT}\n\nFrom: ${from}\nTo: ${to}\nDate: ${date}\nSubject: ${subject}\n\nBody:\n${trimmed}`
  );
}
