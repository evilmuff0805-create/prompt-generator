# Product analytics

PromptGen uses a privacy-first, first-party event ledger. Browser events are sent to `/api/analytics/events`; server outcomes are written with the service role. No third-party analytics SDK or tracking cookie is required.

## Privacy contract

Never add these values to event properties:

- access or refresh tokens
- email, name, avatar URL, IP address, or raw user agent
- prompt, scenario, image/file data, filenames, or provider response text
- full URLs, query strings, fragments, or raw referrers
- Paddle transaction/customer identifiers

The browser stores a random session UUID and a short-lived OAuth intent marker in `sessionStorage`. The marker contains only the sign-in surface, provider, and start time; it expires after 30 minutes and is consumed on the first completion attempt. Both values end with the tab session and are not persistent cross-session identifiers. `Do Not Track: 1` disables browser event collection.

## Taxonomy

Client navigation and intent:

- `page_viewed`
- `signup_started`
- `auth_completed` — one successful completion for an explicit sign-in intent in the same tab, including returning users; existing-session confirmation events are ignored
- `analysis_started`
- `storyboard_started`
- `checkout_started`
- `checkout_completed`

Authoritative server outcomes:

- `signup_completed` — inserted by the new-profile database trigger only
- `analysis_succeeded`
- `storyboard_enqueued`
- `storyboard_completed`
- `storyboard_failed`
- `purchase_completed`

Do not use a client event as proof of credits, generation, or payment.

## Baseline before event deployment

The legacy domain tables provide this aggregate baseline as of 2026-07-13 13:10 UTC:

- profiles: 13
- users with a successful saved analysis: 9
- users with a Storyboard: 1
- users with a completed purchase: 1
- prompts: 19
- Storyboards: 14 total, 7 completed, 7 retention-cleaned
- purchases: 1 completed

The sample is too small for causal conclusions. Visits, CTA interactions, and auth starts were not historically recorded.

## Read-only reporting queries

Daily event volume:

```sql
select
  date_trunc('day', created_at) as day,
  event_name,
  count(*) as events,
  count(distinct session_id) filter (where session_id is not null) as sessions,
  count(distinct user_id) filter (where user_id is not null) as users
from public.product_events
where created_at >= now() - interval '30 days'
  and coalesce((properties ->> 'isTest')::boolean, false) is false
group by 1, 2
order by 1, 2;
```

Session acquisition funnel:

```sql
with session_stage as (
  select
    session_id,
    bool_or(event_name = 'page_viewed') as visited,
    bool_or(event_name = 'signup_started') as signup_started,
    bool_or(event_name = 'auth_completed') as auth_completed
  from public.product_events
  where source = 'client'
    and session_id is not null
    and created_at >= now() - interval '30 days'
    and coalesce((properties ->> 'isTest')::boolean, false) is false
  group by session_id
)
select
  count(*) filter (where visited) as visited_sessions,
  count(*) filter (where signup_started) as signup_started_sessions,
  count(*) filter (where auth_completed) as authenticated_sessions
from session_stage;
```

User value funnel for users who signed up after instrumentation:

```sql
with user_stage as (
  select
    user_id,
    min(created_at) filter (where event_name = 'signup_completed') as signup_at,
    min(created_at) filter (where event_name = 'analysis_succeeded') as analysis_at,
    min(created_at) filter (where event_name = 'storyboard_enqueued') as storyboard_at,
    min(created_at) filter (where event_name = 'storyboard_completed') as completed_at,
    min(created_at) filter (where event_name = 'purchase_completed') as purchase_at
  from public.product_events
  where source = 'server'
    and user_id is not null
    and coalesce((properties ->> 'isTest')::boolean, false) is false
  group by user_id
)
select
  count(*) filter (where signup_at is not null) as signed_up,
  count(*) filter (where analysis_at >= signup_at) as reached_analysis,
  count(*) filter (where storyboard_at >= signup_at) as reached_storyboard,
  count(*) filter (where completed_at >= signup_at) as completed_storyboard,
  count(*) filter (where purchase_at >= signup_at) as purchased
from user_stage
where signup_at is not null;
```

Quality guard:

```sql
select
  count(*) filter (where event_id is null) as missing_event_id,
  count(*) - count(distinct event_id) as duplicate_event_ids,
  count(*) filter (
    where page_path like '%?%' or page_path like '%#%'
  ) as unsafe_paths
from public.product_events;
```

## Retention

Supabase Cron runs `purge_product_events(180)` daily at 03:17 UTC. The function accepts 30–730 days and is executable only by the service role. Retention changes require a migration and privacy review.
