import fs from 'fs';

// Load env
const env = fs.readFileSync('.env.local', 'utf-8');
const envVars = {};
env.split('\n').forEach(line => {
  const [key, ...val] = line.split('=');
  if (key && val.length > 0) envVars[key.trim()] = val.join('=').trim();
});

const APIFY_API_TOKEN = envVars.APIFY_API_TOKEN;

async function testActor(actorId, inputKey) {
  console.log(`\n--- Testing ${actorId} ---`);
  try {
    const runRes = await fetch(
      `https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_API_TOKEN}&waitForFinish=20`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [inputKey]: ["https://www.linkedin.com/in/williamhgates"] }),
      }
    );

    if (!runRes.ok) {
        console.error("Failed:", await runRes.text());
        return;
    }
    
    const runData = await runRes.json();
    console.log("Success! Status:", runData.data.status);
    return runData;
  } catch (err) {
    console.error("Error:", err.message);
  }
}

async function runTests() {
  await testActor("curious_coder~linkedin-profile", "urls");
  await testActor("rocky~linkedin-profile-scraper", "urls");
  await testActor("voyager~linkedin-profile-scraper", "profileUrls");
  await testActor("lhotanok~linkedin-profile-scraper", "urls");
  await testActor("krakaw~linkedin-profile-scraper", "profileUrls");
}

runTests();
