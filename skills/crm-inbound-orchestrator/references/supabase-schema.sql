-- CRM Inbound orchestrator schema (idempotent, replay-safe)
-- Apply in Supabase SQL editor before first run.

create extension if not exists pgcrypto;

create table if not exists crm_contacts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text,
  source_account_email text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm_activities (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  account_email text not null,
  message_id text not null,
  thread_id text,
  from_raw text,
  from_email text,
  from_name text,
  subject text,
  snippet text,
  received_at timestamptz,
  classification text not null,
  classification_confidence numeric(5,4),
  classification_reasons jsonb not null default '[]'::jsonb,
  contact_id uuid references crm_contacts(id),
  contact_email text,
  sop_hash text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_email, message_id)
);

create table if not exists crm_drafts (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null unique references crm_activities(id) on delete cascade,
  account_email text not null,
  to_email text not null,
  subject text not null,
  body text not null,
  status text not null default 'draft',
  approval_commands text,
  slack_summary text,
  reply_to_message_id text,
  sop_hash text,
  revision_notes text,
  rejected_reason text,
  approved_by text,
  approved_at timestamptz,
  rejected_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists accounting_entries (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  activity_id uuid references crm_activities(id) on delete set null,
  account_email text not null,
  vendor text,
  amount numeric(14,2),
  currency text,
  receipt_date timestamptz,
  subject text,
  snippet text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm_job_runs (
  id uuid primary key,
  started_at timestamptz not null,
  finished_at timestamptz,
  status text not null,
  degraded boolean not null default false,
  poll_partial_failure boolean not null default false,
  metrics jsonb not null default '{}'::jsonb,
  accounts jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists crm_poll_state (
  account_email text primary key,
  last_polled_at timestamptz,
  last_message_ts timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists idx_crm_activities_account_received
  on crm_activities (account_email, received_at desc);

create index if not exists idx_crm_activities_classification
  on crm_activities (classification);

create index if not exists idx_crm_drafts_status
  on crm_drafts (status, updated_at desc);

create index if not exists idx_accounting_entries_receipt_date
  on accounting_entries (receipt_date desc);
