function parseCollectionDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function addCalendarMonths(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function nextCollectionDate(priorCollectionDate) {
  const prior = new Date(priorCollectionDate);
  const normalizedPrior = new Date(Date.UTC(prior.getUTCFullYear(), prior.getUTCMonth(), prior.getUTCDate()));
  return addCalendarMonths(normalizedPrior, 6);
}

function isAtOrAfterDate(candidate, threshold) {
  const candidateTime = new Date(candidate).getTime();
  const thresholdTime = new Date(threshold).getTime();
  return Number.isFinite(candidateTime) && Number.isFinite(thresholdTime) && candidateTime >= thresholdTime;
}

function isQuarantineComplete(quarantineEnd, currentTime = new Date()) {
  return isAtOrAfterDate(currentTime, quarantineEnd);
}

// Short IDs that start with the blood group, numbered separately per group:
// the first O+ batch is O+101 (vials O+101-1 to O+101-5), the first B- batch is B-101.
const BATCH_NUMBER_OFFSET = 100;
const MAX_BATCH_SEQUENCE = 9999899;
const BLOOD_GROUP_PATTERN = /^(AB|A|B|O)[+-]$/;

function normalizeBloodGroup(bloodGroup) {
  const value = typeof bloodGroup === "string" ? bloodGroup.trim().toUpperCase() : "";
  if (!BLOOD_GROUP_PATTERN.test(value)) throw new TypeError("A valid donor blood group is required to create batch and vial IDs.");
  return value;
}

function formatBatchId(bloodGroup, sequence) {
  const group = normalizeBloodGroup(bloodGroup);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_BATCH_SEQUENCE) {
    throw new RangeError(`Batch sequence must be from 1 to ${MAX_BATCH_SEQUENCE}.`);
  }
  return `${group}${sequence + BATCH_NUMBER_OFFSET}`;
}

function makeVialIds(batchId, count, bloodGroup) {
  if (!Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > 5) {
    throw new RangeError("Vial count must be from 1 to 5.");
  }
  const group = normalizeBloodGroup(bloodGroup);
  const match = typeof batchId === "string" ? batchId.match(/^((?:AB|A|B|O)[+-])([1-9]\d{2,6})$/) : null;
  if (!match || Number(match[2]) <= BATCH_NUMBER_OFFSET) throw new TypeError("A valid batch ID is required.");
  if (match[1] !== group) throw new TypeError("The batch ID must start with the donor's blood group.");
  return Array.from({ length: Number(count) }, (_, index) => `${batchId}-${index + 1}`);
}

module.exports = { parseCollectionDate, addCalendarMonths, nextCollectionDate, isAtOrAfterDate, isQuarantineComplete, formatBatchId, makeVialIds };
