async function testHunterDomainSearch() {
  console.log('Testing Hunter Domain Search...');
  try {
    const company = "Microsoft";
    const url = `https://api.hunter.io/v2/domain-search?company=${company}&api_key=${process.env.HUNTER_API_KEY}`;
    const res = await fetch(url);
    console.log(`Hunter Status: ${res.status}`);
    const data = await res.json();
    if (!res.ok) console.log('Hunter Error:', data);
    else console.log('Hunter Success:', data.data?.domain || 'No domain', data.data?.organization || 'No org');
  } catch (err) {
    console.log('Hunter Fetch Error:', err.message);
  }
}
testHunterDomainSearch();
