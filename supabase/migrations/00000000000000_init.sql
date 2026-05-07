-- ═══════════════════════════════════════════════════════════════
-- noma · consolidated schema
-- ═══════════════════════════════════════════════════════════════
--
-- Single-file schema for the noma ambient-runtime Postgres database.
-- Replaces all prior incremental migrations.
--
-- Design choices:
--   * Server authenticates via service-role key, so NO RLS policies
--     and NO auth.users foreign keys. user_id is a plain uuid.
--   * gen_random_uuid() for all primary keys (pgcrypto).
--   * timestamptz everywhere (no integer epochs).
--   * jsonb for structured blobs; text[] for tag arrays.
--
-- Tables (10):
--   session_memory    – chat history stream
--   entity_memory     – observations attached to thematic entities
--   entities          – thematic buckets for observations
--   events            – signals from connectors / system
--   notifications     – agent-decided interruptions
--   connector_configs – per-user config for built-in connectors
--   connector_storage – per-connector persistent key-value store
--   channel_configs   – outbound IM channels (lark/slack/telegram)
--   user_settings     – misc user-level toggles
--   beta_signups      – early-access waitlist
-- ═══════════════════════════════════════════════════════════════

-- pgcrypto provides gen_random_uuid() and gen_random_bytes().
-- Supabase enables it by default, but declare the requirement so
-- running this on a bare Postgres instance works too.
create extension if not exists pgcrypto;


-- ─────────────────────────────────────────────────────────────
-- session_memory · chat history stream
-- ─────────────────────────────────────────────────────────────
-- Every user/assistant/system/event turn lives here.
-- Both the web chat and IM channels read from the same rows.
-- The `meta` bag holds tool-call records, event ids, etc.

create table public.session_memory (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null,
  role       text        not null check (role in ('user','assistant','system','event')),
  content    text        not null,
  meta       jsonb,
  created_at timestamptz not null default now()
);

create index session_memory_user_created_idx
  on public.session_memory (user_id, created_at desc);


-- ─────────────────────────────────────────────────────────────
-- entities · thematic buckets for observations
-- ─────────────────────────────────────────────────────────────

create table public.entities (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null,
  slug        text        not null,
  label       text        not null,
  description text,
  created_at  timestamptz not null default now(),
  unique (user_id, slug)
);


-- ─────────────────────────────────────────────────────────────
-- events · signals connectors push to the agent
-- ─────────────────────────────────────────────────────────────

create table public.events (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null,
  source      text        not null,   -- 'stock'|'github'|'lark'|'jin10'|'task'|'user'|'system'…
  type        text        not null,   -- 'price_move'|'on_pr_opened'|…
  payload     jsonb,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

create index events_user_created_idx
  on public.events (user_id, created_at desc);

-- Fast scan for the "unprocessed events" sweep the agent runs periodically.
create index events_user_unconsumed_idx
  on public.events (user_id, created_at)
  where consumed_at is null;


-- ─────────────────────────────────────────────────────────────
-- entity_memory · observations attached to entities
-- ─────────────────────────────────────────────────────────────
-- Declared after entities and events so foreign keys resolve.

create table public.entity_memory (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null,
  entity_id       uuid        not null references public.entities(id) on delete cascade,
  content         text        not null,
  source_event_id uuid        references public.events(id) on delete set null,
  tags            text[]      not null default '{}',
  created_at      timestamptz not null default now()
);

create index entity_memory_entity_idx
  on public.entity_memory (entity_id, created_at desc);

create index entity_memory_source_idx
  on public.entity_memory (source_event_id);


-- ─────────────────────────────────────────────────────────────
-- notifications · agent-decided interruptions
-- ─────────────────────────────────────────────────────────────

create table public.notifications (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null,
  level      text        not null check (level in ('info','nudge','alert')),
  message    text        not null,
  meta       jsonb,
  read       boolean     not null default false,
  created_at timestamptz not null default now()
);

create index notifications_user_unread_idx
  on public.notifications (user_id, created_at desc)
  where read = false;


-- ─────────────────────────────────────────────────────────────
-- connector_configs · per-user config for built-in connectors
-- ─────────────────────────────────────────────────────────────
-- The connector descriptor (configSchema, tools) lives in code
-- under src/connectors/<name>.ts — only the user's filled values
-- are persisted here.

create table public.connector_configs (
  user_id        uuid        not null,
  connector_name text        not null,
  enabled        boolean     not null default false,
  config         jsonb       not null default '{}'::jsonb,
  status         jsonb       not null default '{}'::jsonb,
  updated_at     timestamptz not null default now(),
  primary key (user_id, connector_name)
);


-- ─────────────────────────────────────────────────────────────
-- connector_storage · per-connector persistent key-value store
-- ─────────────────────────────────────────────────────────────
-- Official connectors store tokens, cursors, and opaque state
-- here. Keyed by (user_id, connector_name, key).

create table public.connector_storage (
  user_id        uuid        not null,
  connector_name text        not null,
  key            text        not null,
  value          text        not null,
  updated_at     timestamptz not null default now(),
  primary key (user_id, connector_name, key)
);


-- ─────────────────────────────────────────────────────────────
-- channel_configs · outbound IM channels
-- ─────────────────────────────────────────────────────────────
-- Each row configures one outbound channel (lark/slack/telegram)
-- for a user. webhook_slug is a random opaque path segment so
-- inbound webhooks can route back to the right user.

create table public.channel_configs (
  user_id      uuid        not null,
  channel_name text        not null,   -- 'lark'|'slack'|'telegram'
  enabled      boolean     not null default false,
  config       jsonb       not null default '{}'::jsonb,
  status       jsonb       not null default '{}'::jsonb,
  webhook_slug text        unique default encode(gen_random_bytes(12), 'hex'),
  updated_at   timestamptz not null default now(),
  primary key (user_id, channel_name)
);

create index channel_configs_webhook_slug_idx
  on public.channel_configs (webhook_slug);


-- ─────────────────────────────────────────────────────────────
-- user_settings · misc user-level toggles
-- ─────────────────────────────────────────────────────────────

create table public.user_settings (
  user_id    uuid        not null,
  key        text        not null,
  value      jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);


-- ─────────────────────────────────────────────────────────────
-- beta_signups · early-access waitlist
-- ─────────────────────────────────────────────────────────────

create table public.beta_signups (
  id         uuid        primary key default gen_random_uuid(),
  email      text        not null,
  source     text        not null default 'web',
  created_at timestamptz not null default now()
);

create unique index beta_signups_email_uniq
  on public.beta_signups (email);
