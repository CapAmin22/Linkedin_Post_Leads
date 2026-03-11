import fs from 'fs';

// Load env
const env = fs.readFileSync('.env.local', 'utf-8');
const envVars = {};
env.split('\n').forEach(line => {
  const [key, ...val] = line.split('=');
  if (key && val.length > 0) envVars[key.trim()] = val.join('=').trim();
});

const APIFY_API_TOKEN = envVars.APIFY_API_TOKEN;

async function testApifyProfile() {
  console.log('\\n--- Testing Apify Profile Scraper ---');
  try {
    const actorId = "apimaestro~linkedin-profile-scraper";
    const profileUrl = "https://www.linkedin.com/in/ACoAAABNJ4UBpji08MgrHCxvZg6dwU74g6UTRnk"; 
    
    // Actually wait, let's use a real public URL just in case URN doesn't work, but URN is what we have. Let's try URN.
    const runRes = await fetch(
      `https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_API_TOKEN}&waitForFinish=90`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile_urls: [profileUrl] }),
      }
    );

    if (!runRes.ok) {
        console.error("Apify run failed", await runRes.text());
        return;
    }
    
    const runData = await runRes.json();
    console.log("Run success:", runData.data.status);
    const datasetId = runData.data.defaultDatasetId;

    const itemsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_TOKEN}`);
    if (!itemsRes.ok) {
        console.error("Apify items failed", await itemsRes.text());
        return;
    }

    const rawItems = await itemsRes.json();
    console.log("Raw Item 1:", JSON.stringify(rawItems[0], null, 2));
  } catch (err) {
    console.error("Apify Error:", err.message);
  }
}

testApifyProfile();
