require('dotenv').config({ path: '.env.local' });
console.log('Supabase URL:', process.env.NEXT_PUBLIC_SUPABASE_URL ? '✅' : '❌');
console.log('Scraper URL:', process.env.NEXT_PUBLIC_SCRAPER_SERVICE_URL ? '✅' : '❌');
console.log('LinkedIn Email:', (process.env.NEXT_PUBLIC_LINKEDIN_EMAIL || process.env.LINKEDIN_EMAIL) ? '✅' : '❌');
console.log('LinkedIn Pass:', (process.env.NEXT_PUBLIC_LINKEDIN_PASSWORD || process.env.LINKEDIN_PASSWORD) ? '✅' : '❌');
console.log('Groq Key:', process.env.GROQ_API_KEY ? '✅' : '❌');
