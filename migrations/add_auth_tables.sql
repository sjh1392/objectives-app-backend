-- Authentication and Multi-Tenant System Migration
-- Run this after create_schema.sql

-- Organizations table
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add authentication fields to existing users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMP WITH TIME ZONE;

-- Add foreign key constraints
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_organization_id_fkey'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_organization_id_fkey 
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_invited_by_fkey'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_invited_by_fkey 
      FOREIGN KEY (invited_by) REFERENCES users(id);
  END IF;
END $$;

-- Invitations table
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  organization_id TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  role TEXT DEFAULT 'Team Member',
  status TEXT DEFAULT 'pending', -- pending, accepted, expired, cancelled
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  accepted_at TIMESTAMP WITH TIME ZONE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE
);

-- Sessions table (for token management/blacklisting)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_organization_id ON users(organization_id);
CREATE INDEX IF NOT EXISTS idx_users_email_verification_token ON users(email_verification_token);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);
CREATE INDEX IF NOT EXISTS idx_invitations_organization_id ON invitations(organization_id);
CREATE INDEX IF NOT EXISTS idx_invitations_status ON invitations(status);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);

-- Add organization_id to objectives and departments for multi-tenant support
ALTER TABLE objectives ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE departments ADD COLUMN IF NOT EXISTS organization_id TEXT;

-- Add foreign keys
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'objectives_organization_id_fkey'
  ) THEN
    ALTER TABLE objectives ADD CONSTRAINT objectives_organization_id_fkey 
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'departments_organization_id_fkey'
  ) THEN
    ALTER TABLE departments ADD CONSTRAINT departments_organization_id_fkey 
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_objectives_organization_id ON objectives(organization_id);
CREATE INDEX IF NOT EXISTS idx_departments_organization_id ON departments(organization_id);

-- Update existing users to have a default organization (if needed)
-- This is a one-time migration for existing data
DO $$
DECLARE
  default_org_id TEXT;
BEGIN
  -- Check if there are users without organizations
  IF EXISTS (SELECT 1 FROM users WHERE organization_id IS NULL LIMIT 1) THEN
    -- Create a default organization for existing users
    -- Generate a unique ID using timestamp and random
    default_org_id := 'default-org-' || extract(epoch from now())::text || '-' || md5(random()::text);
    
    INSERT INTO organizations (id, name, slug)
    VALUES (default_org_id, 'Default Organization', 'default-org')
    ON CONFLICT (id) DO NOTHING;
    
    -- Assign all users without org to default org
    UPDATE users 
    SET organization_id = default_org_id 
    WHERE organization_id IS NULL;
    
    -- Assign all objectives and departments to default org
    UPDATE objectives 
    SET organization_id = default_org_id 
    WHERE organization_id IS NULL;
    
    UPDATE departments 
    SET organization_id = default_org_id 
    WHERE organization_id IS NULL;
  END IF;
END $$;
