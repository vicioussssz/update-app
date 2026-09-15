-- ============================================================
-- Statements: bank, credit card and account statements.
--
-- Its own table, entirely separate from receipts. Nothing in this script
-- touches the receipts, folders, plans, projects or site records data, and no
-- receipt ever needs a statement to exist. Safe to run twice.
--
-- The files themselves go in the existing private "receipts" bucket under a
-- statements/ folder, so they inherit the storage rules already in place.
-- ============================================================

create table if not exists public.statements (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  title           text not null,
  -- the period the statement covers. period_end is optional: a single-date
  -- statement just has a start.
  period_start    date not null,
  period_end      date,
  category        text,                         -- Bank / Credit card / Account / ...
  project_id      uuid references public.projects(id) on delete set null,
  file_path       text not null,
  file_type       text,
  file_size       bigint,
  created_by      uuid not null default auth.uid(),
  created_by_name text
);

create index if not exists statements_period_idx  on public.statements (period_start desc);
create index if not exists statements_project_idx on public.statements (project_id);

alter table public.statements enable row level security;

-- the same shared-pool rules as the rest of the app: everyone signed in sees
-- the same documents, and only a signed-in account can add to them
drop policy if exists "statements readable"   on public.statements;
drop policy if exists "statements insertable" on public.statements;
drop policy if exists "statements updatable"  on public.statements;
drop policy if exists "statements deletable"  on public.statements;

create policy "statements readable"   on public.statements for select to authenticated using (true);
create policy "statements insertable" on public.statements for insert to authenticated
  with check (auth.uid() = created_by);
create policy "statements updatable"  on public.statements for update to authenticated
  using (true) with check (true);
create policy "statements deletable"  on public.statements for delete to authenticated using (true);

-- ---- check it worked ----
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'statements'
order by ordinal_position;
