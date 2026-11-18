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

function formatBatchId(year, sequence) {
  if (!Number.isInteger(year) || year < 2000 || year > 9999 || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > 99999) {
    throw new RangeError("Batch year must be valid and sequence must be from 1 to 99999.");
  }
  return `ARTB-${year}-${String(sequence).padStart(5, "0")}`;
}

function makeVialIds(batchId, count, bloodGroup) {
  if (!Number.isInteger(Number(count)) || Number(count) < 1 || Number(count) > 5) {
    throw new RangeError("Vial count must be from 1 to 5.");
  }
  if (typeof batchId !== "string" || !/^ARTB-\d{4}-\d{5}$/.test(batchId)) {
    throw new TypeError("A valid batch ID is required.");
  }
  const bloodGroupCode = typeof bloodGroup === "string" ? bloodGroup.trim().toUpperCase().match(/^(AB|A|B|O)[+-]$/)?.[1] : null;
  if (!bloodGroupCode) {
    throw new TypeError("A valid donor blood group is required to create vial IDs.");
  }
  return Array.from({ length: Number(count) }, (_, index) => `${batchId}-${bloodGroupCode}-V${String(index + 1).padStart(2, "0")}`);
}

module.exports = { parseCollectionDate, addCalendarMonths, nextCollectionDate, isAtOrAfterDate, isQuarantineComplete, formatBatchId, makeVialIds };
