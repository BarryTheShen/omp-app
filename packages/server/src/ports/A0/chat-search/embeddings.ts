/**
 * An OpenAI-style embedding service: `POST <address>/embeddings` with `{ model, input: [...] }`, answered with
 * `{ data: [{ index, embedding }] }` (Hugging Face Text Embeddings Inference, OpenAI, and most others answer so).
 */

/**
 * How many texts go in one request: few, so a service on a CPU answers each in well under the timeout (Text Embeddings
 * Inference on a 20-core CPU took 2.6 s for one 1,500-character passage, 26 s for 8 and 124 s for 32, 2026-11-16).
 */
export const BATCH = 8;
/** How long one request may take. */
export const TIMEOUT_MS = 120_000;

export interface EmbeddingService {
  readonly address: string;
  readonly model: string;
  readonly key: string | null;
}

/** The service's own words when it refused, cut short: a page shows them. */
function said(status: number, body: string): string {
  let message = body.trim();
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    const error = parsed.error;
    if (typeof error === "string") message = error;
    else if (
      typeof error === "object" &&
      error !== null &&
      typeof (error as { message?: unknown }).message === "string"
    )
      message = (error as { message: string }).message;
    else if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // Not JSON: its text as it is.
  }
  return `the embedding service answered ${status}${message === "" ? "" : `: ${message.slice(0, 300)}`}`;
}

/** The vectors for `texts`, in their order; a refusal or a malformed answer throws, in words. */
export async function embed(
  service: EmbeddingService,
  texts: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Float32Array[]> {
  const vectors: Float32Array[] = [];
  for (let start = 0; start < texts.length; start += BATCH) {
    const input = texts.slice(start, start + BATCH);
    let response: Response;
    try {
      response = await fetchImpl(`${service.address}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(service.key === null ? {} : { authorization: `Bearer ${service.key}` }),
        },
        body: JSON.stringify({ model: service.model, input }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (failure) {
      const reason = failure instanceof Error ? failure.message : String(failure);
      throw new Error(
        `the embedding service at ${service.address} could not be reached: ${reason}`,
      );
    }
    const body = await response.text();
    if (!response.ok) throw new Error(said(response.status, body));
    let data: unknown;
    try {
      data = (JSON.parse(body) as { data?: unknown }).data;
    } catch {
      throw new Error("the embedding service's answer is not JSON");
    }
    if (!Array.isArray(data) || data.length !== input.length) {
      throw new Error(
        `the embedding service gave ${Array.isArray(data) ? data.length : "no"} vectors for ${input.length} texts`,
      );
    }
    const ordered = [...data].sort(
      (a, b) =>
        Number((a as { index?: unknown }).index ?? 0) -
        Number((b as { index?: unknown }).index ?? 0),
    );
    for (const item of ordered) {
      const embedding = (item as { embedding?: unknown }).embedding;
      if (
        !Array.isArray(embedding) ||
        embedding.length === 0 ||
        !embedding.every((x) => typeof x === "number")
      ) {
        throw new Error("the embedding service gave a vector that is not a list of numbers");
      }
      vectors.push(Float32Array.from(embedding as number[]));
    }
  }
  return vectors;
}
