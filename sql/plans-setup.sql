-- ============================================================
-- Planning v2: projects, and plans that run over a date range.
-- Safe to run more than once. Nothing outside these two tables is touched.
-- ============================================================

-- ---------- projects ----------
-- parent_id + kind are here so PROJECT -> BLOCK -> FLOOR -> UNIT can be added
-- later without another migration. For now everything is kind = 'project'.
create table if not exists public.projects (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name       text not null,
  kind       text not null default 'project',
  parent_id  uuid references public.projects(id) on delete cascade,
  archived   boolean not null default false,
  created_by uuid not null default auth.uid()
);

create index if not exists projects_parent_idx on public.projects (parent_id);

alter table public.projects enable row level security;

drop policy if exists "projects readable"   on public.projects;
drop policy if exists "projects insertable" on public.projects;
drop policy if exists "projects updatable"  on public.projects;
drop policy if exists "projects deletable"  on public.projects;

create policy "projects readable"   on public.projects for select to authenticated using (true);
create policy "projects insertable" on public.projects for insert to authenticated
  with check (auth.uid() = created_by);
create policy "projects updatable"  on public.projects for update to authenticated
  using (true) with check (true);
create policy "projects deletable"  on public.projects for delete to authenticated using (true);

-- ---------- plans: the table from the first version, extended ----------
create table if not exists public.plans (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  title           text not null,
  notes           text,
  created_by      uuid not null default auth.uid(),
  created_by_name text
);

-- a plan used to sit on one day; it now runs from a start date to an end date
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'plans'
               and column_name = 'plan_date')
  then
    alter table public.plans rename column plan_date to start_date;
  end if;
end $$;

alter table public.plans add column if not exists start_date date;
alter table public.plans add column if not exists end_date   date;
alter table public.plans add column if not exists project_id uuid references public.projects(id) on delete cascade;
alter table public.plans add column if not exists status     text not null default 'not_started';
alter table public.plans add column if not exists progress   int  not null default 0;

-- anything already in there keeps its date, as a one-day plan
update public.plans set end_date = start_date where end_date is null and start_date is not null;

alter table public.plans alter column start_date set not null;
alter table public.plans alter column end_date   set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'plans_status_check') then
    alter table public.plans add constraint plans_status_check
      check (status in ('not_started', 'in_progress', 'completed', 'delayed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'plans_progress_check') then
    alter table public.plans add constraint plans_progress_check
      check (progress between 0 and 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'plans_dates_check') then
    alter table public.plans add constraint plans_dates_check
      check (end_date >= start_date);
  end if;
end $$;

create index if not exists plans_start_idx   on public.plans (start_date);
create index if not exists plans_project_idx on public.plans (project_id);

alter table public.plans enable row level security;

drop policy if exists "plans readable"   on public.plans;
drop policy if exists "plans insertable" on public.plans;
drop policy if exists "plans updatable"  on public.plans;
drop policy if exists "plans deletable"  on public.plans;

create policy "plans readable"   on public.plans for select to authenticated using (true);
create policy "plans insertable" on public.plans for insert to authenticated
  with check (auth.uid() = created_by);
create policy "plans updatable"  on public.plans for update to authenticated
  using (true) with check (true);
create policy "plans deletable"  on public.plans for delete to authenticated using (true);
