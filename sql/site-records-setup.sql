-- ============================================================
-- Site Records: photographic evidence of work before it is covered up.
-- Its own tables, entirely separate from receipts. Safe to run twice.
-- Nothing in this script touches the receipts, folders, plans or projects data.
-- ============================================================

-- one record = one thing that was done, on one day, on one job
create table if not exists public.site_records (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  project_id      uuid references public.projects(id) on delete set null,
  title           text not null,
  record_date     date not null,
  location        text,
  notes           text,
  created_by      uuid not null default auth.uid(),
  created_by_name text
);

-- many photos to one record; deleting the record takes its photos with it
create table if not exists public.site_photos (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  record_id   uuid not null references public.site_records(id) on delete cascade,
  file_path   text not null,
  file_type   text,
  file_size   bigint,
  sort        int not null default 0,
  created_by  uuid not null default auth.uid()
);

create index if not exists site_records_date_idx    on public.site_records (record_date desc);
create index if not exists site_records_project_idx on public.site_records (project_id);
create index if not exists site_photos_record_idx   on public.site_photos (record_id, sort);

alter table public.site_records enable row level security;
alter table public.site_photos  enable row level security;

-- the same shared-pool rules as the rest of the app: everyone signed in sees
-- the same evidence, and only a signed-in account can add to it
drop policy if exists "site records readable"   on public.site_records;
drop policy if exists "site records insertable" on public.site_records;
drop policy if exists "site records updatable"  on public.site_records;
drop policy if exists "site records deletable"  on public.site_records;

create policy "site records readable"   on public.site_records for select to authenticated using (true);
create policy "site records insertable" on public.site_records for insert to authenticated
  with check (auth.uid() = created_by);
create policy "site records updatable"  on public.site_records for update to authenticated
  using (true) with check (true);
create policy "site records deletable"  on public.site_records for delete to authenticated using (true);

drop policy if exists "site photos readable"   on public.site_photos;
drop policy if exists "site photos insertable" on public.site_photos;
drop policy if exists "site photos updatable"  on public.site_photos;
drop policy if exists "site photos deletable"  on public.site_photos;

create policy "site photos readable"   on public.site_photos for select to authenticated using (true);
create policy "site photos insertable" on public.site_photos for insert to authenticated
  with check (auth.uid() = created_by);
create policy "site photos updatable"  on public.site_photos for update to authenticated
  using (true) with check (true);
create policy "site photos deletable"  on public.site_photos for delete to authenticated using (true);
