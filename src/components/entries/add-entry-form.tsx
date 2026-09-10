"use client";

import { useState } from "react";
import { Loader2Icon, PlusIcon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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

  const normalized = normalizeUrl(url);
  const canSubmit = isValidUrl(normalized) && !isSaving;

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
    <Card className="gap-0 p-3 sm:p-4">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex-1">
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
              className="h-10 text-base sm:text-sm"
            />
          </div>

          <div className="flex items-center gap-2">
            <Label htmlFor="new-entry-category" className="sr-only">
              Category
            </Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="new-entry-category" className="h-10 w-full sm:w-[190px]">
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

            <Button type="submit" size="lg" disabled={!canSubmit} className="h-10 shrink-0 px-4">
              {isSaving ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <PlusIcon data-icon="inline-start" />
              )}
              Save
            </Button>
          </div>
        </div>

        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") handleSubmit(e);
          }}
          placeholder="Your own notes — why this caught your eye (optional)"
          rows={2}
          className="min-h-16 resize-y"
        />

        <p className="text-muted-foreground text-xs">
          {category === DEFAULT_CATEGORY
            ? "Leave the category on Auto and Claude will file it for you."
            : `Filed under ${category}.`}{" "}
          Title, summary, tags, and key claims are extracted in the background.
        </p>
      </form>
    </Card>
  );
}
