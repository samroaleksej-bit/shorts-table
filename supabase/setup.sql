-- Таблица шортсов. Выполнить один раз: Supabase -> SQL Editor -> вставить -> Run.

create table if not exists public.shorts (
  id               uuid primary key default gen_random_uuid(),
  author           text    not null default '',
  file             text    not null default '',
  title            text    not null default '',
  descr            text    not null default '',
  added            date,
  release          date,
  preview_ready    boolean not null default false,
  preview_embedded boolean not null default false,
  note             text    not null default '',
  ord              bigint  not null default 0,
  disk_path        text unique,              -- откуда строка пришла с Яндекс Диска
  deleted          boolean not null default false,
  updated_at       timestamptz not null default now()
);

create or replace function public.shorts_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists shorts_touch on public.shorts;
create trigger shorts_touch before update on public.shorts
  for each row execute function public.shorts_touch();

-- Доступ только после входа общим пользователем команды. Без пароля таблицу не видно.
alter table public.shorts enable row level security;

-- В новых проектах Supabase права на таблицу сами не выдаются.
-- Гостю (anon) не даём ничего, вошедшей команде - читать, добавлять и править.
grant select, insert, update on public.shorts to authenticated;
grant all on public.shorts to service_role;

drop policy if exists "team full access" on public.shorts;
create policy "team full access" on public.shorts
  for all to authenticated using (true) with check (true);

-- Настройки: ссылки на публичные папки Яндекс Диска для кнопки «Синхронизировать с диском».
-- Лежат в базе, а не в коде, чтобы ссылку на диск не было видно в публичном репозитории.
create table if not exists public.settings (
  key   text primary key,
  value text not null default ''
);
alter table public.settings enable row level security;
drop policy if exists "team reads settings" on public.settings;
create policy "team reads settings" on public.settings
  for select to authenticated using (true);
grant select on public.settings to authenticated;
grant all on public.settings to service_role;

-- Ссылки, по одной в строке. Автора можно указать явно: "https://disk.yandex.ru/d/xxxx = Лера"
-- insert into public.settings (key, value) values ('yadisk_sources', 'https://disk.yandex.ru/d/xxxx')
--   on conflict (key) do update set value = excluded.value;
