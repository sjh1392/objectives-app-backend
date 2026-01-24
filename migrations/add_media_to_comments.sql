-- Add media support to comments table
ALTER TABLE comments ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS media_type TEXT; -- 'audio' or 'video'

-- Create index for media queries
CREATE INDEX IF NOT EXISTS idx_comments_media_url ON comments(media_url) WHERE media_url IS NOT NULL;

