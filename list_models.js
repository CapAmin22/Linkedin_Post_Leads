async function listModels() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.argv[2]}`;
  const res = await fetch(url);
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}
listModels();
