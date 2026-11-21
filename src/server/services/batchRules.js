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

// Short, easy-to-type IDs: the first batch is BAT-101, the next BAT-102, and so on.
const BATCH_NUMBER_OFFSET = 100;
const MAX_BATCH_SEQUENCE = 9999899;

function formatBatchId(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_BATCH_SEQUENCE) {
    throw new RangeError(`Batch sequence must be from 1 to ${MAX_BATCH_SEQUENCE}.`);
  }
  return `BAT-${sequence + BATCH_NUMBER_OFFSET}`;
}

// Vials take the batch's position plus a two-digit vial number: BAT-101 gives V-101 to V-105, BAT-102 gives V-201.
function makeVialIds(batchId, count, bloodGroup) {
  if (!Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > 5) {
    throw new RangeError("Vial count must be from 1 to 5.");
  }
  const batchNumber = typeof batchId === "string" ? Number(batchId.match(/^BAT-([1-9]\d{2,6})$/)?.[1]) : NaN;
  if (!Number.isSafeInteger(batchNumber) || batchNumber <= BATCH_NUMBER_OFFSET) {
    throw new TypeError("A valid batch ID is required.");
  }
  if (typeof bloodGroup !== "string" || !/^(AB|A|B|O)[+-]$/.test(bloodGroup.trim().toUpperCase())) {
    throw new TypeError("A valid donor blood group is required to create vial IDs.");
  }
  const position = batchNumber - BATCH_NUMBER_OFFSET;
  return Array.from({ length: Number(count) }, (_, index) => `V-${position}${String(index + 1).padStart(2, "0")}`);
}

module.exports = { parseCollectionDate, addCalendarMonths, nextCollectionDate, isAtOrAfterDate, isQuarantineComplete, formatBatchId, makeVialIds };
