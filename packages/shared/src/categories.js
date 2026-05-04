// Knowledge taxonomy — single source of truth for every service.

export const CATEGORIES = [
  "server",       // server specs, OS, installed software, services
  "project",      // codebases, repos, tech stack, architecture decisions
  "preference",   // how the user likes things done — PRIVATE
  "decision",     // important choices that affect future work
  "bug",          // known issues, workarounds
  "config",       // env vars, service configs (NOT credentials)
  "rule",         // hard constraints, user corrections — PRIVATE
  "workflow",     // proven multi-step approaches
  "mistake",      // failures and how they were fixed
  "personal",     // personal/sensitive content — ALWAYS PRIVATE
];

export const PRIVATE_CATEGORIES = new Set(["preference", "rule", "personal"]);

/**
 * Default ACL given a category. Chat extraction defers to this; admin UI may override per-row.
 *   private: visible only to owner
 *   team:    visible to all users in this org
 *   org:     reserved for future multi-org deployments (treated same as team for v0)
 */
export function defaultAclFor(category) {
  return PRIVATE_CATEGORIES.has(category) ? "private" : "team";
}

export const IMPORTANCE = ["normal", "permanent"];

// Maximum entries injected into the bot's system prompt per turn.
export const MAX_INJECTED_ENTRIES = 30;

// Maximum total entries kept per user (soft cap; pruning drops oldest non-permanent first).
export const MAX_KNOWLEDGE_ENTRIES = 5000;
