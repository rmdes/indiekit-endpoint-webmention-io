import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  ensureISOString,
  extractDomain,
  getMentionType,
  getMentionTitle,
  getAuthorName,
  normaliseParagraphs,
  sanitiseHtml,
} from "../../lib/utils.js";

describe("endpoint-webmention-io/lib/utils", () => {
  it("Gets mention type from `wm-property`", () => {
    assert.equal(getMentionType("in-reply-to"), "reply");
    assert.equal(getMentionType("like-of"), "like");
    assert.equal(getMentionType("repost-of"), "repost");
    assert.equal(getMentionType("bookmark-of"), "bookmark");
    assert.equal(getMentionType("rsvp"), "rsvp");
    assert.equal(getMentionType("jam-of"), "mention");
  });

  it("Gets mention title", async (t) => {
    await t.test("from mention name", () => {
      assert.equal(
        getMentionTitle({ "wm-property": "like-of", name: "Cheese" }),
        "Cheese",
      );
    });

    await t.test("from mention type", () => {
      assert.equal(getMentionTitle({ "wm-property": "rsvp" }), "RSVP");
    });
  });

  it("Gets author name", async (t) => {
    await t.test("from author name", () => {
      assert.equal(
        getAuthorName({
          author: { name: "Paul", url: "https://website.example" },
        }),
        "Paul",
      );
    });

    await t.test("from author URL", () => {
      assert.equal(
        getAuthorName({ author: { url: "https://website.example" } }),
        "website.example",
      );
    });

    await t.test("from source URL", () => {
      assert.equal(
        getAuthorName({ url: "https://another.example/likes/1" }),
        "another.example/likes/1",
      );
    });
  });

  it("Normalises paragraphs", async (t) => {
    await t.test("with one paragraph", () => {
      assert.equal(normaliseParagraphs("foo"), "<p>foo</p>");
    });

    await t.test("with two paragraph", () => {
      assert.equal(
        normaliseParagraphs("foo<br><br/>bar"),
        "<p>foo</p><p>bar</p>",
      );
    });
  });

  it("Sanitises HTML", () => {
    const html = `<h1>Title</h1>
<p>Foo</p>
<p><a href="https://brid.gy/publish/mastodon"></a></p>`;
    assert.equal(sanitiseHtml(html), `<h3>Title</h3>\n<p>Foo</p>\n`);
  });

  // Fork-only helpers, absent upstream.

  it("Keeps an ISO string as it is", () => {
    assert.equal(
      ensureISOString("2026-08-01T10:00:00.000Z"),
      "2026-08-01T10:00:00.000Z",
    );
  });

  // MongoDB hands back BSON dates, and the Nunjucks `date` filter calls
  // `parseISO`, which needs a string.
  it("Converts a Date to an ISO string", () => {
    const date = new Date("2026-08-01T10:00:00.000Z");

    assert.equal(ensureISOString(date), "2026-08-01T10:00:00.000Z");
  });

  it("Returns null for an absent or unusable date", () => {
    assert.equal(ensureISOString(null), null);
    assert.equal(ensureISOString(undefined), null);
    assert.equal(ensureISOString(""), null);
    assert.equal(ensureISOString(12_345), null);
  });

  it("Extracts the domain from a URL", () => {
    assert.equal(extractDomain("https://alice.example/notes/1"), "alice.example");
    assert.equal(extractDomain("http://sub.alice.example/"), "sub.alice.example");
  });

  it("Returns null rather than throwing on a value that is not a URL", () => {
    assert.equal(extractDomain("not a url"), null);
    assert.equal(extractDomain(""), null);
  });
});
