// Adds the production settings to the Vercel project, redeploys it and checks the live site.
// Secret values are read from the local env files, sent over stdin and never printed.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

const PROJECT = "parenthood-art-bank";
const SITE = `${PROJECT}.vercel.app`;
const root = path.join(__dirname, "..");
const readEnv = name => dotenv.parse(fs.readFileSync(path.join(root, name)));

function vercel(args, input) {
  return spawnSync(`npx --yes vercel@66.1.0 ${args}`, {
    cwd: root,
    shell: true,
    input,
    stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"]
  }).status;
}

function stop(message) {
  console.error(`\nStopped: ${message}`);
  process.exit(1);
}

function loadSettings() {
  const local = readEnv(".env.local");
  const production = readEnv(".env.production");
  if (!/^mongodb\+srv:\/\/.+\.net\/parenthood_art_bank/.test(local.MONGODB_URI || "") || local.MONGODB_URI.includes("<db_")) {
    stop("MONGODB_URI in .env.local must be the full Atlas connection string with /parenthood_art_bank.");
  }
  if (!production.JWT_SECRET || !production.UPLOAD_ENCRYPTION_KEY) {
    stop("JWT_SECRET and UPLOAD_ENCRYPTION_KEY must be set in .env.production.");
  }
  return [
    ["MONGODB_URI", local.MONGODB_URI, true],
    ["JWT_SECRET", production.JWT_SECRET, true],
    ["UPLOAD_ENCRYPTION_KEY", production.UPLOAD_ENCRYPTION_KEY, true],
    ["CLIENT_ORIGIN", `https://${SITE}`, false],
    ["TRUST_PROXY", "true", false],
    ["CLAMAV_HOST", "127.0.0.1", false]
  ];
}

async function checkSite() {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let status = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    status = await fetch(`https://${SITE}/api/ready`, { cache: "no-store" }).then(response => response.status).catch(() => 0);
    if (status === 200) break;
    await sleep(5000);
  }
  if (status === 200) {
    console.log(`\nDone. The site and database are connected: https://${SITE}/login`);
  } else if (status === 503) {
    console.log("\nThe site is running but cannot reach Atlas.");
    console.log("In MongoDB Atlas, open Network Access, add 0.0.0.0/0, wait one minute and try logging in.");
  } else {
    console.log(`\nThe site is still failing (status ${status}). Open the latest deployment's Logs in Vercel.`);
  }
}

async function main() {
  const settings = loadSettings();

  console.log("Step 1 of 4: Vercel sign-in");
  if (vercel("whoami") !== 0 && vercel("login") !== 0) stop("Vercel sign-in did not finish.");

  console.log("\nStep 2 of 4: Linking this folder to the Vercel project");
  if (vercel(`link --yes --project ${PROJECT}`) !== 0) stop(`Could not link to the ${PROJECT} project.`);

  console.log("\nStep 3 of 4: Saving settings");
  for (const [name, value, secret] of settings) {
    const type = secret ? "--sensitive" : "--no-sensitive";
    if (vercel(`env add ${name} --environment production --force --yes ${type}`, value) !== 0) stop(`Could not save ${name}.`);
  }

  console.log("\nStep 4 of 4: Redeploying");
  if (vercel(`redeploy ${SITE} --environment production`) !== 0) stop("The redeploy failed.");

  await checkSite();
}

main().catch(error => stop(error.message));
