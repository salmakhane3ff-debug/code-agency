-- Feedback display date — ADDITIVE migration (no DROP / rename / destructive change).
-- Adds an admin-editable review DISPLAY date. Nullable, so every existing row
-- keeps NULL and the UI falls back to createdAt (unchanged behaviour).
--
-- Deliberately a new column rather than reusing:
--   createdAt   - stripped by updateFeedback(); an audit field
--   publishAt   - drives SCHEDULED visibility
--   publishedAt - overwritten by approveFeedback() on every approve

ALTER TABLE "feedbacks" ADD COLUMN IF NOT EXISTS "reviewDate" TIMESTAMP(3);
