-- PostgreSQL Schema Migration for Objectives App
-- Converted from SQLite to PostgreSQL syntax

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'Team Member',
  department TEXT,
  avatar TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Departments table
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  manager_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Objectives table
CREATE TABLE IF NOT EXISTS objectives (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  owner_id TEXT,
  department_id TEXT,
  parent_objective_id TEXT,
  status TEXT DEFAULT 'Active',
  priority TEXT DEFAULT 'Medium',
  start_date DATE,
  due_date DATE,
  target_value DOUBLE PRECISION,
  current_value DOUBLE PRECISION,
  progress_percentage DOUBLE PRECISION DEFAULT 0,
  tags JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP WITH TIME ZONE,
  FOREIGN KEY (owner_id) REFERENCES users(id),
  FOREIGN KEY (department_id) REFERENCES departments(id),
  FOREIGN KEY (parent_objective_id) REFERENCES objectives(id)
);

-- Key Results table
CREATE TABLE IF NOT EXISTS key_results (
  id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  target_value DOUBLE PRECISION,
  current_value DOUBLE PRECISION,
  progress_percentage DOUBLE PRECISION DEFAULT 0,
  unit TEXT DEFAULT 'percentage',
  status TEXT DEFAULT 'Not Started',
  due_date DATE,
  auto_update_progress BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE CASCADE
);

-- Progress Updates table
CREATE TABLE IF NOT EXISTS progress_updates (
  id TEXT PRIMARY KEY,
  objective_id TEXT,
  key_result_id TEXT,
  user_id TEXT,
  previous_value DOUBLE PRECISION,
  new_value DOUBLE PRECISION,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (objective_id) REFERENCES objectives(id),
  FOREIGN KEY (key_result_id) REFERENCES key_results(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Comments table
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL,
  user_id TEXT,
  content TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Contributors table (many-to-many between objectives and users)
CREATE TABLE IF NOT EXISTS objective_contributors (
  id TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(objective_id, user_id),
  FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Webhook integrations table
CREATE TABLE IF NOT EXISTS webhook_integrations (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  webhook_secret TEXT NOT NULL,
  field_mapping TEXT,
  status TEXT DEFAULT 'active',
  last_received_at TIMESTAMP WITH TIME ZONE,
  failure_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE CASCADE
);

-- Webhook events table
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  webhook_integration_id TEXT NOT NULL,
  payload TEXT,
  headers TEXT,
  processed BOOLEAN DEFAULT false,
  error_message TEXT,
  value_before DOUBLE PRECISION,
  value_after DOUBLE PRECISION,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (webhook_integration_id) REFERENCES webhook_integrations(id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_objectives_owner_id ON objectives(owner_id);
CREATE INDEX IF NOT EXISTS idx_objectives_department_id ON objectives(department_id);
CREATE INDEX IF NOT EXISTS idx_objectives_status ON objectives(status);
CREATE INDEX IF NOT EXISTS idx_objectives_tags ON objectives USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_key_results_objective_id ON key_results(objective_id);
CREATE INDEX IF NOT EXISTS idx_progress_updates_objective_id ON progress_updates(objective_id);
CREATE INDEX IF NOT EXISTS idx_comments_objective_id ON comments(objective_id);
CREATE INDEX IF NOT EXISTS idx_objective_contributors_objective_id ON objective_contributors(objective_id);
CREATE INDEX IF NOT EXISTS idx_objective_contributors_user_id ON objective_contributors(user_id);
CREATE INDEX IF NOT EXISTS idx_webhook_integrations_objective_id ON webhook_integrations(objective_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_webhook_integration_id ON webhook_events(webhook_integration_id);

