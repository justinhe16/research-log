"use client";

import { useState } from "react";
import { LinkIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CATEGORIES } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { CreateEntryInput, Entry } from "@/lib/types";
import { displayTitle, isValidUrl, normalizeUrl } from "./entry-utils";

const DEFAULT_CATEGORY = "Other";

type AddEntryFormProps = {
  onCreate: (input: CreateEntryInput) => Promise<Entry>;
};

export function AddEntryForm({ onCreate }: AddEntryFormProps) {
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState<string>(DEFAULT_CATEGORY);
  const [notes, setNotes] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [notesFocused, setNotesFocused] = useState(false);

  const normalized = normalizeUrl(url);
  const canSubmit = isValidUrl(normalized) && !isSaving;

  // Purely visual: the notes lane stays out of the way until there is something
  // to write about. The textarea is always mounted so focus is never stolen.
  const expanded = url.trim() !== "" || notes !== "" || notesFocused;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;

    setIsSaving(true);
    try {
      const entry = await onCreate({
        url: normalized,
        category,
        notes: notes.trim(),
      });
      setUrl("");
      setNotes("");
      setCategory(DEFAULT_CATEGORY);
      toast.success("Saved — reading it now", {
        description: displayTitle(entry),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save that link.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div
        className={cn(
          "bg-card border-border/70 rounded-xl border shadow-sm transition-all duration-150",
          "focus-within:border-ring/50 focus-within:ring-ring/20 focus-within:ring-[3px]",
        )}
      >
        {/* Command line: icon · url · category · save */}
        <div className="flex flex-col gap-2 p-2 sm:flex-row sm:items-center sm:gap-2 sm:pl-3">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <LinkIcon className="text-muted-foreground/70 size-4 shrink-0" aria-hidden />
            <Label htmlFor="new-entry-url" className="sr-only">
              URL
            </Label>
            <Input
              id="new-entry-url"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste a link to a paper, blog post, or thread…"
              className="h-9 rounded-none border-0 bg-transparent px-0 text-base shadow-none focus-visible:border-transparent focus-visible:ring-0 sm:text-sm dark:bg-transparent"
            />
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Label htmlFor="new-entry-category" className="sr-only">
              Category
            </Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger
                id="new-entry-category"
                className="text-muted-foreground hover:text-foreground data-[state=open]:text-foreground h-8 w-full border-transparent bg-transparent text-xs transition-colors hover:bg-transparent sm:w-[170px] dark:bg-transparent dark:hover:bg-transparent"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c === DEFAULT_CATEGORY ? (
                      <span className="flex items-center gap-1.5">
                        <SparklesIcon className="size-3.5 opacity-70" />
                        Auto · Claude picks
                      </span>
                    ) : (
                      c
                    )}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <span aria-hidden className="bg-border/70 hidden h-5 w-px sm:block" />

            <Button
              type="submit"
              size="sm"
              disabled={!canSubmit}
              className="h-8 shrink-0 px-3.5 text-xs transition-all duration-150"
            >
              {isSaving ? <Loader2Icon className="animate-spin" /> : null}
              Save
            </Button>
          </div>
        </div>

        {/* Secondary lane: notes + what happens next */}
        <div
          className={cn(
            "grid transition-all duration-150",
            expanded
              ? "border-border/60 grid-rows-[1fr] border-t opacity-100"
              : "grid-rows-[0fr] opacity-0",
          )}
        >
          <div className="overflow-hidden">
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onFocus={() => setNotesFocused(true)}
              onBlur={() => setNotesFocused(false)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") handleSubmit(e);
              }}
              placeholder="Your own notes — why this caught your eye (optional)"
              rows={2}
              aria-label="Notes"
              tabIndex={expanded ? undefined : -1}
              className="min-h-14 resize-none rounded-none border-0 bg-transparent px-3.5 py-2.5 text-sm shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
            />
            <p className="text-muted-foreground/80 border-border/50 border-t px-3.5 py-2 text-[11px] leading-4">
              {category === DEFAULT_CATEGORY
                ? "Category is on Auto — Claude will file it."
                : `Filed under ${category}.`}{" "}
              Title, summary, tags, and key claims are extracted in the background.
            </p>
          </div>
        </div>
      </div>
    </form>
  );
}
