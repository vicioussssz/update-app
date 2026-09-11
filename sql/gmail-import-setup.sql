-- ============================================================
-- Gmail import: remember which email attachment a receipt came from, so the
-- same one cannot be imported twice without a warning.
--
-- Two nullable columns on the existing receipts table and nothing else. No
-- emails are stored: the app reads Gmail live and only ever writes a receipt
-- when you explicitly choose "Add to Receipts". Safe to run twice.
-- ============================================================

alter table public.receipts add column if not exists gmail_message_id    text;
alter table public.receipts add column if not exists gmail_attachment_id text;

-- what an "already imported" check looks up
create index if not exists receipts_gmail_idx
  on public.receipts (gmail_message_id, gmail_attachment_id)
  where gmail_message_id is not null;

-- the exact-to-the-penny total check
create index if not exists receipts_amount_idx on public.receipts (amount);
