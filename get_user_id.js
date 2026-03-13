
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

async function getUserId() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: users, error } = await supabase.auth.admin.listUsers();
  const target = users.users.find(u => u.email === 'aminshaikhone@gmail.com');
  console.log(target ? target.id : 'NOT_FOUND');
}

getUserId();
