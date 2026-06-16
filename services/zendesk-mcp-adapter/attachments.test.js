import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFormalAttachments, extractInlineImages, decodeAsText } from "./attachments.js";

// ---------------------------------------------------------------------------
// extractFormalAttachments
// ---------------------------------------------------------------------------

test("extractFormalAttachments: lists formal attachments from comments", () => {
  const comments = [
    {
      id: 1,
      attachments: [
        { id: 10, content_url: "https://acme.zendesk.com/attachments/token/abc/screenshot.png", content_type: "image/png", file_name: "screenshot.png", size: 4096, inline: false },
        { id: 11, content_url: "https://acme.zendesk.com/attachments/token/def/log.txt", content_type: "text/plain", file_name: "log.txt", size: 512, inline: false },
      ],
    },
    {
      id: 2,
      attachments: [
        { id: 12, content_url: "https://acme.zendesk.com/attachments/token/ghi/config.yml", content_type: "text/yaml", file_name: "config.yml", size: 1024, inline: false },
      ],
    },
  ];

  const result = extractFormalAttachments(comments);

  assert.equal(result.length, 3);
  assert.equal(result[0].attachment_id, 10);
  assert.equal(result[0].file_name, "screenshot.png");
  assert.equal(result[0].source, "attachment");
  assert.equal(result[0].comment_id, 1);
  assert.equal(result[1].content_type, "text/plain");
  assert.equal(result[2].comment_id, 2);
});

test("extractFormalAttachments: skips entries missing content_url or content_type", () => {
  const comments = [
    {
      id: 1,
      attachments: [
        { id: 10, content_url: "https://acme.zendesk.com/attachments/token/abc/file.png" }, // missing content_type
        { id: 11, content_type: "image/png" }, // missing content_url
        { id: 12, content_url: "https://acme.zendesk.com/attachments/token/def/ok.png", content_type: "image/png", file_name: "ok.png", size: 100 },
      ],
    },
  ];

  const result = extractFormalAttachments(comments);

  assert.equal(result.length, 1);
  assert.equal(result[0].attachment_id, 12);
});

test("extractFormalAttachments: returns empty array when no attachments", () => {
  const comments = [{ id: 1, body: "just text" }, { id: 2, attachments: [] }];
  assert.deepEqual(extractFormalAttachments(comments), []);
});

// ---------------------------------------------------------------------------
// extractInlineImages
// ---------------------------------------------------------------------------

test("extractInlineImages: extracts markdown inline images", () => {
  const comments = [
    { id: 1, body: "See this screenshot: ![error](https://acme.zendesk.com/attachments/token/img1/error.png)" },
  ];

  const result = extractInlineImages(comments);

  assert.equal(result.length, 1);
  assert.equal(result[0].content_url, "https://acme.zendesk.com/attachments/token/img1/error.png");
  assert.equal(result[0].source, "inline");
  assert.equal(result[0].content_type, "image/png");
  assert.equal(result[0].comment_id, 1);
  assert.equal(result[0].inline, true);
});

test("extractInlineImages: extracts HTML src inline images", () => {
  const comments = [
    { id: 2, body: '<img src="https://acme.zendesk.com/attachments/token/abc/ui.png" />' },
  ];

  const result = extractInlineImages(comments);

  assert.equal(result.length, 1);
  assert.equal(result[0].content_url, "https://acme.zendesk.com/attachments/token/abc/ui.png");
});

test("extractInlineImages: extracts both markdown and HTML images from same comment", () => {
  const comments = [
    {
      id: 1,
      body:
        "MD: ![alt](https://acme.zendesk.com/attachments/token/a/md.jpg)\n" +
        'HTML: <img src="https://acme.zendesk.com/attachments/token/b/html.png">',
    },
  ];

  const result = extractInlineImages(comments);
  assert.equal(result.length, 2);
});

test("extractInlineImages: deduplicates identical URLs across comments", () => {
  const url = "https://acme.zendesk.com/attachments/token/dup/same.png";
  const comments = [
    { id: 1, body: `![img](${url})` },
    { id: 2, body: `![img](${url})` },
  ];

  const result = extractInlineImages(comments);

  assert.equal(result.length, 1, "duplicate URL should appear only once");
  assert.equal(result[0].content_url, url);
});

test("extractInlineImages: deduplicates identical URLs within the same comment", () => {
  const url = "https://acme.zendesk.com/attachments/token/dup/same.png";
  const comments = [
    { id: 1, body: `![a](${url}) and again ![b](${url})` },
  ];

  const result = extractInlineImages(comments);

  assert.equal(result.length, 1);
});

test("extractInlineImages: infers content type from file extension in path", () => {
  const comments = [
    { id: 1, body: "![a](https://acme.zendesk.com/attachments/token/a/img.jpeg)" },
    { id: 2, body: "![b](https://acme.zendesk.com/attachments/token/b/img.gif)" },
    { id: 3, body: "![c](https://acme.zendesk.com/attachments/token/c/img.webp)" },
  ];

  const result = extractInlineImages(comments);

  assert.equal(result[0].content_type, "image/jpeg");
  assert.equal(result[1].content_type, "image/gif");
  assert.equal(result[2].content_type, "image/webp");
});

test("extractInlineImages: uses ?name= query param for file_name and extension (Zendesk token URLs)", () => {
  // Real Zendesk inline image URLs use a token path with ?name=image.png
  const comments = [
    {
      id: 1,
      body: '![screenshot](https://acme.zendesk.com/attachments/token/G2YrPxM6xp1Ao26q2ay/?name=screenshot.png)',
    },
  ];

  const result = extractInlineImages(comments);

  assert.equal(result.length, 1);
  assert.equal(result[0].file_name, "screenshot.png", "file_name should come from ?name= param");
  assert.equal(result[0].content_type, "image/png");
});

test("extractInlineImages: returns empty array when no inline images", () => {
  const comments = [{ id: 1, body: "just plain text, no images" }];
  assert.deepEqual(extractInlineImages(comments), []);
});

// ---------------------------------------------------------------------------
// decodeAsText
// ---------------------------------------------------------------------------

test("decodeAsText: returns decoded string for valid UTF-8 content", () => {
  const original = "Hello, world!\nThis is a log line.\n";
  const base64 = Buffer.from(original, "utf-8").toString("base64");

  const result = decodeAsText(base64);

  assert.equal(result, original);
});

test("decodeAsText: returns decoded string for JSON content", () => {
  const json = JSON.stringify({ key: "value", nested: { a: 1 } });
  const base64 = Buffer.from(json, "utf-8").toString("base64");

  assert.equal(decodeAsText(base64), json);
});

test("decodeAsText: returns null for binary content (high replacement char ratio)", () => {
  // Simulate binary data: random bytes likely to produce UTF-8 replacement chars
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0xfd, 0xfc, 0xfb]); // PNG-like magic + garbage
  // Pad with lots of invalid UTF-8 sequences to exceed the 5% threshold
  const garbage = Buffer.alloc(100, 0xff);
  const base64 = Buffer.concat([binary, garbage]).toString("base64");

  const result = decodeAsText(base64);

  assert.equal(result, null, "binary content should return null, not garbage text");
});

test("decodeAsText: returns null for empty-ish binary (lone high bytes)", () => {
  // Sequence of bytes that are invalid in UTF-8
  const invalid = Buffer.from("ff fe fd fc fb fa f9 f8".split(" ").map(h => parseInt(h, 16)));
  const base64 = invalid.toString("base64");

  const result = decodeAsText(base64);

  assert.equal(result, null);
});
