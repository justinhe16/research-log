export const CATEGORIES = [
  "Alignment",
  "Interpretability",
  "RL",
  "Capabilities",
  "Systems",
  "Evals",
  "Policy",
  "Other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const STATUSES = ["to-read", "skimmed", "read", "revisit"] as const;
export type Status = (typeof STATUSES)[number];

export const CONTENT_TYPES = ["paper", "blog", "post", "docs", "video", "other"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const INGEST_STATUSES = ["pending", "fetching", "summarizing", "embedding", "done", "error"] as const;
export type IngestStatus = (typeof INGEST_STATUSES)[number];

/** Cheap, fast model for extraction. */
export const SUMMARY_MODEL = "claude-haiku-4-5-20251001";
/** Local sentence-transformer used for similarity vectors. */
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;
