-- Make organization name nullable so it can be set during onboarding
ALTER TABLE organizations ALTER COLUMN name DROP NOT NULL;

