// OpenAI text-embedding-3-small @ 1024d.
// Used by extractor-worker (write path) and bot (read-side query embedding).
// Direct HTTP — no SDK dependency, keeps the image small.

const OPENAI_URL = "https://api.openai.com/v1/embeddings";
const MODEL = "text-embedding-3-small";
const DIMENSIONS = 1024;

export async function embed(text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set");
  const input = String(text ?? "").slice(0, 8000); // hard cap to avoid token-limit errors
  if (!input.trim()) return null;

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model: MODEL, input, dimensions: DIMENSIONS }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`embed failed ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  return json.data?.[0]?.embedding ?? null;
}

/** Format a JS number array as a pgvector literal: "[0.1,0.2,...]" */
export function toPgVector(arr) {
  if (!arr) return null;
  return `[${arr.join(",")}]`;
}
