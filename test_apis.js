// Diagnostics script

async function testOpenAI() {
  console.log('Testing OpenAI...');
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Tell me a joke." }],
        max_tokens: 10
      }),
    });
    console.log(`OpenAI Status: ${res.status}`);
    const data = await res.json();
    if (!res.ok) console.log('OpenAI Error:', data);
    else console.log('OpenAI Success:', data.choices[0].message.content);
  } catch (err) {
    console.log('OpenAI Fetch Error:', err.message);
  }
}

async function testGemini(version = 'v1beta', model = 'gemini-1.5-flash') {
  console.log(`Testing Gemini (${version}, ${model})...`);
  try {
    const url = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Tell me a joke." }] }],
        generationConfig: { maxOutputTokens: 10 }
      }),
    });
    console.log(`Gemini Status: ${res.status}`);
    const data = await res.json();
    if (!res.ok) console.log('Gemini Error:', data);
    else console.log('Gemini Success:', data.candidates[0].content.parts[0].text);
  } catch (err) {
    console.log('Gemini Fetch Error:', err.message);
  }
}

async function testApollo() {
  console.log('Testing Apollo...');
  try {
    const res = await fetch("https://api.apollo.io/v1/people/match", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": process.env.APOLLO_API_KEY,
      },
      body: JSON.stringify({ 
        linkedin_url: "https://www.linkedin.com/in/williamhgates" 
      }),
    });
    console.log(`Apollo Status: ${res.status}`);
    const data = await res.json();
    if (!res.ok) console.log('Apollo Error:', data);
    else console.log('Apollo Success:', data.person ? 'Found person' : 'Not found', data.person?.email || 'No email');
  } catch (err) {
    console.log('Apollo Fetch Error:', err.message);
  }
}

async function testHunter() {
  console.log('Testing Hunter...');
  try {
    const domain = "microsoft.com";
    const firstName = "Satya";
    const lastName = "Nadella";
    const url = `https://api.hunter.io/v2/email-finder?domain=${domain}&first_name=${firstName}&last_name=${lastName}&api_key=${process.env.HUNTER_API_KEY}`;
    const res = await fetch(url);
    console.log(`Hunter Status: ${res.status}`);
    const data = await res.json();
    if (!res.ok) console.log('Hunter Error:', data);
    else console.log('Hunter Success:', data.data?.email || 'No email');
  } catch (err) {
    console.log('Hunter Fetch Error:', err.message);
  }
}

async function runAll() {
  await testOpenAI();
  console.log('---');
  await testGemini('v1beta', 'gemini-2.0-flash');
  await testGemini('v1', 'gemini-2.0-flash');
  console.log('---');
  await testApollo();
  console.log('---');
  await testHunter();
}

runAll();
