const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseCollectionDate, addCalendarMonths, nextCollectionDate, isAtOrAfterDate, isQuarantineComplete, formatBatchId, makeVialIds } = require("../services/batchRules");

test("collection dates accept valid date-only values and reject times or impossible days", () => {
  assert.equal(parseCollectionDate("2026-11-03").toISOString(), "2026-11-03T00:00:00.000Z");
  assert.equal(parseCollectionDate("2026-02-29"), null);
  assert.equal(parseCollectionDate("2024-02-29").toISOString(), "2024-02-29T00:00:00.000Z");
  assert.equal(parseCollectionDate("2026-11-03T09:30"), null);
});

test("six calendar months clamp at the destination month's last day", () => {
  assert.equal(addCalendarMonths(new Date("2026-08-31T00:00:00.000Z"), 6).toISOString(), "2027-02-28T00:00:00.000Z");
  assert.equal(addCalendarMonths(new Date("2024-08-31T00:00:00.000Z"), 6).toISOString(), "2025-02-28T00:00:00.000Z");
  assert.equal(addCalendarMonths(new Date("2024-02-29T00:00:00.000Z"), 6).toISOString(), "2024-08-29T00:00:00.000Z");
});

test("donor interval accepts the exact six-month date and rejects the day before", () => {
  const eligibility = nextCollectionDate(new Date("2026-05-10T00:00:00.000Z"));
  assert.equal(eligibility.toISOString().slice(0, 10), "2026-11-10");
  assert.equal(isAtOrAfterDate(new Date("2026-11-09T00:00:00.000Z"), eligibility), false);
  assert.equal(isAtOrAfterDate(new Date("2026-11-10T00:00:00.000Z"), eligibility), true);
  assert.equal(isAtOrAfterDate(new Date("2026-11-11T00:00:00.000Z"), eligibility), true);
});

test("batch quarantine independently ends on its exact six-calendar-month date", () => {
  const quarantineEnd = addCalendarMonths(new Date("2026-05-10T00:00:00.000Z"), 6);
  assert.equal(isQuarantineComplete(quarantineEnd, new Date("2026-11-09T23:59:59.999Z")), false);
  assert.equal(isQuarantineComplete(quarantineEnd, new Date("2026-11-10T00:00:00.000Z")), true);
  assert.equal(isQuarantineComplete(quarantineEnd, new Date("2026-11-11T00:00:00.000Z")), true);
});

test("batch and vial IDs are readable, linked, and sequential", () => {
  const batchId = formatBatchId("O+", 1);
  assert.equal(batchId, "O+101");
  assert.equal(formatBatchId("o+", 12), "O+112");
  assert.equal(formatBatchId("B-", 1), "B-101");
  assert.equal(formatBatchId("AB+", 900), "AB+1000");
  const three = makeVialIds(batchId, 3, "O+");
  const five = makeVialIds(batchId, 5, "O+");
  assert.deepEqual(three, ["O+101-1", "O+101-2", "O+101-3"]);
  assert.deepEqual(five.slice(-2), ["O+101-4", "O+101-5"]);
  assert.deepEqual(makeVialIds("AB-102", 1, "AB-"), ["AB-102-1"]);
  assert.deepEqual(makeVialIds("B+110", 2, "b+"), ["B+110-1", "B+110-2"]);
  assert.equal(new Set(five).size, five.length);
  // Batches and vials never collide across blood groups or batch numbers.
  const groups = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
  const batches = groups.flatMap(group => Array.from({ length: 150 }, (_, index) => formatBatchId(group, index + 1)));
  assert.equal(new Set(batches).size, batches.length);
  const many = batches.flatMap(id => makeVialIds(id, 5, id.match(/^(AB|A|B|O)[+-]/)[0]));
  assert.equal(new Set(many).size, many.length);
  assert.throws(() => formatBatchId("O+", 0), RangeError);
  assert.throws(() => formatBatchId("O+", 9999900), RangeError);
  assert.throws(() => formatBatchId("X+", 1), TypeError);
  assert.throws(() => makeVialIds(batchId, 0, "O+"), RangeError);
  assert.throws(() => makeVialIds(batchId, 6, "O+"), RangeError);
  assert.throws(() => makeVialIds("BATCH-invalid", 3, "O+"), TypeError);
  assert.throws(() => makeVialIds("O+100", 1, "O+"), TypeError);
  assert.throws(() => makeVialIds("BAT-101", 1, "O+"), TypeError);
  assert.throws(() => makeVialIds("B+101", 1, "O+"), TypeError);
  assert.throws(() => makeVialIds(batchId, 1, "invalid"), TypeError);
});
