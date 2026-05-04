# cogent42-team

> Self-hosted team brain. One Telegram agent per teammate. Postgres-backed shared knowledge with per-fact ACLs. Gmail-aware (sent-only by default). Built on the Claude Agent SDK.

cogent42-team is the multi-user evolution of [cogent42](https://github.com/cogent42/cogent42) — instead of a single Telegram bot giving one developer Claude Code on their server, an entire team gets one bot each, and the bots **share what they learn** through a single Postgres knowledge base. Every project decision, server fact, workflow, and bug fix flows into the team brain. Personal preferences, rules, and sensitive content stay private.

It is designed to run on a single Docker host with one `docker compose up -d` and grow from there.

---

## Status

**v0.1 — alpha scaffold.** All pieces are wired end-to-end but the system has not yet been battle-tested in production. The architecture is the deliberate part; the polish will follow.

What works:
- ✅ Postgres schema + migrations (pgvector for hybrid retrieval)
- ✅ Control-plane HTTP API + minimal admin UI
- ✅ Per-user Telegram bots, provisioned on demand by the control-plane via the Docker socket
- ✅ Bot uses Claude Agent SDK (Claude Code preset), reads/writes shared knowledge from Postgres
- ✅ Async `extractor-worker` turns chat transcripts and emails into facts
- ✅ `gmail-worker` polls each connected user's `SENT` mailbox (default: also expands to threads they replied in)
- ✅ Per-fact ACLs (`private` / `team`), default-by-category, with a hard "personal" bucket that never crosses user lines
- ✅ Vector dedup at write time (cosine < 0.10 → supersede) so the brain doesn't drown in duplicates
- ✅ Audit log on every read/write/admin action

What's stubbed or pending:
- ⏳ End-to-end integration test
- ⏳ Magic-link admin auth (currently a single shared `ADMIN_TOKEN`)
- ⏳ Gmail History API cursor (currently uses `newer_than:7d` + idempotency dedup — fine for v0, less efficient at scale)
- ⏳ User-facing dashboard (only admin UI exists today; users see nothing beyond Telegram)

---

## Architecture in 90 seconds

```
┌──────────────────────────────────────────────────────────────────┐
│  docker compose up -d                                            │
│                                                                  │
│  ┌────────────┐   ┌──────────────┐   ┌────────────────────────┐  │
│  │ postgres   │◄──┤ control-plane│   │ gmail-worker           │  │
│  │ + pgvector │   │ Fastify API  │   │ polls SENT/threads     │  │
│  │            │   │ + admin UI   │   │ enqueues jobs          │  │
│  └────────────┘   └──────────────┘   └────────────────────────┘  │
│       ▲                  │                       │               │
│       │                  │ Docker socket         │ writes        │
│       │                  ▼                       ▼               │
│       │          ┌────────────────────┐   ┌──────────────────┐   │
│       │          │ bot-alice          │   │ extractor-worker │   │
│       └──────────┤ bot-bob            │◄──┤ Claude Agent SDK │   │
│                  │ bot-carol          │   │ embeds + dedups  │   │
│                  │ (one per user)     │   └──────────────────┘   │
│                  └────────────────────┘                          │
└──────────────────────────────────────────────────────────────────┘
```

**Static services** (declared in `docker-compose.yml`): postgres, control-plane, gmail-worker, extractor-worker.

**Dynamic per-user bots**: not in the compose file. The control-plane spawns a `cogent42-team/bot:latest` container for each user via the Docker daemon when the admin clicks "Add user" in the UI. Each bot is a tiny Node process — Telegraf + Claude Agent SDK + a Postgres connection. No per-bot disk state.

---

## Privacy model — the part that matters

The whole product is downstream of one decision: **what gets shared between teammates' bots, and what stays with the individual?**

### Defaults by category

| Category | Default ACL | Why |
|---|---|---|
| `preference` | private | "Alice likes dark mode" — never shared |
| `rule` | private | "Always reply in Hindi" — only meaningful to the owner |
| `personal` | private | Salary, family, opinions about coworkers — sensitive |
| `decision` | team | "We picked Postgres over Mongo" |
| `project` | team | "Q3 launch is gated behind the new feature flag" |
| `server` | team | "Prod runs on ip-10-0-1-5" |
| `bug` | team | "X breaks when Y" |
| `config` | team | "Pinecone uses 1024 dims" |
| `workflow` | team | "Deploys go through staging first" |
| `mistake` | team | "Don't migrate during peak" |

The extractor's prompt is explicit about routing sensitive content to `personal` and erring private when uncertain. Each user has a `share_to_team` flag — flip it off and *everything* that user's bot extracts stays with them.

### Gmail: sent-only by default

The Gmail OAuth grant is `gmail.readonly`, but the worker only ever queries `labelIds=SENT`. Inbox is *never* scanned unless the user explicitly opts into `full_inbox` mode. Sent email is the user's own writing — already passed their internal "is this OK to externalize?" filter — and is ~10× lower volume than inbox.

Modes (per-user `gmail_mode` column):

- `disabled` — Gmail not used
- `sent_only` — only `labelIds=SENT`
- `sent_plus_threads` *(default)* — sent messages + the threads they belong to (so the context the user replied to comes along)
- `labeled_only` — only emails the user tagged with a specific label
- `full_inbox` — explicit opt-in, still excludes drafts/chats

### Audit trail

Every fact read, every admin action, every extraction, every Gmail enqueue is written to `audit_log`. Users can (in a future UI) see who read what, when. The trail is tamper-evident in the sense that ordinary application code only appends — but for a regulated environment you'd want an external SIEM downstream.

---

## Repo layout

```
cogent42-team/
├── apps/
│   ├── control-plane/        # Fastify API + admin UI + Docker provisioning
│   │   ├── src/
│   │   │   ├── index.js      # Fastify bootstrap
│   │   │   ├── routes/       # users, knowledge, audit, gmail (oauth), health
│   │   │   └── lib/          # auth (admin token), docker (Dockerode wrapper)
│   │   ├── public/index.html # Single-page admin UI
│   │   └── Dockerfile
│   ├── bot/                  # Per-user Telegram bot (one container per user)
│   │   └── src/
│   │       ├── index.js      # Telegraf + Claude Agent SDK loop
│   │       ├── prompt.js     # Hybrid retrieval (BM25 + pgvector cosine)
│   │       ├── session.js    # Chat working memory; idle-flush to extraction queue
│   │       ├── commands.js   # /done /forget /private /recent /help
│   │       └── instance.js   # Postgres-backed instance registry
│   ├── extractor-worker/     # Drains extraction_jobs queue
│   │   └── src/
│   │       ├── index.js      # SELECT … FOR UPDATE SKIP LOCKED loop
│   │       ├── extract.js    # Claude Agent SDK fact-extraction prompts
│   │       └── write.js      # Embed → vector-dedup → insert with supersede chain
│   └── gmail-worker/         # Polls each user's SENT mailbox
│       └── src/
│           ├── index.js      # Per-user dispatch loop
│           └── gmail.js      # OAuth, thread expansion, MIME body decode
├── packages/
│   ├── db/                   # Shared pg pool + migrations
│   │   ├── src/index.js      # `pool`, `q`, `tx`, `audit`
│   │   └── migrations/001_init.sql
│   └── shared/
│       └── src/
│           ├── crypto.js     # libsodium secretbox column encryption
│           ├── embeddings.js # OpenAI text-embedding-3-small @ 1024d
│           └── categories.js # Knowledge taxonomy + default ACL map
├── scripts/
│   ├── setup.js              # Interactive .env wizard
│   └── migrate.js            # Apply migrations
├── docker-compose.yml
└── README.md
```

---

## Setup

### Prerequisites

- Linux/macOS host with Docker + Docker Compose (v2)
- Node.js ≥ 20 (only needed on the host for the setup wizard and migrations; runtime services run in containers)
- **Claude Code installed and authenticated on this host.** `npm install -g @anthropic-ai/claude-code`, then run `claude` once interactively to log in. The setup wizard mounts your `~/.claude` into bot and extractor containers, so the Agent SDK uses your existing Claude Code session — no `ANTHROPIC_API_KEY` is involved.
- An OpenAI API key (used only for embeddings, ~$0.02 per million tokens)
- A Google Cloud project with OAuth credentials (only if you want Gmail; can be added later)
- Per user: a Telegram bot token (from @BotFather) and the user's numeric Telegram ID

### One-time setup

```bash
git clone https://github.com/cogent42/cogent42-team.git
cd cogent42-team

# Generates .env with secrets and prompts for keys.
node scripts/setup.js

# Build all images.
npm run build:all

# Start postgres + control-plane + workers.
npm run up

# Apply DB schema.
npm run migrate
```

Open `http://<your-host>:8080` and paste the `ADMIN_TOKEN` printed by the setup script.

### Adding a user

In the admin UI's **Users** tab:

1. Get a Telegram bot token from [@BotFather](https://t.me/BotFather) (the operator does this for each user — BotFather has no API).
2. Get the user's numeric Telegram ID (they can DM `@userinfobot` to find it).
3. Fill the form: email, name, telegram user ID, bot name, bot token.
4. Hit "Provision bot."

The control-plane:
- Inserts a row in `users` (status: `provisioning`)
- Encrypts the Telegram token with `MASTER_KEY` and stores it in `user_secrets`
- Calls `docker run cogent42-team/bot:latest` with the user's env injected
- Marks the user `active`

Total elapsed: ~3 seconds. The user can immediately DM their bot.

### Connecting Gmail (per user)

1. In the Google Cloud Console, create OAuth credentials with the redirect URI pointing to your control-plane's `/api/gmail/oauth/callback`.
2. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`, restart the control-plane.
3. Per-user: hit `GET /api/gmail/oauth/start/<user_id>` with the admin bearer token to get a consent URL. Send it to the user. They consent. Their refresh token gets encrypted and stored. The gmail-worker picks them up on its next 60-second tick.

---

## Bot commands (Telegram)

| Command | Effect |
|---|---|
| (any text) | Ask Claude Code, with hybrid-retrieved knowledge injected into the system prompt |
| (photo / file) | Upload via Telegram; the bot saves it under `/tmp/cogent42-uploads/` inside its container and tells Claude where to find it. Claude Code's `Read` tool handles images (vision) and PDFs natively. |
| `/done` | Flush the current chat session for fact extraction (default is idle-flush after 60s) |
| `/recent` | Show the last 10 facts extracted from this user |
| `/forget <text>` | Soft-delete the top 3 facts matching the text fragment |
| `/private <id-prefix>` | Flip a fact's ACL from `team` to `private` |
| `/gmail` | DM the user a Google OAuth consent URL — read-only, sent-only by default |
| `/me` | DM the user a one-time link to their personal web dashboard (10-min single-use, 10-min session) |
| `/help` | Command reference |

### `/me` web dashboard

`/me` mints a magic link with a 256-bit token. The token is hashed (SHA-256) and stored in `user_sessions(kind='magic_link')` with a 10-minute expiry; the bot replies with the raw token in the URL. When the user visits `…/me/login?t=<raw>`, the control-plane atomically `UPDATE … RETURNING` claims the link (single-use), mints a fresh session token, sets it as an `HttpOnly; Secure; SameSite=Lax` cookie with `Max-Age=600`, and 302s to `/me`. The dashboard's API endpoints (`/api/me/*`) use the same cookie middleware (`requireMeSession`), and every call is scoped to the caller's `user_id` server-side — there's no path that lets one user see another's facts.

---

## How the team brain actually works

Two flows, both end at the same place: rows in `knowledge_entries`.

### 1. Chat → facts (the high-signal stream)

```
Telegram chat ends (60s idle, or /done)
  → bot inserts row in extraction_jobs (source='chat', payload={messages})
  → extractor-worker: SELECT … FOR UPDATE SKIP LOCKED, leases the job
  → Claude Agent SDK call (Sonnet 4.6, maxTurns=1, no tools)
       prompt: "Extract facts from this transcript. Categories: ..."
       returns: [{fact, category, importance}, ...]
  → for each fact:
      embed via OpenAI text-embedding-3-small @ 1024d
      vector-search owner's existing facts; if cosine < 0.20 → supersede
      INSERT INTO knowledge_entries (acl resolved by category + share_to_team flag)
  → if owner crosses 80% of MAX_KNOWLEDGE_ENTRIES, AI-driven consolidation
      runs (throttled to once per 6h) — Sonnet groups paraphrases into
      canonical rows; merged rows get superseded_by + deleted_at.
  → audit_log row written
```

### 2. Gmail → facts

```
gmail-worker tick (every 60s)
  → list active users with refresh tokens
  → for each: query SENT (or labeled_only / full_inbox per user setting)
      thread-expansion: also fetch any thread the user replied in
  → for each new message_id (idempotent on owner_user_id+source+source_ref):
      enqueue extraction_jobs (source='gmail', payload={subject,from,to,date,body})
  → extractor-worker drains the same queue (no separate worker code path)
```

### Retrieval (read path) — per-bot, per-turn

When you DM your bot, before calling Claude Code, the bot runs:

```sql
SELECT … FROM knowledge_entries
WHERE deleted_at IS NULL AND superseded_by IS NULL
  AND last_seen_at > now() - interval '90 days'
  AND category NOT IN ('preference','rule','personal')
  AND (owner_user_id = :me OR acl IN ('team','org'))
  AND ( fact_tsv @@ plainto_tsquery('simple', :prompt)
        OR (embedding <=> :q_embedding) < 0.45 )
ORDER BY (
  ts_rank(fact_tsv, plainto_tsquery('simple', :prompt))
  + (1 - (embedding <=> :q_embedding))
  + CASE WHEN owner_user_id = :me THEN 0.2 ELSE 0 END     -- own-knowledge boost
  + CASE WHEN importance = 'permanent' THEN 0.1 ELSE 0 END
) DESC
LIMIT 30;
```

Plus an unconditional fetch of the owner's own `rule` entries — those are always injected as `RULES — always follow these, no exceptions:`.

The 30 facts are formatted as `- [decision from alice@org] We picked Postgres over Mongo` and appended to the Claude Code preset system prompt. Provenance is preserved so Claude knows which facts came from this user vs. a teammate.

---

## Cost back-of-envelope

Per user, per day, assuming 20 chat sessions and 50 sent emails:
- Extraction LLM (Sonnet 4.6): ~70 calls × ~$0.005 = $0.35
- Embeddings (OpenAI 3-small @ 1024d): ~150 facts × ~$0.00002 = negligible
- Per-prompt embedding (read path): ~50 prompts × ~$0.00002 = negligible
- Postgres + connector overhead: noise
- **Total: ~$0.40/user/day at heavy use, well under $15/user/month.**

Bot conversations themselves use Claude Opus 4.6 by default — that cost dwarfs extraction and varies wildly with the work the user asks for. Cap with `EXTRACTION_CONCURRENCY` and per-user budgets if needed.

---

## Configuration reference

All env vars live in `.env`. Generated by `scripts/setup.js`; see `.env.example` for the source.

| Var | What it does |
|---|---|
| `DATABASE_URL` | Postgres connection string (host-side; uses `127.0.0.1:5432` to reach the published port) |
| `MASTER_KEY` | 32-byte base64 key for column encryption |
| `ADMIN_TOKEN` | Bearer token for admin API + UI |
| `ADMIN_CONTACT_EMAIL` | Optional. Surfaced on the public landing page so users know who to ask for provisioning. Leave blank for generic copy. |
| `CLAUDE_CODE_HOME` | Host path to your `~/.claude`. Bind-mounted into bot/extractor containers; the Agent SDK uses your existing Claude Code session, so no `ANTHROPIC_API_KEY` is needed. |
| `OPENAI_API_KEY` | For embeddings only |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail OAuth (optional) |
| `GOOGLE_OAUTH_REDIRECT_URI` | Must match what's registered in GCP |
| `CONTROL_PLANE_PUBLIC_URL` | The public-facing URL of the control-plane (e.g. `https://your-host`). Used by `/me` to mint magic-link URLs and by `setup.js` to derive the OAuth redirect. |
| `BOT_IMAGE` | Image used when provisioning per-user bots |
| `BOT_MEM_LIMIT` / `BOT_CPU_LIMIT` | Resource caps per bot container |
| `EXTRACTION_CONCURRENCY` | How many extraction jobs run in parallel |
| `GMAIL_POLL_INTERVAL_SEC` | How often the gmail-worker polls each user (default 60s) |
| `KNOWLEDGE_FRESHNESS_DAYS` | Facts older than this aren't injected into prompts (default 90) |

---

## Security notes

- **Docker socket = root-equivalent.** The control-plane mounts `/var/run/docker.sock` so it can provision bots. Anyone who pwns the control-plane owns the host. Acceptable for a self-hosted org-internal v0; for SaaS, switch to Sysbox / rootless Docker / a dedicated provisioner with a narrowed API.
- Admin auth in v0 is a **single shared bearer token**. Replace with magic-link / SSO before exposing the control-plane to the public internet.
- All sensitive columns (Telegram bot tokens, Gmail refresh tokens) are encrypted with `MASTER_KEY` (libsodium secretbox). Rotating `MASTER_KEY` is not yet automated — store it carefully.
- Bot containers are per-user-isolated by Docker, but they share a Postgres. ACLs live in application code (the read query enforces them), not in row-level security. This is sufficient for honest-but-curious teammates and an admin you trust; not sufficient if you have actively malicious tenants.
- The Anthropic + OpenAI keys are shared platform-wide. Day-2 work: per-user BYO-key.

---

## Origins

cogent42-team is a generalization of [cogent42](https://github.com/cogent42/cogent42), a single-user Telegram-to-Claude-Code bot. cogent42 already had cross-instance knowledge sharing via filesystem markers in `~/.cogent42/instances/*.json` — this repo replaces those markers with Postgres, swaps per-instance JSON files for a unified `knowledge_entries` table, and adds the missing pieces a team install needs: ACLs, audit, encryption-at-rest, async extraction, Gmail.

The interface Claude sees (`- [category from source] fact` lines in the system prompt) is unchanged. Everything underneath was rebuilt.

---

## License

MIT. See `LICENSE`.
