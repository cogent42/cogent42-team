// Dockerode wrapper for provisioning per-user bot containers.

import Docker from "dockerode";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const BOT_IMAGE        = process.env.BOT_IMAGE     || "cogent42-team/bot:latest";
const BOT_NETWORK      = process.env.BOT_NETWORK   || "cogent42-internal";
const MEM_LIMIT        = process.env.BOT_MEM_LIMIT || "512m";
const CPU_LIMIT        = parseFloat(process.env.BOT_CPU_LIMIT || "0.5");
// Host path forwarded by docker-compose; bind-mounted into each bot container as /root/.claude
// so the Agent SDK's `claude` CLI subprocess uses the host's existing Claude Code session.
const CLAUDE_CODE_HOME = process.env.CLAUDE_CODE_HOME || "";

function parseMem(s) {
  const m = String(s).match(/^(\d+)([kmg]?)$/i);
  if (!m) return 512 * 1024 * 1024;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || "").toLowerCase();
  return unit === "g" ? n * 1024 ** 3 : unit === "m" ? n * 1024 ** 2 : unit === "k" ? n * 1024 : n;
}

export function botContainerName(slug) {
  return `cogent42-bot-${slug}`;
}

/** Create + start a bot container for the given user. Returns {id, name}. */
export async function provisionBot({ user, env }) {
  const name = botContainerName(user.slug);

  // Tear down any pre-existing container with this name (rename collision recovery).
  try {
    const old = docker.getContainer(name);
    await old.stop({ t: 5 }).catch(() => {});
    await old.remove({ force: true }).catch(() => {});
  } catch { /* ignore */ }

  if (!CLAUDE_CODE_HOME) {
    throw new Error("CLAUDE_CODE_HOME not set on control-plane — cannot mount Claude Code session into bot container");
  }

  const Env = Object.entries(env).map(([k, v]) => `${k}=${v}`);

  const container = await docker.createContainer({
    name,
    Image: BOT_IMAGE,
    Env,
    Labels: {
      "cogent42.role": "bot",
      "cogent42.user_id": user.id,
      "cogent42.user_slug": user.slug,
    },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: BOT_NETWORK,
      Memory: parseMem(MEM_LIMIT),
      NanoCpus: Math.round(CPU_LIMIT * 1e9),
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      Binds: [`${CLAUDE_CODE_HOME}:/root/.claude`],
    },
  });

  await container.start();
  return { id: container.id, name };
}

/** Stop + remove a bot container by user slug. Idempotent. */
export async function teardownBot(slug) {
  const name = botContainerName(slug);
  try {
    const c = docker.getContainer(name);
    await c.stop({ t: 10 }).catch(() => {});
    await c.remove({ force: true }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Inspect a bot container's running state. Returns null if it doesn't exist. */
export async function botStatus(slug) {
  const name = botContainerName(slug);
  try {
    const c = docker.getContainer(name);
    const info = await c.inspect();
    return {
      id: info.Id,
      name,
      state: info.State?.Status,           // "running" | "exited" | ...
      startedAt: info.State?.StartedAt,
      restartCount: info.RestartCount,
    };
  } catch {
    return null;
  }
}

/** Tail logs from a bot container. Returns string (stdout+stderr interleaved). */
export async function botLogs(slug, { tail = 200 } = {}) {
  const name = botContainerName(slug);
  const c = docker.getContainer(name);
  const stream = await c.logs({ stdout: true, stderr: true, tail, timestamps: true });
  return stream.toString("utf-8");
}
