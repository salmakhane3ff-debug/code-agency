# Archived migrations — historical record only

These 28 directories are the migration history up to `20261024_demo_chat_audit_truncate_guard`, moved
here unchanged (byte for byte, `git mv`) in Phase 3C-9A. **Prisma does not read this folder and never
applies these files.** The active chain is `prisma/migrations/`, whose single
`20261025000000_baseline` reproduces the full schema plus every custom SQL object defined here.

Kept for: audit/history, the exact original SQL of the custom objects, and the tests/harnesses that check
historical migration content. Existing databases may list these names in `_prisma_migrations`; that is
expected. Do not edit, rename, delete or move files back. See `prisma/migrations/README.md`.
