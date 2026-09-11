import { describe, expect, it } from "vitest";
import { cleanMultiline, cleanText, decodeEntities, stripTags } from "@/lib/sanitize";

describe("stripTags", () => {
  it("removes the <item> wrappers the model emits around claims", () => {
    expect(stripTags("<item>The field is bottlenecked.</item>")).toBe(
      "The field is bottlenecked.",
    );
  });

  it("removes tags with attributes and self-closing tags", () => {
    expect(stripTags('<p class="x">Hi</p><br/>there')).toBe("Hithere");
  });

  it("preserves mathematical comparisons, which a naive /<[^>]*>/ would destroy", () => {
    expect(stripTags("loss < 0.5 and n > 10")).toBe("loss < 0.5 and n > 10");
    expect(cleanText("we require x <= y for all x < z")).toBe(
      "we require x <= y for all x < z",
    );
  });

  it("drops a dangling fragment left by truncation", () => {
    // stripTags does not trim -- cleanText owns whitespace normalization.
    expect(stripTags("Some text <div class=")).toBe("Some text ");
    expect(cleanText("Some text <div class=")).toBe("Some text");
  });
});

describe("decodeEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("A &amp; B &ndash; C &#8212; D &#x2014; E")).toBe("A & B – C — D — E");
  });

  it("leaves unknown entities alone rather than mangling them", () => {
    expect(decodeEntities("&notareal; thing")).toBe("&notareal; thing");
  });
});

describe("cleanText", () => {
  it("neutralizes encoded markup instead of letting it survive as a tag", () => {
    expect(cleanText("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe("alert(1)");
  });

  it("handles double-encoded markup", () => {
    expect(cleanText("&amp;lt;b&amp;gt;bold&amp;lt;/b&amp;gt;")).toBe("bold");
  });

  it("collapses runs of spaces but not newlines", () => {
    expect(cleanText("a    b")).toBe("a b");
    expect(cleanText("a\nb")).toBe("a\nb");
  });

  it("returns an empty string for non-strings", () => {
    expect(cleanText(null)).toBe("");
    expect(cleanText(42)).toBe("");
  });
});

describe("cleanMultiline", () => {
  it("keeps bullet structure while stripping markup", () => {
    const input = "<ul>\n- <b>First</b> point\n- Second point\n</ul>";
    expect(cleanMultiline(input)).toBe("- First point\n- Second point");
  });

  it("collapses excessive blank lines", () => {
    expect(cleanMultiline("a\n\n\n\nb")).toBe("a\n\nb");
  });
});
