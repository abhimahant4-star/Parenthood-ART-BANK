function csvCell(value) {
  let text = value instanceof Date ? value.toISOString() : String(value ?? "");
  // Prefix formula-leading cells, including cells with leading whitespace that
  // spreadsheet applications may ignore before evaluating a formula.
  if (/^[\u0000-\u0020]*[=+@\-]/.test(text) || /^[\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function csvFromRecords(rows, headers) {
  const lines = [headers, ...rows.map(row => headers.map(header => row[header] ?? ""))];
  return `\uFEFF${lines.map(row => row.map(csvCell).join(",")).join("\r\n")}`;
}

module.exports = { csvCell, csvFromRecords };
