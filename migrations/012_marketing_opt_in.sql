-- Internal automation support: marketing consent for reactivation campaigns.
ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_opt_in BOOLEAN NOT NULL DEFAULT false;
