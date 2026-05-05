// Drains extraction_jobs queue. One worker serves all users.
// Pg-as-queue: SELECT … FOR UPDATE SKIP LOCKED.

import { promises as fs } from "node:fs";
import path from "node:path";

import { pool, audit } from "@cogent42-team/db";
import { extractFromChat, extractFromGmail } from "./extract.js";
import { writeFacts } from "./write.js";

const CONCURRENCY  = parseInt(process.env.EXTRACTION_CONCURRENCY || "4", 10);
const POLL_IDLE_MS = 2_000;

async function leaseJob() {
  // Atomically claim one pending job.
  const { rows } = await pool.query(
    `WITH next AS (
       SELECT id FROM extraction_jobs
        WHERE status = 'pending' AND attempts < 5
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE extraction_jobs ej
        SET status = 'processing', attempts = ej.attempts + 1, started_at = now()
       FROM next WHERE ej.id = next.id
     RETURNING ej.*`
  );
  return rows[0] || null;
}

async function completeJob(id, result) {
  await pool.query(
    `UPDATE extraction_jobs SET status = 'done', completed_at = now(), error = NULL WHERE id = $1`,
    [id]
  );
}

async function failJob(id, err) {
  await pool.query(
    `UPDATE extraction_jobs
        SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
            error = $2
      WHERE id = $1`,
    [id, String(err.message || err).slice(0, 500)]
  );
}

/**
 * For gmail jobs that carried attachments, every file lives under one
 * per-message directory written by the gmail-worker. Returns that dir or null.
 * Cleanup runs in finally so we delete the staged files whether extraction
 * succeeded or failed (otherwise large PDFs leak forever on the shared volume).
 */
function attachmentDirForJob(job) {
  if (job.source !== "gmail") return null;
  const atts = job.payload?.attachments;
  if (!Array.isArray(atts) || atts.length === 0) return null;
  const first = atts.find((a) => a && a.path);
  return first ? path.dirname(first.path) : null;
}

async function runOne() {
  const job = await leaseJob();
  if (!job) return false;

  const attachmentDir = attachmentDirForJob(job);

  try {
    let facts = [];
    if (job.source === "chat")  facts = await extractFromChat(job);
    if (job.source === "gmail") facts = await extractFromGmail(job);

    if (facts.length > 0) {
      const written = await writeFacts({ userId: job.user_id, source: job.source, sourceRef: job.source_ref, facts });
      await audit({
        actorUserId: job.user_id, actorRole: "extractor", action: "extract",
        targetType: "user", targetId: job.user_id,
        payload: {
          source:      job.source,
          ref:         job.source_ref,
          written:     written.length,
          attachments: job.payload?.attachments?.length || 0,
        },
      });
    }
    await completeJob(job.id);
    console.log(`[extractor] job ${job.id.slice(0,8)} (${job.source}) → ${facts.length} facts`);
  } catch (err) {
    console.error(`[extractor] job ${job.id} failed:`, err.message);
    await failJob(job.id, err);
  } finally {
    if (attachmentDir) {
      await fs.rm(attachmentDir, { recursive: true, force: true }).catch((e) =>
        console.error(`[extractor] cleanup ${attachmentDir} failed:`, e.message)
      );
    }
  }
  return true;
}

async function workerLoop(slot) {
  while (true) {
    const did = await runOne().catch((e) => { console.error(`[worker ${slot}]`, e.message); return false; });
    if (!did) await new Promise((r) => setTimeout(r, POLL_IDLE_MS));
  }
}

console.log(`[extractor] starting ${CONCURRENCY} workers`);
for (let i = 0; i < CONCURRENCY; i++) workerLoop(i);
