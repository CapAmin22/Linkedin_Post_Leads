
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

async function debugAuth() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase = createClient(supabaseUrl, serviceKey);

  console.log('--- Auth Debug ---');
  const { data: users, error } = await supabase.auth.admin.listUsers();
  
  if (error) {
    console.error('Error:', error.message);
    return;
  }

  const target = users.users.find(u => u.email === 'aminshaikhone@gmail.com');
  if (target) {
    console.log('User found:', target.email);
    console.log('Confirmed at:', target.email_confirmed_at);
    console.log('Last sign in:', target.last_sign_in_at);
  } else {
    console.log('User NOT found: aminshaikhone@gmail.com');
    console.log('All Users:', users.users.map(u => u.email));
  }
}

debugAuth();
