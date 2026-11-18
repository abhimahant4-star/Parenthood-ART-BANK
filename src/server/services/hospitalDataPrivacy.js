function plainRecord(value) {
  return value?.toObject ? value.toObject() : { ...value };
}

function minimizeHospitalVial(value) {
  const record = plainRecord(value);
  delete record.donorId;
  delete record.donorUhid;
  delete record.batchId;
  delete record.statusHistory;
  return record;
}

function minimizeHospitalOrder(value) {
  const record = plainRecord(value);
  delete record.donorId;
  return record;
}

function minimizeCeoOrder(value) {
  const record = plainRecord(value);
  return {
    orderId: record.orderId,
    hospitalId: record.hospitalId,
    centreId: record.centreId,
    items: record.items,
    status: record.status,
    vialCount: Array.isArray(record.vialIds) ? record.vialIds.length : 0,
    dispatchedAt: record.dispatchedAt,
    receivedAt: record.receivedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

module.exports = { minimizeHospitalVial, minimizeHospitalOrder, minimizeCeoOrder };
