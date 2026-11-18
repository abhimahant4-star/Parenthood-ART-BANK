require("dotenv").config({ path: process.env.NODE_ENV === "production" ? ".env.production" : ".env.local" });

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../src/server/models/User");

async function seedSuperAdmin() {
  const username = process.env.SEED_SUPERADMIN_USERNAME || "superadmin";
  const password = process.env.SEED_SUPERADMIN_PASSWORD;

  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required.");
  if (!password || password.length < 12) throw new Error("SEED_SUPERADMIN_PASSWORD must be at least 12 characters.");

  await mongoose.connect(process.env.MONGODB_URI);
  const existing = await User.findOne({ username });
  if (existing) throw new Error(`User '${username}' already exists; this command never changes an existing password.`);

  await User.create({
    username,
    passwordHash: await bcrypt.hash(password, 12),
    name: "Super Admin",
    role: "SUPER_ADMIN",
    hospitalId: null,
    centreId: null,
    chainId: null,
    active: true,
    activeSessionId: null
  });

  console.log(`Super Admin '${username}' created.`);
}

seedSuperAdmin()
  .catch((error) => {
    console.error("Super Admin setup failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  });
