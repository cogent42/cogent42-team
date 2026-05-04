// Drains extraction_jobs queue. One worker serves all users.
// Pg-as-queue: SELECT … FOR UPDATE SKIP LOCKED.

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

async function runOne() {
  const job = await leaseJob();
  if (!job) return false;

  try {
    let facts = [];
    if (job.source === "chat")  facts = await extractFromChat(job);
    if (job.source === "gmail") facts = await extractFromGmail(job);

    if (facts.length > 0) {
      const written = await writeFacts({ userId: job.user_id, source: job.source, sourceRef: job.source_ref, facts });
      await audit({
        actorUserId: job.user_id, actorRole: "extractor", action: "extract",
        targetType: "user", targetId: job.user_id,
        payload: { source: job.source, ref: job.source_ref, written: written.length },
      });
    }
    await completeJob(job.id);
    console.log(`[extractor] job ${job.id.slice(0,8)} (${job.source}) → ${facts.length} facts`);
  } catch (err) {
    console.error(`[extractor] job ${job.id} failed:`, err.message);
    await failJob(job.id, err);
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
