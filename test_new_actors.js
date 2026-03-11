import fs from 'fs';

// Load env
const env = fs.readFileSync('.env.local', 'utf-8');
const envVars = {};
env.split('\n').forEach(line => {
  const [key, ...val] = line.split('=');
  if (key && val.length > 0) envVars[key.trim()] = val.join('=').trim();
});

const APIFY_API_TOKEN = envVars.APIFY_API_TOKEN;

async function testActor(actorId, inputObject) {
  console.log(`\n--- Testing ${actorId} ---`);
  try {
    const runRes = await fetch(
      `https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_API_TOKEN}&waitForFinish=120`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inputObject),
      }
    );

    if (!runRes.ok) {
        console.error("Run failed:", await runRes.text());
        return;
    }
    
    const runData = await runRes.json();
    console.log("Status:", runData.data.status);
    
    if (runData.data.status !== "SUCCEEDED") return;

    const datasetId = runData.data.defaultDatasetId;
    const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_TOKEN}`);
    const items = await itemsRes.json();
    
    console.log(`Got ${items.length} items`);
    if (items.length > 0) {
        // Log just keys of first item to see structure
        console.log("Keys:", Object.keys(items[0]));
        fs.writeFileSync(`${actorId.replace('/', '_').replace('~', '_')}_debug.json`, JSON.stringify(items[0], null, 2));
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}

async function runAll() {
    await testActor("harvestapi~linkedin-profile-scraper", { profileUrls: ["https://www.linkedin.com/in/williamhgates"] });
    await testActor("dev_fusion~linkedin-profile-scraper", { profileUrls: ["https://www.linkedin.com/in/williamhgates"] });
    await testActor("curious_coder~linkedin-company-scraper", { urls: ["https://www.linkedin.com/company/microsoft"] });
}

runAll();
