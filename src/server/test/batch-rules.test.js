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
  const batchId = formatBatchId(1);
  assert.equal(batchId, "BAT-101");
  assert.equal(formatBatchId(12), "BAT-112");
  assert.equal(formatBatchId(900), "BAT-1000");
  const three = makeVialIds(batchId, 3, "O+");
  const five = makeVialIds(batchId, 5, "O+");
  assert.deepEqual(three, ["V-101", "V-102", "V-103"]);
  assert.deepEqual(five.slice(-2), ["V-104", "V-105"]);
  assert.deepEqual(makeVialIds("BAT-102", 1, "AB-"), ["V-201"]);
  assert.deepEqual(makeVialIds("BAT-110", 2, "B+"), ["V-1001", "V-1002"]);
  assert.deepEqual(makeVialIds("BAT-1000", 1, "B+"), ["V-90001"]);
  assert.equal(new Set(five).size, five.length);
  // Vial IDs from different batches never collide, because the last two digits are always the vial number.
  const many = Array.from({ length: 300 }, (_, index) => makeVialIds(formatBatchId(index + 1), 5, "A+")).flat();
  assert.equal(new Set(many).size, many.length);
  assert.throws(() => formatBatchId(0), RangeError);
  assert.throws(() => formatBatchId(9999900), RangeError);
  assert.throws(() => makeVialIds(batchId, 0), RangeError);
  assert.throws(() => makeVialIds(batchId, 6), RangeError);
  assert.throws(() => makeVialIds("BATCH-invalid", 3, "O+"), TypeError);
  assert.throws(() => makeVialIds("BAT-100", 1, "O+"), TypeError);
  assert.throws(() => makeVialIds("ARTB-2026-00001", 1, "O+"), TypeError);
  assert.throws(() => makeVialIds(batchId, 1, "invalid"), TypeError);
});
