-- Add invitation_id column to notifications table for tracking invitation-related notifications
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS invitation_id TEXT;

-- Create index for performance
CREATE INDEX IF NOT EXISTS idx_notifications_invitation_id ON notifications(invitation_id) WHERE invitation_id IS NOT NULL;

