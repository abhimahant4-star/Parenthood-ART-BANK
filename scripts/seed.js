require("dotenv").config({ path: process.env.NODE_ENV === "production" ? ".env.production" : ".env.local" });

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const User = require("../src/server/models/User");

async function seed() {
  try {
    const superAdminPassword = process.env.SEED_SUPERADMIN_PASSWORD;
    const hospitalPassword = process.env.SEED_HOSPITAL_PASSWORD;
    const superAdminUsername = process.env.SEED_SUPERADMIN_USERNAME || "superadmin";
    const hospitalUsername = process.env.SEED_HOSPITAL_USERNAME || "hospitalA";
    const hospitalName = process.env.SEED_HOSPITAL_NAME || "Initial Hospital User";
    const hospitalId = process.env.SEED_HOSPITAL_ID;
    const centreId = process.env.SEED_CENTRE_ID;
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required before seeding");
    if (!superAdminPassword || superAdminPassword.length < 12 || !hospitalPassword || hospitalPassword.length < 12) {
      throw new Error("Set unique SEED_SUPERADMIN_PASSWORD and SEED_HOSPITAL_PASSWORD values of at least 12 characters before seeding");
    }
    if (!hospitalId || !centreId) throw new Error("Set the real SEED_HOSPITAL_ID and SEED_CENTRE_ID before seeding");
    await mongoose.connect(process.env.MONGODB_URI);

    console.log("MongoDB connected");

    // ==============================
    // SUPER ADMIN
    // ==============================

    let superAdmin = await User.findOne({
      username: superAdminUsername
    });

    if (!superAdmin) {
      const passwordHash = await bcrypt.hash(superAdminPassword, 12);

      superAdmin = await User.create({
        username: superAdminUsername,
        passwordHash,
        name: "Super Admin",
        role: "SUPER_ADMIN",
        hospitalId: null,
        centreId: null,
        chainId: null,
        active: true,
        activeSessionId: null
      });

      console.log("Super Admin created");
    } else {
      console.log("Super Admin already exists");
    }

    // ==============================
    // HOSPITAL USER
    // ==============================

    let hospitalUser = await User.findOne({
      username: hospitalUsername
    });

    if (!hospitalUser) {
      const passwordHash = await bcrypt.hash(hospitalPassword, 12);

      hospitalUser = await User.create({
        username: hospitalUsername,
        passwordHash,
        name: hospitalName,
        role: "HOSPITAL_USER",
        hospitalId,
        centreId,
        chainId: process.env.SEED_CHAIN_ID || null,
        active: true,
        activeSessionId: null
      });

      console.log("Hospital User created");
    } else {
      console.log("Hospital User already exists");
    }

    console.log("================================");
    console.log("SEED COMPLETED");
    console.log("================================");
    console.log("Super Admin:");
    console.log(`Username: ${superAdminUsername}`);
    console.log("Password: supplied securely through SEED_SUPERADMIN_PASSWORD");
    console.log("--------------------------------");
    console.log("Hospital User:");
    console.log(`Username: ${hospitalUsername}`);
    console.log("Password: supplied securely through SEED_HOSPITAL_PASSWORD");
    console.log(`Hospital ID: ${hospitalId}`);
    console.log(`Centre ID: ${centreId}`);
    console.log("================================");

    process.exit(0);

  } catch (error) {
    console.error("Seed error:", error);
    process.exit(1);
  }
}

seed();
