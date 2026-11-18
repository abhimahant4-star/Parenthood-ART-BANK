const mongoose = require("mongoose");

/**
 * Run a database unit of work in a MongoDB transaction.
 * The callback must pass the supplied session to every participating query
 * and write. Transaction operations must remain sequential.
 */
async function withTransaction(work, options) {
  if (typeof work !== "function") throw new TypeError("A transaction callback is required");

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    }, options);
    return result;
  } finally {
    await session.endSession();
  }
}

class RouteError extends Error {
  constructor(status, message, errorCode, data) {
    super(message);
    this.name = "RouteError";
    this.status = status;
    this.errorCode = errorCode;
    this.data = data;
  }
}

function sendRouteError(res, error, fallback) {
  if (error instanceof RouteError) {
    const body = { success: false, message: error.message, errorCode: error.errorCode };
    if (error.data !== undefined) body.data = error.data;
    return res.status(error.status).json(body);
  }
  console.error(error);
  return res.status(500).json({ success: false, message: fallback.message, errorCode: fallback.errorCode });
}

module.exports = { withTransaction, RouteError, sendRouteError };
