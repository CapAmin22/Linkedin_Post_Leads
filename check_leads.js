
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

async function checkLeads() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Missing Supabase credentials');
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const { data: leads, error } = await supabase
    .from('scraped_leads')
    .select('*')
    .limit(10);

  if (error) {
    console.error('Error fetching leads:', error);
  } else {
    console.log(`Total leads found: ${leads.length}`);
    if (leads.length > 0) {
      const lead = leads[0];
      console.log('Sample Lead:');
      console.log(`Name: ${lead.full_name}`);
      console.log(`Email: ${lead.email}`);
      console.log(`Company: ${lead.company}`);
      console.log(`Source URL: ${lead.source_url}`);
      console.log(`Status: ${lead.status}`);
      console.log(`Created: ${lead.created_at}`);
    }
  }
}

checkLeads();
