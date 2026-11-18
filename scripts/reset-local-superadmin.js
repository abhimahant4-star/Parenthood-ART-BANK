require("dotenv").config({ path: ".env.local" });

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../src/server/models/User");

async function resetLocalSuperAdmin() {
  const uri = process.env.MONGODB_URI;
  const password = process.env.SEED_SUPERADMIN_PASSWORD;
  const username = process.env.SEED_SUPERADMIN_USERNAME || "superadmin";

  if (process.env.NODE_ENV === "production") {
    throw new Error("This local-only reset tool cannot run in production.");
  }
  if (!uri) throw new Error("MONGODB_URI is required.");

  const hostname = new URL(uri).hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname)) {
    throw new Error("Refusing to reset an account unless MongoDB is on this computer.");
  }
  if (!password || password.length < 12) {
    throw new Error("Set SEED_SUPERADMIN_PASSWORD to a password of at least 12 characters in backend/.env.");
  }

  await mongoose.connect(uri);
  const user = await User.findOne({ username, role: "SUPER_ADMIN" });
  if (!user) throw new Error(`Super Admin account '${username}' was not found.`);

  user.passwordHash = await bcrypt.hash(password, 12);
  user.activeSessionId = null;
  user.sessionVersion = (user.sessionVersion || 1) + 1;
  await user.save();

  console.log(`Local Super Admin password reset for '${username}'.`);
}

resetLocalSuperAdmin()
  .catch((error) => {
    console.error("Local Super Admin reset failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });
