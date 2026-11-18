function formatDeclarationId(year, sequence) {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new TypeError("Declaration year must be a four-digit integer");
  }
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new TypeError("Declaration sequence must be a positive integer");
  }
  return `DECL-${year}-${String(sequence).padStart(4, "0")}`;
}

module.exports = { formatDeclarationId };
