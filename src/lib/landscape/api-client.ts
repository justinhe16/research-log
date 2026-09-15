import { ApiError, request } from "@/lib/api-client";
import type {
  CreateTopicInput,
  CreateTopicResponse,
  DocumentKind,
  LandscapeSnapshot,
  PaperDetail,
  SearchProgress,
  SimilarTopic,
  SimilarTopicsConflict,
  SimilarTopicsInput,
  StartSearchInput,
  TopicCard,
  TopicDetail,
  UpdateTopicInput,
} from "./types";

export { ApiError };

const BASE = "/api/landscape";
const enc = encodeURIComponent;

/** Narrow an ApiError from `createTopic` to the 409 "similar topics exist" case. */
export function similarTopicsFrom(err: unknown): SimilarTopic[] | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const payload = err.payload as Partial<SimilarTopicsConflict> | undefined;
  return Array.isArray(payload?.similar) ? payload.similar : null;
}

export const landscapeApi = {
  listTopics: () => request<{ topics: TopicCard[] }>(`${BASE}/topics`).then((r) => r.topics),

  similarTopics: (input: SimilarTopicsInput) =>
    request<{ similar: SimilarTopic[] }>(`${BASE}/topics/similar`, {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.similar),

  /** Rejects with a 409 ApiError when similar topics exist and `force` is not set;
   *  use `similarTopicsFrom(err)` to read them. */
  createTopic: (input: CreateTopicInput) =>
    request<CreateTopicResponse>(`${BASE}/topics`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  getTopic: (topicId: string) =>
    request<{ topic: TopicDetail }>(`${BASE}/topics/${enc(topicId)}`).then((r) => r.topic),

  updateTopic: (topicId: string, input: UpdateTopicInput) =>
    request<{ topic: TopicCard }>(`${BASE}/topics/${enc(topicId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }).then((r) => r.topic),

  deleteTopic: (topicId: string) =>
    request<{ ok: true }>(`${BASE}/topics/${enc(topicId)}`, { method: "DELETE" }),

  startSearch: (topicId: string, input: StartSearchInput) =>
    request<{ search: SearchProgress }>(`${BASE}/topics/${enc(topicId)}/searches`, {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.search),

  getSearch: (searchId: string) =>
    request<{ search: SearchProgress }>(`${BASE}/searches/${enc(searchId)}`).then((r) => r.search),

  getSnapshot: (searchId: string) =>
    request<{ snapshot: LandscapeSnapshot }>(`${BASE}/searches/${enc(searchId)}/snapshot`).then(
      (r) => r.snapshot,
    ),

  cancelSearch: (searchId: string) =>
    request<{ search: SearchProgress }>(`${BASE}/searches/${enc(searchId)}/cancel`, {
      method: "POST",
    }).then((r) => r.search),

  resumeSearch: (searchId: string) =>
    request<{ search: SearchProgress }>(`${BASE}/searches/${enc(searchId)}/resume`, {
      method: "POST",
    }).then((r) => r.search),

  /** Omit `kinds` to retry every failed document. */
  retryDocuments: (searchId: string, kinds?: DocumentKind[]) =>
    request<{ search: SearchProgress }>(`${BASE}/searches/${enc(searchId)}/documents/retry`, {
      method: "POST",
      body: JSON.stringify(kinds ? { kinds } : {}),
    }).then((r) => r.search),

  getPaper: (paperId: string, searchId?: string) =>
    request<{ paper: PaperDetail }>(
      `${BASE}/papers/${enc(paperId)}${searchId ? `?searchId=${enc(searchId)}` : ""}`,
    ).then((r) => r.paper),
};
