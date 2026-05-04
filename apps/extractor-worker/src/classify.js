// Topic-aware paraphrase / contradiction classifier.
//
// writeFacts() invokes this once per extraction job, batching every (new fact,
// existing candidate) pair where the new fact tripped the loose-similarity net
// (cosine 0.20–0.35 OR BM25 token overlap) but didn't trip the strict <0.20
// paraphrase dedup. We ask Sonnet to label each pair so the writer can act:
//
//   paraphrase     — same claim, just reworded.   Reinforce existing (++evidence_count).
//   contradiction  — same axis, conflicting value. Mark old contradicted; insert new
//                     with supersede chain so retrieval prefers the newer assertion.
//   unrelated      — different subject or orthogonal scope. Insert new normally.
//
// Why batched and not per-fact: an extraction job can produce 5–30 facts. Per-fact
// LLM calls would multiply latency by an order of magnitude with no quality win —
// the prompt is independent across pairs. One Sonnet round-trip handles every pair
// in the job.
//
// Why a 7-day age floor lives in writeFacts (the caller), not here: this module
// just classifies what it's given. The caller is responsible for excluding very
// recent facts so an active conversation refining a topic ("we want X… actually Y…")
// doesn't auto-resolve as a contradiction inside the same hour.

import { query } from "@anthropic-ai/claude-agent-sdk";

const PROMPT = `You classify pairs of facts in a personal knowledge base.

For each (NEW, EXISTING) pair below, classify EXISTING relative to NEW as exactly one of:
- "paraphrase"    — same claim, restated. Same subject, same predicate, same scope. Differences are wording only.
- "contradiction" — same subject and same predicate-axis, but the values disagree. NEW would invalidate or supersede EXISTING. Examples:
                    * "Production runs on us-east-1" vs "We migrated production to ap-south-1"
                    * "We pay net-30" vs "Payment terms are net-15 starting Q3"
                    * "Default model is sonnet-4" vs "Default model is opus-4-7"
- "unrelated"     — different subject, or related-but-orthogonal scopes. Both can be true at once.

Be conservative. If unsure, prefer "unrelated". A contradiction must have a clear value clash on the same axis — different aspects of the same topic do NOT contradict.

Pairs:
{{PAIRS}}

Output ONLY a JSON array, one entry per pair:
[{"pair_id":"<id>","class":"paraphrase|contradiction|unrelated"}, ...]
No prose, no markdown.`;

const VALID = new Set(["paraphrase", "contradiction", "unrelated"]);

function truncate(s, n) {
  s = String(s || "").replace(/\s+/g, " ");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Classify a list of (new fact, existing fact) pairs.
 *
 * Returns a Map<pair_id, "paraphrase" | "contradiction" | "unrelated">.
 * Pairs the model failed to classify are simply absent from the map; callers
 * default to "unrelated" (insert as-is) — the conservative choice.
 */
export async function classifyPairs(pairs) {
  if (!pairs || pairs.length === 0) return new Map();

  const block = pairs
    .map((p) =>
      `[${p.pair_id}]\n` +
      `  NEW       : ${truncate(p.newFact, 240)}\n` +
      `  EXISTING  : (${p.existingCategory}) ${truncate(p.existingFact, 240)}`
    )
    .join("\n\n");
  const prompt = PROMPT.replace("{{PAIRS}}", block);

  let resultText = "";
  try {
    for await (const msg of query({
      prompt,
      options: { maxTurns: 1, model: "claude-sonnet-4-6", permissionMode: "plan", allowedTools: [] },
    })) {
      if (msg.type === "result" && msg.subtype === "success") resultText = msg.result || "";
    }
  } catch (err) {
    console.error("[classify] sdk error:", err.message);
    return new Map();
  }

  const m = resultText.match(/\[[\s\S]*\]/);
  if (!m) return new Map();

  let arr;
  try { arr = JSON.parse(m[0]); } catch { return new Map(); }
  if (!Array.isArray(arr)) return new Map();

  const out = new Map();
  for (const r of arr) {
    if (r && typeof r === "object" && typeof r.pair_id === "string" && VALID.has(r.class)) {
      out.set(r.pair_id, r.class);
    }
  }
  return out;
}
