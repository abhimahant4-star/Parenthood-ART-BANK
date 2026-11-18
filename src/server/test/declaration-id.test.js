const { test } = require("node:test");
const assert = require("node:assert/strict");
const { formatDeclarationId } = require("../services/declarationIdService");

test("formats declaration IDs as readable year-based sequences", () => {
  assert.equal(formatDeclarationId(2026, 1), "DECL-2026-0001");
  assert.equal(formatDeclarationId(2026, 42), "DECL-2026-0042");
  assert.equal(formatDeclarationId(2026, 10000), "DECL-2026-10000");
});

test("rejects invalid declaration ID components", () => {
  assert.throws(() => formatDeclarationId(999, 1), /four-digit integer/);
  assert.throws(() => formatDeclarationId(2026, 0), /positive integer/);
});
