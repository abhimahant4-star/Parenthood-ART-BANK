"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { stockCsvStream } = require("../services/stockCsvService");

async function* vialFixtures(count) {
  for (let index = 0; index < count; index++) {
    yield {
      vialId: index === 0 ? "=1+1" : `VIAL-${index}`,
      donorId: `DONOR-${index}`,
      batchId: `BATCH-${index}`,
      bloodGroup: "O+",
      hospitalId: "HOSP-1",
      centreId: "CENTRE-1",
      status: "AVAILABLE_AT_ART_BANK",
      currentLocation: "ART Bank"
    };
  }
}

test("stock CSV streams every row beyond the former 10,000-row cap", async () => {
  let rows = 0;
  let first = "";
  for await (const chunk of stockCsvStream(vialFixtures(10007), false)) {
    if (rows === 0) first = chunk;
    rows += (chunk.match(/\r\n/g) || []).length;
  }
  assert.equal(rows, 10008); // header plus 10,007 vials
  assert.ok(first.startsWith("\uFEFF\"Vial ID\""));
  assert.ok(first.includes("\"Donor ID\""));
});

test("hospital stock CSV omits donor and batch identifiers and keeps formula protection", async () => {
  const chunks = [];
  for await (const chunk of stockCsvStream(vialFixtures(1), true)) chunks.push(chunk);
  const csv = chunks.join("");
  assert.match(csv, /\"Vial ID\",\"Blood group\",\"Status\",\"Location\"/);
  assert.equal(csv.includes("Donor ID"), false);
  assert.equal(csv.includes("Batch ID"), false);
  assert.match(csv, /"'=1\+1"/);
});
