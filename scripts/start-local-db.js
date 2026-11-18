// Starts a private MongoDB replica set for local development on port 27018.
// Data stays in the .local-mongodb folder. Press Ctrl+C to stop it.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");

const PORT = 27018;
const REPLICA_SET = "local-rs";
const dataDirectory = path.join(__dirname, "..", ".local-mongodb");

function findMongod() {
  if (process.env.MONGOD_PATH) return process.env.MONGOD_PATH;
  const serverRoot = "C:\\Program Files\\MongoDB\\Server";
  if (fs.existsSync(serverRoot)) {
    const versions = fs.readdirSync(serverRoot).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const candidate = path.join(serverRoot, version, "bin", "mongod.exe");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "mongod";
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function initiateReplicaSet() {
  let connection;
  for (let attempt = 0; attempt < 40 && !connection; attempt += 1) {
    try {
      connection = await mongoose.createConnection(`mongodb://127.0.0.1:${PORT}/admin?directConnection=true`, { serverSelectionTimeoutMS: 1000 }).asPromise();
    } catch {
      await sleep(500);
    }
  }
  if (!connection) throw new Error("MongoDB did not start. Check .local-mongodb/mongod.log");

  const admin = connection.db.admin();
  await admin.command({ replSetInitiate: { _id: REPLICA_SET, members: [{ _id: 0, host: `127.0.0.1:${PORT}` }] } }).catch(error => {
    if (error.codeName !== "AlreadyInitialized") throw error;
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await admin.command({ hello: 1 })).isWritablePrimary) break;
    await sleep(500);
  }
  await connection.close();
}

fs.mkdirSync(dataDirectory, { recursive: true });
const mongod = spawn(findMongod(), [
  "--replSet", REPLICA_SET, "--port", String(PORT), "--bind_ip", "127.0.0.1",
  "--dbpath", dataDirectory, "--logpath", path.join(dataDirectory, "mongod.log"), "--logappend"
], { stdio: "ignore" });

mongod.on("error", error => {
  console.error(`Could not start MongoDB: ${error.message}`);
  process.exit(1);
});
mongod.on("exit", code => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => mongod.kill());

initiateReplicaSet()
  .then(() => console.log(`Local database is ready on port ${PORT}. Keep this terminal open.`))
  .catch(error => {
    console.error(error.message);
    mongod.kill();
  });
