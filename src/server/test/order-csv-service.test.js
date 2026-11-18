const { test } = require("node:test");
const assert = require("node:assert/strict");
const { headers, orderCsvStream } = require("../services/orderCsvService");

test("order CSV stream emits every row with existing columns, formula protection and cursor cleanup", async () => {
  let closed = false;
  async function* orders() {
    for (let index = 0; index < 12050; index++) {
      yield {
        orderId: index === 0 ? "=1+1" : `ORDER-${index}`,
        hospitalId: "HOSPITAL-TEST",
        centreId: "CENTRE-TEST",
        purpose: index === 0 ? "=1+1" : "routine",
        status: "PENDING",
        vialIds: [`VIAL-${index}`],
        createdAt: new Date("2026-01-01T00:00:00.000Z")
      };
    }
  }
  const cursor = { [Symbol.asyncIterator]: orders, async close() { closed = true; } };
  let lineCount = 0;
  let firstLine = "";
  let firstDataLine = "";
  let lastDataLine = "";
  for await (const chunk of orderCsvStream(cursor)) {
    const lines = chunk.split("\r\n").filter(Boolean);
    for (const line of lines) {
      if (lineCount === 0) firstLine = line;
      if (lineCount === 1) firstDataLine = line;
      lastDataLine = line;
      lineCount++;
    }
  }
  assert.equal(firstLine.split(",").length, headers.length);
  assert.equal(firstLine.startsWith("\uFEFF"), false, "the primary CSV endpoint keeps its existing no-BOM format");
  assert.equal(lineCount, 12051);
  assert.ok(firstDataLine.includes("'=1+1"));
  assert.ok(lastDataLine.includes("ORDER-12049"));
  assert.equal(closed, true);

  let withBom = "";
  for await (const chunk of orderCsvStream({ async *[Symbol.asyncIterator]() {}, async close() {} }, { bom: true })) withBom += chunk;
  assert.ok(withBom.startsWith("\uFEFF"));

  let abortedCursorClosed = false;
  const abortedCursor = {
    async *[Symbol.asyncIterator]() { yield { orderId: "NEVER_CONSUMED" }; },
    async close() { abortedCursorClosed = true; }
  };
  const interrupted = orderCsvStream(abortedCursor);
  await interrupted.next();
  await interrupted.return();
  assert.equal(abortedCursorClosed, true, "aborting immediately after the CSV header still closes the cursor");
});
