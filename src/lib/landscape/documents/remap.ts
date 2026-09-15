import type { DocumentKind } from "@/lib/landscape/types";

/*
 * Paper ids embedded inside stored synthesis documents (`search_documents.data`,
 * shapes in llm/synthesize/schemas.ts). Whenever paper ids change -- a live
 * `mergePapers`, or a backup import resolving papers onto existing rows -- the
 * JSON must be rewritten too, or the documents point at papers that no longer
 * exist.
 */

export type PaperIdMap = (id: string) => string | null;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Map a list of ids: unresolved ids dropped, duplicates removed (first wins). */
function mapIds(list: unknown, map: PaperIdMap): unknown {
  if (!Array.isArray(list)) return list;
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== "string") continue;
    const m = map(v);
    if (m != null && !out.includes(m)) out.push(m);
  }
  return out;
}

/** Apply `fn` to each object in a list (returns a new list). */
function mapEach(list: unknown, fn: (o: Obj) => Obj): unknown {
  return Array.isArray(list) ? list.map((o) => (isObj(o) ? fn(o) : o)) : list;
}

/** Objects keyed by a single `paperId`: remapped, unresolved dropped, deduped by id. */
function mapByPaperId(list: unknown, map: PaperIdMap): unknown {
  if (!Array.isArray(list)) return list;
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const o of list) {
    if (!isObj(o) || typeof o.paperId !== "string") continue;
    const m = map(o.paperId);
    if (m == null || seen.has(m)) continue;
    seen.add(m);
    out.push({ ...o, paperId: m });
  }
  return out;
}

/**
 * Return a copy of `data` (a stored document of `kind`) with every paper id
 * passed through `map`. Lists are deduped; entries whose id maps to null are
 * dropped. Unknown kinds and non-object data are returned unchanged.
 */
export function remapDocumentPaperIds(kind: DocumentKind | string, data: unknown, map: PaperIdMap): unknown {
  if (!isObj(data)) return data;
  switch (kind) {
    case "clusters":
      return {
        ...data,
        clusters: mapEach(data.clusters, (c) => ({
          ...c,
          representativePaperIds: mapIds(c.representativePaperIds, map),
        })),
      };
    case "tensions":
      return {
        ...data,
        tensions: mapEach(data.tensions, (t) => ({
          ...t,
          positions: mapEach(t.positions, (p) => ({ ...p, paperIds: mapIds(p.paperIds, map) })),
        })),
      };
    case "gaps":
      return {
        ...data,
        gaps: mapEach(data.gaps, (g) => ({ ...g, evidencePaperIds: mapIds(g.evidencePaperIds, map) })),
      };
    case "narrative":
      return {
        ...data,
        eras: mapEach(data.eras, (e) => ({ ...e, keyPaperIds: mapIds(e.keyPaperIds, map) })),
        gameChangers: mapByPaperId(data.gameChangers, map),
        frontier: isObj(data.frontier)
          ? { ...data.frontier, paperIds: mapIds(data.frontier.paperIds, map) }
          : data.frontier,
      };
    case "reading_path":
      return { ...data, steps: mapByPaperId(data.steps, map) };
    case "diff":
      return {
        ...data,
        newPaperIds: mapIds(data.newPaperIds, map),
        droppedPaperIds: mapIds(data.droppedPaperIds, map),
        rising: mapByPaperId(data.rising, map),
      };
    default:
      return data;
  }
}
