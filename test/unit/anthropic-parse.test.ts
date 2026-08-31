import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sniffLeadingModel, MODEL_SNIFF_BYTES } from "../../src/anthropic-parse.js";

// ---------------------------------------------------------------------------
// sniffLeadingModel — behavioural table
// ---------------------------------------------------------------------------
//
// The contract:
//   - Returns the unescaped model name when "model" is the first key.
//   - Returns undefined when the model is not the first key, when the value
//     exceeds 200 chars, when the prefix is truncated mid-value, or when the
//     input is not parseable JSON.
//   - Delegates escape handling to JSON.parse so escape sequences are resolved
//     correctly rather than re-implemented.
//
// Non-vacuity: RED against code that always returns undefined — every "returns it"
// assertion would fail.  RED against code that ignores the anchoring and matches a
// nested "model" key — the "nested model" assertion would fail.

describe("sniffLeadingModel", () => {
  it("returns the model name when 'model' is the first key", () => {
    const buf = Buffer.from('{"model":"claude-sonnet-4-6","messages":[]}');
    assert.equal(sniffLeadingModel(buf), "claude-sonnet-4-6");
  });

  it("returns the model name with leading whitespace and newlines before the opening brace", () => {
    const buf = Buffer.from('  \n\t{ "model" : "gpt-5.6-sol" , "messages":[] }');
    assert.equal(sniffLeadingModel(buf), "gpt-5.6-sol");
  });

  it("returns the unescaped value when the model name contains a JSON escape sequence", () => {
    // \"A\" in the JSON string → "A" as the JavaScript value.
    const buf = Buffer.from('{"model":"\\\"A\\\"","messages":[]}');
    assert.equal(sniffLeadingModel(buf), '"A"');
  });

  it("returns undefined when 'model' is a nested key inside messages, not the first top-level key", () => {
    // Anchored regex: the leading part is NOT `{"model": ...` so it must not match.
    const buf = Buffer.from('{"messages":[{"role":"user","model":"nested"}],"model":"top-level"}');
    // The "model" key appears, but it is NOT the first top-level key (messages is).
    assert.equal(sniffLeadingModel(buf), undefined);
  });

  it("returns undefined when 'model' is present but not the first top-level key", () => {
    const buf = Buffer.from('{"pad":"xxxx","model":"codex:gpt-5.6-sol"}');
    assert.equal(sniffLeadingModel(buf), undefined);
  });

  it("returns undefined when the model value exceeds 200 characters", () => {
    const longName = "a".repeat(201);
    const buf = Buffer.from(`{"model":"${longName}","messages":[]}`);
    assert.equal(sniffLeadingModel(buf), undefined);
  });

  it("returns undefined for a prefix truncated mid-value", () => {
    // Truncated in the middle of the string — the closing " never arrives.
    const buf = Buffer.from('{"model":"claude-sonnet');
    assert.equal(sniffLeadingModel(buf), undefined);
  });

  it("returns undefined for a non-JSON prefix", () => {
    const buf = Buffer.from("not json at all");
    assert.equal(sniffLeadingModel(buf), undefined);
  });

  it("returns undefined for an empty buffer", () => {
    assert.equal(sniffLeadingModel(Buffer.alloc(0)), undefined);
  });

  it("returns undefined for a buffer containing only whitespace", () => {
    assert.equal(sniffLeadingModel(Buffer.from("   ")), undefined);
  });

  it("correctly handles Unicode escape sequences in model values", () => {
    const buf = Buffer.from('{"model":"\\u0067pt-5","messages":[]}');
    // g = 'g', so the model name is "gpt-5"
    assert.equal(sniffLeadingModel(buf), "gpt-5");
  });

  // ---------------------------------------------------------------------------
  // Equivalence property: for bodies where model is the first key and the value
  // is ≤ 200 characters, sniffLeadingModel must agree with JSON.parse.
  // ---------------------------------------------------------------------------

  it("equivalence: sniffLeadingModel matches JSON.parse for typical Anthropic model names", () => {
    const corpus = [
      '{"model":"claude-sonnet-4-6","messages":[]}',
      '{"model":"claude-opus-4-5","max_tokens":1024}',
      '{"model":"claude-haiku-3","stream":true}',
    ];
    for (const body of corpus) {
      const parsed = (JSON.parse(body) as { model: string }).model;
      const sniffed = sniffLeadingModel(Buffer.from(body));
      assert.equal(sniffed, parsed, `sniffLeadingModel must agree with JSON.parse for: ${body}`);
    }
  });

  it("equivalence: sniffLeadingModel matches JSON.parse for Codex model names", () => {
    const corpus = [
      '{"model":"codex:gpt-5.6-sol","messages":[]}',
      '{"model":"gpt-5.6-sol","stream":false}',
      '{"model":"codex:gpt-5.6-luna","output_config":{"effort":"high"}}',
    ];
    for (const body of corpus) {
      const parsed = (JSON.parse(body) as { model: string }).model;
      const sniffed = sniffLeadingModel(Buffer.from(body));
      assert.equal(sniffed, parsed, `sniffLeadingModel must agree with JSON.parse for: ${body}`);
    }
  });

  it("only considers the first MODEL_SNIFF_BYTES of the prefix", () => {
    // Build a prefix where 'model' appears only AFTER MODEL_SNIFF_BYTES bytes.
    // The function must not see it — it only reads up to MODEL_SNIFF_BYTES.
    const pad = "x".repeat(MODEL_SNIFF_BYTES + 10);
    const buf = Buffer.from(`{"pad":"${pad}","model":"claude-sonnet-4-6"}`);
    // The model key is well beyond the sniff window.
    assert.equal(sniffLeadingModel(buf), undefined);
  });
});
