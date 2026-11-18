const { csvCell } = require("./csvService");

const headers = [
  "Order ID", "Hospital ID", "Centre ID", "Requested By", "Purpose", "Status",
  "Vial IDs", "Dispatched By", "Dispatched At", "Received By", "Received At", "Created At"
];

function rowFor(order) {
  return [
    order.orderId || "",
    order.hospitalId || "",
    order.centreId || "",
    order.requestedBy || "",
    order.purpose || "",
    order.status || "",
    Array.isArray(order.vialIds) ? order.vialIds.join(", ") : "",
    order.dispatchedBy || "",
    order.dispatchedAt ? new Date(order.dispatchedAt).toISOString() : "",
    order.receivedBy || "",
    order.receivedAt ? new Date(order.receivedAt).toISOString() : "",
    order.createdAt ? new Date(order.createdAt).toISOString() : ""
  ];
}

async function* orderCsvStream(orderCursor, { bom = false } = {}) {
  try {
    yield `${bom ? "\uFEFF" : ""}${headers.map(csvCell).join(",")}\r\n`;
    for await (const order of orderCursor) {
      yield `${rowFor(order).map(csvCell).join(",")}\r\n`;
    }
  } finally {
    await orderCursor.close().catch(() => {});
  }
}

module.exports = { orderCsvStream, headers, rowFor };
