-- Objective Subscriptions Table
-- Allows users to subscribe to notifications for specific objectives

CREATE TABLE IF NOT EXISTS objective_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  objective_id TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, objective_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (objective_id) REFERENCES objectives(id) ON DELETE CASCADE
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_objective_subscriptions_user_id ON objective_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_objective_subscriptions_objective_id ON objective_subscriptions(objective_id);

