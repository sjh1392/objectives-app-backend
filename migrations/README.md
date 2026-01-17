# Database Migrations

## Running Migrations

Since this project uses Supabase (PostgreSQL), migrations need to be run manually through the Supabase dashboard.

### To run the companies table migration:

1. Go to your Supabase project dashboard
2. Navigate to **SQL Editor** (in the left sidebar)
3. Click **New Query**
4. Copy and paste the contents of `add_company_table.sql`
5. Click **Run** to execute the migration

### Migration Files

- `add_company_table.sql` - Creates the companies table for the onboarding flow

The migration uses `CREATE TABLE IF NOT EXISTS`, so it's safe to run multiple times.

