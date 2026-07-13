-- Privacy-first first-party product analytics.
-- Client traffic reaches this table only through the server-side ingestion route.
-- Raw IPs, access tokens, emails, prompts, scenarios, query strings, and referrers
-- are intentionally not part of the schema.

create table if not exists public.product_events (
  id bigint generated always as identity primary key,
  event_id uuid not null default gen_random_uuid(),
  event_name text not null,
  source text not null,
  user_id uuid null references public.profiles(id) on delete set null,
  session_id uuid null,
  page_path text null,
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint product_events_event_id_key unique (event_id),
  constraint product_events_event_name_check check (
    event_name in (
      'page_viewed',
      'signup_started',
      'signup_completed',
      'analysis_started',
      'analysis_succeeded',
      'storyboard_started',
      'storyboard_enqueued',
      'storyboard_completed',
      'storyboard_failed',
      'checkout_started',
      'checkout_completed',
      'purchase_completed'
    )
  ),
  constraint product_events_source_check check (source in ('client', 'server')),
  constraint product_events_client_session_check check (
    source = 'server' or session_id is not null
  ),
  constraint product_events_server_user_check check (
    source = 'client' or user_id is not null
  ),
  constraint product_events_page_path_check check (
    page_path is null
    or (
      char_length(page_path) between 1 and 200
      and position('?' in page_path) = 0
      and position('#' in page_path) = 0
    )
  ),
  constraint product_events_properties_object_check check (
    jsonb_typeof(properties) = 'object'
    and octet_length(properties::text) <= 4096
  )
);

alter table public.product_events enable row level security;

revoke all on table public.product_events from public, anon, authenticated;
grant select, insert, delete on table public.product_events to service_role;
grant usage, select on sequence public.product_events_id_seq to service_role;

create index if not exists idx_product_events_event_created
  on public.product_events (event_name, created_at desc);

create index if not exists idx_product_events_user_created
  on public.product_events (user_id, created_at desc)
  where user_id is not null;

create index if not exists idx_product_events_session_created
  on public.product_events (session_id, created_at desc)
  where session_id is not null;

create or replace function public.purge_product_events(
  p_retention_days integer default 180
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted bigint;
begin
  if p_retention_days < 30 or p_retention_days > 730 then
    raise exception 'retention days must be between 30 and 730';
  end if;

  delete from public.product_events
  where created_at < now() - make_interval(days => p_retention_days);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_product_events(integer)
  from public, anon, authenticated;
grant execute on function public.purge_product_events(integer)
  to service_role;

create extension if not exists pg_cron with schema pg_catalog;

do $$
declare
  existing_job bigint;
begin
  select jobid
    into existing_job
  from cron.job
  where jobname = 'promptgen-product-events-retention'
  limit 1;

  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;

  perform cron.schedule(
    'promptgen-product-events-retention',
    '17 3 * * *',
    $job$select public.purge_product_events(180);$job$
  );
end;
$$;
