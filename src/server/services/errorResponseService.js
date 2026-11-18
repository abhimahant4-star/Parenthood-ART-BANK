function publicErrorMessage(error, fallback, isProduction = process.env.NODE_ENV === "production") {
  if (isProduction) return fallback;
  return error?.message || fallback;
}

module.exports = { publicErrorMessage };
