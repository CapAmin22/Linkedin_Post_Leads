
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

async function checkUsers() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const { data: users, error } = await supabase.auth.admin.listUsers();

  if (error) {
    console.error('Error fetching users:', error);
  } else {
    console.log('Total users found:', users.users.length);
    if (users.users.length > 0) {
      console.log('Sample User Email:', users.users[0].email);
    }
  }
}

checkUsers();
