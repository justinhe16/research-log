import { EMBEDDING_MODEL } from "@/lib/constants";

/** Feature-extraction pipelines are big; anything past a couple thousand chars
 *  is truncated by the model anyway, so trim before we pay to tokenize it. */
const MAX_EMBED_CHARS = 2000;

// `pipeline` returns a loosely-typed callable; we only care about the one call
// shape we use, so describe it narrowly instead of importing the library types.
type FeatureExtractor = (
  text: string | string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ data: Float32Array | number[]; dims?: number[] }>;

// Cached on globalThis so Next's dev HMR doesn't re-download / re-init the model
// on every reload of this module.
const globalForEmbedding = globalThis as unknown as {
  __researchLogEmbedder?: Promise<FeatureExtractor>;
};

function loadPipeline(): Promise<FeatureExtractor> {
  return (async () => {
    const { pipeline } = await import("@huggingface/transformers");
    const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, {
      dtype: "fp32",
    });
    return extractor as unknown as FeatureExtractor;
  })();
}

let extractorPromise: Promise<FeatureExtractor> | undefined =
  globalForEmbedding.__researchLogEmbedder;

function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = loadPipeline().catch((err) => {
      // Don't cache a failed load -- a transient network blip during the model
      // download would otherwise poison every later call.
      extractorPromise = undefined;
      globalForEmbedding.__researchLogEmbedder = undefined;
      throw err;
    });
    globalForEmbedding.__researchLogEmbedder = extractorPromise;
  }
  return extractorPromise;
}

/** Embed text into a normalized 384-dim vector using the local MiniLM model. */
export async function embed(text: string): Promise<Float32Array> {
  const input = (text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_EMBED_CHARS);
  if (!input) throw new Error("embed(): refusing to embed empty text");

  const extractor = await getExtractor();
  const output = await extractor(input, { pooling: "mean", normalize: true });
  const data = output.data;
  return data instanceof Float32Array ? data : Float32Array.from(data);
}

export type EmbedManyOptions = {
  batchSize?: number;
  /** Called after each batch with the number of texts embedded so far. */
  onProgress?: (done: number, total: number) => void;
};

/** Embed many texts in batches through the same cached pipeline as `embed`.
 *  Yields to the event loop between batches so a long run doesn't starve
 *  request handling. Empty (after trimming) texts are rejected, like `embed`. */
export async function embedMany(
  texts: readonly string[],
  { batchSize = 32, onProgress }: EmbedManyOptions = {},
): Promise<Float32Array[]> {
  const inputs = texts.map((t, i) => {
    const input = (t ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_EMBED_CHARS);
    if (!input) throw new Error(`embedMany(): refusing to embed empty text at index ${i}`);
    return input;
  });
  if (inputs.length === 0) return [];

  const size = Math.max(1, Math.floor(batchSize));
  const extractor = await getExtractor();
  const out: Float32Array[] = [];
  for (let start = 0; start < inputs.length; start += size) {
    const batch = inputs.slice(start, start + size);
    const output = await extractor(batch, { pooling: "mean", normalize: true });
    const data = output.data;
    const dim = output.dims?.[output.dims.length - 1] ?? data.length / batch.length;
    if (!Number.isInteger(dim) || dim * batch.length !== data.length) {
      throw new Error(`embedMany(): unexpected output shape for a batch of ${batch.length}`);
    }
    for (let j = 0; j < batch.length; j++) {
      // Copy so each vector owns its memory rather than viewing the batch tensor.
      out.push(Float32Array.from(data.slice(j * dim, (j + 1) * dim)));
    }
    onProgress?.(out.length, inputs.length);
    if (start + size < inputs.length) await new Promise<void>((r) => setImmediate(r));
  }
  return out;
}

/** Cosine similarity. Vectors from `embed` are already unit-normalized, so this
 *  is just a dot product -- but stay honest about mismatched / zero vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (!Number.isFinite(denom) || denom === 0) return 0;
  const score = dot / denom;
  // Clamp: floating point can push a self-comparison a hair past 1.
  return Math.max(-1, Math.min(1, score));
}

/** Float32Array -> BLOB bytes. Copies, so the buffer never aliases a live view. */
export function toBuffer(v: Float32Array): Buffer {
  return Buffer.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
}

/** BLOB bytes -> Float32Array. Node pools small Buffers into a shared
 *  ArrayBuffer, so byteOffset matters and the length must be re-derived. */
export function fromBuffer(b: Buffer): Float32Array {
  if (b.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(
      `fromBuffer(): ${b.byteLength} bytes is not a whole number of float32s`,
    );
  }
  // Copy out of the pooled ArrayBuffer so the view owns its own memory.
  const copy = new Uint8Array(b.byteLength);
  copy.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
  return new Float32Array(copy.buffer);
}
