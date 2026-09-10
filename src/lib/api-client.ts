import type { CreateEntryInput, Entry, RelatedEntry, UpdateEntryInput } from "@/lib/types";

/** Thrown for any non-2xx response; `message` is the server's `{ error }` string when present. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: init?.body ? { "Content-Type": "application/json", ...init?.headers } : init?.headers,
    });
  } catch {
    throw new ApiError("Network error — is the dev server running?", 0);
  }

  const text = await res.text();
  let payload: unknown = undefined;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }

  if (!res.ok) {
    const message =
      payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `Request failed (${res.status})`;
    throw new ApiError(message, res.status);
  }

  return payload as T;
}

export const api = {
  listEntries: () => request<{ entries: Entry[] }>("/api/entries").then((r) => r.entries),

  createEntry: (input: CreateEntryInput) =>
    request<{ entry: Entry }>("/api/entries", {
      method: "POST",
      body: JSON.stringify(input),
    }).then((r) => r.entry),

  getEntry: (id: string) =>
    request<{ entry: Entry }>(`/api/entries/${encodeURIComponent(id)}`).then((r) => r.entry),

  updateEntry: (id: string, input: UpdateEntryInput) =>
    request<{ entry: Entry }>(`/api/entries/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }).then((r) => r.entry),

  deleteEntry: (id: string) =>
    request<{ ok: true }>(`/api/entries/${encodeURIComponent(id)}`, { method: "DELETE" }),

  reingestEntry: (id: string) =>
    request<{ entry: Entry }>(`/api/entries/${encodeURIComponent(id)}/reingest`, {
      method: "POST",
    }).then((r) => r.entry),

  relatedEntries: (id: string) =>
    request<{ related: RelatedEntry[] }>(`/api/entries/${encodeURIComponent(id)}/related`).then(
      (r) => r.related,
    ),
};
