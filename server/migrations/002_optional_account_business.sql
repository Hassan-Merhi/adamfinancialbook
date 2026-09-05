-- Accounts may stand on their own. Existing account-to-business assignments are preserved.
ALTER TABLE accounts ALTER COLUMN business_id DROP NOT NULL;
