function formatCoupleId(year, sequence) {
  if (!Number.isInteger(year) || year < 2000 || year > 9999 || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError("Couple year and sequence must be valid positive values.");
  }
  return `CASE-${year}-${String(sequence).padStart(4, "0")}`;
}

module.exports = { formatCoupleId };
