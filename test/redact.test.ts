import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanText, redactLabel, redactUrl, sanitizeTarget } from "../src/redact.js";

describe("redaction", () => {
  it("strips credentials, fragments, sensitive query values and token-like path segments", () => {
    const out = redactUrl("https://user:pw@example.test/reset/ab12cd34ef56gh78ij90kl12mn?token=abc&page=2#secret");
    assert.ok(!out.includes("user"));
    assert.ok(!out.includes("pw@"));
    assert.ok(!out.includes("secret"));
    assert.ok(!out.includes("abc&"));
    assert.ok(out.includes("page=2"));
    assert.ok(out.includes(":redacted"));
    assert.ok(out.includes("token=%5Bredacted%5D") || out.includes("token=[redacted]"));
  });

  it("does not pass through script or data URLs", () => {
    assert.equal(redactUrl("javascript:alert(1)"), "javascript:[redacted]");
    assert.equal(redactUrl("not a url"), "[invalid-url]");
  });

  it("redacts emails and long digit runs in labels and removes control characters", () => {
    assert.equal(redactLabel("Pay jane@example.com"), "Pay [email]");
    assert.equal(redactLabel("Card 4111 1111 1111 1111"), "Card [number]");
    assert.equal(cleanText("a\u0000b‮c"), "a b c");
  });

  it("bounds label length", () => {
    assert.ok(cleanText("x".repeat(500)).length <= 80);
  });

  it("keeps the sensitive flag and drops empty targets", () => {
    assert.deepEqual(sanitizeTarget({ role: "textbox", label: "Password", sensitive: true }), { role: "textbox", label: "Password", sensitive: true });
    assert.equal(sanitizeTarget({}), undefined);
  });
});
