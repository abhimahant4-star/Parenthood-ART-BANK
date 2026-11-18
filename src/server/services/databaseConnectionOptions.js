"use strict";

function databaseConnectionOptions(nodeEnv) {
  if (nodeEnv === "production") return { autoIndex: false, autoCreate: false };
  return {};
}

module.exports = { databaseConnectionOptions };
