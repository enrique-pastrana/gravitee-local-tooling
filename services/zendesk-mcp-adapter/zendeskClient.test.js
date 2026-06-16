import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAttachmentUrl } from "./zendeskClient.js";

const BASE = "https://acme.zendesk.com";

// ---------------------------------------------------------------------------
// validateAttachmentUrl — allowed hosts
// ---------------------------------------------------------------------------

test("validateAttachmentUrl: allows URL on the configured base domain", () => {
  assert.doesNotThrow(() =>
    validateAttachmentUrl("https://acme.zendesk.com/attachments/token/abc/file.png", BASE),
  );
});

test("validateAttachmentUrl: allows any *.zendesk.com subdomain (CDN)", () => {
  assert.doesNotThrow(() =>
    validateAttachmentUrl("https://files.zendesk.com/attachments/token/abc/file.png", BASE),
  );
  assert.doesNotThrow(() =>
    validateAttachmentUrl("https://other-company.zendesk.com/attachments/token/abc/file.png", BASE),
  );
});

test("validateAttachmentUrl: allows *.zdassets.com CDN URLs", () => {
  assert.doesNotThrow(() =>
    validateAttachmentUrl("https://static.zdassets.com/something/image.png", BASE),
  );
  assert.doesNotThrow(() =>
    validateAttachmentUrl("https://cdn.zdassets.com/assets/logo.png", BASE),
  );
});

// ---------------------------------------------------------------------------
// validateAttachmentUrl — rejected hosts (SSRF protection)
// ---------------------------------------------------------------------------

test("validateAttachmentUrl: rejects attacker-controlled external host", () => {
  assert.throws(
    () => validateAttachmentUrl("https://evil.com/steal-token", BASE),
    /not permitted/,
  );
});

test("validateAttachmentUrl: rejects URL that merely contains 'zendesk' in the path", () => {
  assert.throws(
    () => validateAttachmentUrl("https://evil.com/zendesk/attachments/file.png", BASE),
    /not permitted/,
  );
});

test("validateAttachmentUrl: rejects URL with zendesk.com lookalike host", () => {
  assert.throws(
    () => validateAttachmentUrl("https://zendesk.com.evil.com/attachments/file.png", BASE),
    /not permitted/,
  );
});

test("validateAttachmentUrl: rejects localhost", () => {
  assert.throws(
    () => validateAttachmentUrl("http://localhost:9999/internal", BASE),
    /not permitted/,
  );
});

test("validateAttachmentUrl: rejects internal IP addresses", () => {
  assert.throws(
    () => validateAttachmentUrl("http://169.254.169.254/metadata", BASE),
    /not permitted/,
  );
  assert.throws(
    () => validateAttachmentUrl("http://10.0.0.1/internal", BASE),
    /not permitted/,
  );
});

test("validateAttachmentUrl: rejects completely invalid URL string", () => {
  assert.throws(
    () => validateAttachmentUrl("not-a-url", BASE),
    /Invalid attachment URL/,
  );
});

test("validateAttachmentUrl: auth headers would not be sent to rejected host", () => {
  // Verify that rejection happens synchronously (before any fetch/network call)
  let fetchCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => { fetchCalled = true; return Promise.resolve(); };

  try {
    validateAttachmentUrl("https://evil.com/attack", BASE);
  } catch (_err) {
    // expected
  } finally {
    globalThis.fetch = origFetch;
  }

  assert.equal(fetchCalled, false, "fetch must not be called for rejected URLs");
});
