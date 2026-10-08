// Proves the modular server answers exactly like the old monolithic one.
// Set LEGACY_SERVER to the path of the old server.js to run the comparison;
// without it only the new server's transcript is checked for sanity.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tempDir, seedData, startServer } = require("./helpers");
const { runScenario } = require("./scenario");

async function transcriptFor(entry) {
  const dataDir = tempDir("data");
  const uploadsDir = tempDir("uploads");
  seedData(dataDir);
  const server = await startServer({
    entry,
    cwd: path.dirname(entry),
    env: { DATA_DIR: dataDir, UPLOADS_DIR: uploadsDir },
  });
  try {
    return await runScenario(server.base);
  } finally {
    await server.stop();
  }
}

test("new server: scenario transcript is sane", async () => {
  const transcript = await transcriptFor(path.join(__dirname, "..", "server", "index.js"));
  const byName = Object.fromEntries(transcript.map((step) => [step.name, step]));
  assert.equal(byName["login: ok"].status, 200);
  assert.equal(byName["products: create ok"].status, 201);
  assert.equal(byName["orders: ok with requestId"].status, 201);
  assert.equal(byName["orders: retry same requestId"].status, 200);
  assert.deepEqual(byName["orders: retry same requestId"].body, byName["orders: ok with requestId"].body);
  assert.equal(byName["orders: cart with a removed product"].status, 409);
  assert.equal(byName["orders: cart with a removed product"].body.code, "catalog_changed");
  assert.equal(byName["orders: rate limit #6"].status, 429);
  assert.equal(byName["orders: patch without version"].status, 428);
  assert.equal(byName["orders: patch bad status"].status, 400);
  assert.equal(byName["orders: patch status+note"].status, 200);
  assert.equal(byName["orders: patch status+note"].body.version, 2);
  assert.equal(byName["orders: patch stale version"].status, 409);
  assert.equal(byName["orders: patch stale version"].body.code, "version_conflict");
  assert.equal(byName["orders: patch contact"].status, 200);
  assert.equal(byName["session after logout"].status, 401);
  assert.equal(byName["static: server source not served"].status, 404);
});

const legacy = process.env.LEGACY_SERVER;
test(
  "new server answers exactly like the legacy server",
  { skip: !legacy || !fs.existsSync(legacy) ? "LEGACY_SERVER не задан" : false },
  async () => {
    const [before, after] = [await transcriptFor(legacy), await transcriptFor(path.join(__dirname, "..", "server", "index.js"))];
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i += 1) {
      assert.deepEqual(after[i], before[i], `Шаг "${before[i].name}" отличается`);
    }
    if (process.env.COMPAT_REPORT) {
      fs.writeFileSync(process.env.COMPAT_REPORT, JSON.stringify({ steps: before.length, before, after }, null, 2));
    }
  }
);
