-- Social HQ storage on Supabase: a key/value table, helper functions, a private media bucket.
create table if not exists public.kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.kv enable row level security;
revoke all on table public.kv from anon, authenticated;
grant all on table public.kv to service_role;

create or replace function public.kv_get(k text) returns jsonb language sql stable as $$
  select value from public.kv where key = k
$$;
create or replace function public.kv_get_many(ks text[]) returns setof public.kv language sql stable as $$
  select * from public.kv where key = any(ks)
$$;
create or replace function public.kv_set(k text, v jsonb) returns void language sql as $$
  insert into public.kv(key, value, updated_at) values (k, v, now())
  on conflict (key) do update set value = excluded.value, updated_at = now()
$$;
create or replace function public.kv_set_new(k text, v jsonb) returns boolean language plpgsql as $$
begin
  insert into public.kv(key, value) values (k, v);
  return true;
exception when unique_violation then
  return false;
end
$$;
create or replace function public.kv_set_many(items jsonb) returns integer language plpgsql as $$
declare n integer;
begin
  insert into public.kv(key, value, updated_at)
  select e->>'k', e->'v', now() from jsonb_array_elements(items) e
  on conflict (key) do update set value = excluded.value, updated_at = now();
  get diagnostics n = row_count;
  return n;
end
$$;
create or replace function public.kv_del(k text) returns void language sql as $$
  delete from public.kv where key = k
$$;
create or replace function public.kv_list(p text) returns setof text language sql stable as $$
  select key from public.kv where starts_with(key, p) order by key
$$;

revoke execute on function public.kv_get(text), public.kv_get_many(text[]), public.kv_set(text, jsonb), public.kv_set_new(text, jsonb), public.kv_set_many(jsonb), public.kv_del(text), public.kv_list(text) from public, anon, authenticated;
grant execute on function public.kv_get(text), public.kv_get_many(text[]), public.kv_set(text, jsonb), public.kv_set_new(text, jsonb), public.kv_set_many(jsonb), public.kv_del(text), public.kv_list(text) to service_role;

insert into storage.buckets (id, name, public) values ('media', 'media', false) on conflict (id) do nothing;

create extension if not exists pg_cron;
create extension if not exists pg_net;

select 'Social HQ storage ready' as status;
