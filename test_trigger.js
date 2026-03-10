const { tasks } = require('@trigger.dev/sdk/v3');
require('dotenv').config({ path: '.env.local' });

process.env.TRIGGER_API_KEY = process.env.TRIGGER_API_KEY;

if (!process.env.TRIGGER_API_KEY) {
  console.error('Missing TRIGGER_API_KEY environment variable');
  process.exit(1);
}

console.log('Testing Trigger.dev connection...');
console.log('API Key:', process.env.TRIGGER_API_KEY.substring(0, 10) + '...');

async function test() {
  try {
    const handle = await tasks.trigger("scrape-leads", { url: "https://www.linkedin.com/posts/activity-123", userId: "test-user-id" });
    console.log('Trigger.dev success! Job ID:', handle.id);
  } catch (error) {
    console.error('Trigger.dev error:', error);
  }
}

test();
