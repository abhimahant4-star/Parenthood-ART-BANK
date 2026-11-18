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
  const batchId = formatBatchId(2026, 1);
  assert.equal(batchId, "ARTB-2026-00001");
  assert.equal(formatBatchId(2026, 12), "ARTB-2026-00012");
  assert.equal(formatBatchId(2026, 99999), "ARTB-2026-99999");
  const three = makeVialIds(batchId, 3, "O+");
  const five = makeVialIds(batchId, 5, "O+");
  assert.deepEqual(three, ["ARTB-2026-00001-O-V01", "ARTB-2026-00001-O-V02", "ARTB-2026-00001-O-V03"]);
  assert.deepEqual(five.slice(-2), ["ARTB-2026-00001-O-V04", "ARTB-2026-00001-O-V05"]);
  assert.deepEqual(makeVialIds(batchId, 1, "AB-"), ["ARTB-2026-00001-AB-V01"]);
  assert.deepEqual(makeVialIds(batchId, 1, "B+"), ["ARTB-2026-00001-B-V01"]);
  assert.equal(new Set(five).size, five.length);
  assert.throws(() => formatBatchId(2026, 0), RangeError);
  assert.throws(() => formatBatchId(2026, 100000), RangeError);
  assert.deepEqual(makeVialIds(batchId, 1, "O+"), ["ARTB-2026-00001-O-V01"]);
  assert.throws(() => makeVialIds(batchId, 0), RangeError);
  assert.throws(() => makeVialIds(batchId, 6), RangeError);
  assert.throws(() => makeVialIds("BATCH-invalid", 3), TypeError);
  assert.throws(() => makeVialIds("ARTB-2026-100000", 1, "O+"), TypeError);
  assert.throws(() => makeVialIds(batchId, 1, "invalid"), TypeError);
});
