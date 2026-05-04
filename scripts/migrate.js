#!/usr/bin/env node
// Apply SQL migrations from packages/db/migrations in lexical order.
// Tracks applied migrations in a `_migrations` table.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIG_DIR = join(__dirname, "..", "packages", "db", "migrations");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set. Run via: node --env-file=.env scripts/migrate.js");
  process.exit(1);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });

async function main() {
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const applied = new Set(
    (await client.query(`SELECT name FROM _migrations`)).rows.map((r) => r.name)
  );

  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
  let ran = 0;
  for (const f of files) {
    if (applied.has(f)) { console.log(`✓  ${f} (already applied)`); continue; }
    const sql = readFileSync(join(MIG_DIR, f), "utf-8");
    console.log(`→  applying ${f}…`);
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query(`INSERT INTO _migrations (name) VALUES ($1)`, [f]);
      await client.query("COMMIT");
      console.log(`✅  ${f}`);
      ran++;
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`❌  ${f}: ${err.message}`);
      throw err;
    }
  }
  if (ran === 0) console.log("Nothing to do.");
  await client.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
