const { csvCell } = require("./csvService");

async function* stockCsvStream(vials, hospitalUser) {
  const headers = hospitalUser
    ? ["Vial ID", "Blood group", "Status", "Location"]
    : ["Vial ID", "Donor ID", "Batch ID", "Blood group", "Hospital", "Centre", "Status", "Location"];
  yield `\uFEFF${headers.map(csvCell).join(",")}\r\n`;
  for await (const vial of vials) {
    const row = hospitalUser
      ? [vial.vialId, vial.bloodGroup, vial.status, vial.currentLocation]
      : [vial.vialId, vial.donorId, vial.batchId, vial.bloodGroup, vial.hospitalId, vial.centreId, vial.status, vial.currentLocation];
    yield `${row.map(csvCell).join(",")}\r\n`;
  }
}

module.exports = { stockCsvStream };
