const { csvCell } = require("./csvService");

const headers = [
  "coupleId", "hospitalId", "centreId", "husbandName", "husbandPatientId",
  "wifeName", "wifePatientId", "coupleStatus", "mappedVialIds", "patientId",
  "patientName", "patientGender", "patientDateOfBirth", "patientStatus", "createdAt", "updatedAt"
];

function rowFor(couple, patient = null) {
  return [
    couple.coupleId,
    couple.hospitalId,
    couple.centreId,
    couple.husband?.name || "",
    couple.husband?.patientId || "",
    couple.wife?.name || "",
    couple.wife?.patientId || "",
    couple.status,
    (couple.mappedVialIds || []).join(", "),
    patient?.patientId || "",
    patient?.name || "",
    patient?.gender || "",
    patient?.dateOfBirth || "",
    patient?.status || "",
    couple.createdAt,
    couple.updatedAt
  ];
}

async function* couplePatientCsvStream(coupleCursor) {
  yield `\uFEFF${headers.map(csvCell).join(",")}\r\n`;
  try {
    for await (const record of coupleCursor) yield `${rowFor(record, record.patient).map(csvCell).join(",")}\r\n`;
  } finally {
    await coupleCursor.close().catch(() => {});
  }
}

module.exports = { couplePatientCsvStream };
