
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

async function verifyAuth() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabase = createClient(supabaseUrl, anonKey);

  const email = 'aminshaikhone@gmail.com';
  const passwords = ['Captainamin@22', 'Captaiamin@22'];

  for (const password of passwords) {
    console.log(`Testing password: ${password}`);
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      console.error(`❌ Failed: ${error.message}`);
    } else {
      console.log(`✅ Success! Logged in as: ${data.user.email}`);
      return;
    }
  }
}

verifyAuth();
