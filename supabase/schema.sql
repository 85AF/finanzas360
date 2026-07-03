-- Finanzas 360 Real · Supabase schema
-- Ejecuta TODO este archivo en Supabase > SQL Editor.
-- Después configura Auth > Providers > Email y crea tu primer usuario desde la app.

create extension if not exists pgcrypto;

-- Limpieza opcional para reinstalar en un proyecto vacío.
-- Descomenta bajo tu responsabilidad si necesitas reiniciar todo.
-- drop table if exists public.audit_logs cascade;
-- drop table if exists public.vehicle_records cascade;
-- drop table if exists public.vehicles cascade;
-- drop table if exists public.goals cascade;
-- drop table if exists public.movements cascade;
-- drop table if exists public.categories cascade;
-- drop table if exists public.invitations cascade;
-- drop table if exists public.permissions cascade;
-- drop table if exists public.household_members cascade;
-- drop table if exists public.households cascade;
-- drop table if exists public.profiles cascade;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.household_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('admin','member','viewer')),
  status text not null default 'active' check (status in ('active','disabled')),
  created_at timestamptz not null default now(),
  unique(household_id, user_id)
);

create table if not exists public.permissions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  module text not null,
  can_view boolean not null default false,
  can_create boolean not null default false,
  can_edit boolean not null default false,
  can_delete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(household_id, user_id, module)
);

create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  invited_email text not null,
  full_name text,
  role text not null default 'member' check (role in ('admin','member','viewer')),
  status text not null default 'pending' check (status in ('pending','accepted','cancelled')),
  invited_by uuid references auth.users(id),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique(household_id, invited_email)
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  type text not null default 'expense' check (type in ('income','expense','both')),
  color text default '#2563eb',
  created_at timestamptz not null default now(),
  unique(household_id, name, type)
);

create table if not exists public.movements (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  member_id uuid references auth.users(id) on delete set null,
  type text not null check (type in ('income','expense')),
  category_id uuid references public.categories(id) on delete set null,
  amount numeric(12,2) not null check (amount >= 0),
  date date not null,
  description text,
  is_shared boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  target_amount numeric(12,2) not null check (target_amount >= 0),
  current_amount numeric(12,2) not null default 0 check (current_amount >= 0),
  deadline date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  owner_id uuid references auth.users(id) on delete set null,
  name text not null,
  plate text,
  type text default 'car',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vehicle_records (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null default 'maintenance',
  amount numeric(12,2) default 0,
  date date not null default current_date,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid references public.households(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  table_name text,
  record_id uuid,
  payload jsonb,
  created_at timestamptz not null default now()
);

-- Funciones de autorización. SECURITY DEFINER evita bucles con RLS.
create or replace function public.auth_email()
returns text
language sql
stable
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

create or replace function public.is_household_member(p_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id
      and hm.user_id = auth.uid()
      and hm.status = 'active'
  )
$$;

create or replace function public.is_household_admin(p_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.household_members hm
    where hm.household_id = p_household_id
      and hm.user_id = auth.uid()
      and hm.status = 'active'
      and hm.role = 'admin'
  ) or exists (
    select 1 from public.households h
    where h.id = p_household_id
      and h.owner_id = auth.uid()
  )
$$;

create or replace function public.has_household_permission(p_household_id uuid, p_module text, p_action text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_household_admin(p_household_id)
  or exists (
    select 1 from public.permissions p
    where p.household_id = p_household_id
      and p.user_id = auth.uid()
      and p.module = p_module
      and case p_action
        when 'view' then p.can_view
        when 'create' then p.can_create
        when 'edit' then p.can_edit
        when 'delete' then p.can_delete
        else false
      end = true
  )
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles(user_id, email, full_name)
  values (
    new.id,
    lower(new.email),
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1))
  )
  on conflict (user_id) do update
  set email = excluded.email,
      full_name = coalesce(public.profiles.full_name, excluded.full_name),
      updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.default_permissions_for_role(p_role text)
returns table(module text, can_view boolean, can_create boolean, can_edit boolean, can_delete boolean)
language sql
stable
as $$
  select * from (values
    ('dashboard', true,  false, false, false),
    ('register',  p_role <> 'viewer', p_role <> 'viewer', false, false),
    ('movements', true,  p_role <> 'viewer', p_role <> 'viewer', false),
    ('household', true,  false, false, false),
    ('categories', true, p_role = 'member', p_role = 'member', false),
    ('goals', true, p_role <> 'viewer', p_role <> 'viewer', p_role <> 'viewer'),
    ('vehicles', false, false, false, false),
    ('reports', false, false, false, false),
    ('backup', true, false, false, false),
    ('admin', false, false, false, false)
  ) as x(module, can_view, can_create, can_edit, can_delete)
$$;

create or replace function public.ensure_member_permissions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role = 'admin' then
    insert into public.permissions(household_id, user_id, module, can_view, can_create, can_edit, can_delete)
    select new.household_id, new.user_id, module, true, true, true, true
    from (values
      ('dashboard'),('register'),('movements'),('household'),('categories'),('goals'),('vehicles'),('reports'),('backup'),('admin')
    ) as modules(module)
    on conflict (household_id, user_id, module) do update set
      can_view = true, can_create = true, can_edit = true, can_delete = true, updated_at = now();
  else
    insert into public.permissions(household_id, user_id, module, can_view, can_create, can_edit, can_delete)
    select new.household_id, new.user_id, module, can_view, can_create, can_edit, can_delete
    from public.default_permissions_for_role(new.role)
    on conflict (household_id, user_id, module) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists on_household_member_created on public.household_members;
create trigger on_household_member_created
  after insert on public.household_members
  for each row execute function public.ensure_member_permissions();

create or replace function public.handle_new_household()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.household_members(household_id, user_id, role, status)
  values (new.id, new.owner_id, 'admin', 'active')
  on conflict (household_id, user_id) do nothing;

  insert into public.categories(household_id, name, type, color) values
    (new.id, 'Nómina', 'income', '#059669'),
    (new.id, 'Extra', 'income', '#10b981'),
    (new.id, 'Alquiler', 'expense', '#dc2626'),
    (new.id, 'Comida', 'expense', '#d97706'),
    (new.id, 'Gasolina', 'expense', '#7c3aed'),
    (new.id, 'Servicios', 'expense', '#2563eb'),
    (new.id, 'Mascota', 'expense', '#f97316'),
    (new.id, 'Vehículos', 'expense', '#111827'),
    (new.id, 'Otros', 'both', '#667085')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_household_created on public.households;
create trigger on_household_created
  after insert on public.households
  for each row execute function public.handle_new_household();

create trigger touch_profiles_updated before update on public.profiles for each row execute function public.touch_updated_at();
create trigger touch_households_updated before update on public.households for each row execute function public.touch_updated_at();
create trigger touch_permissions_updated before update on public.permissions for each row execute function public.touch_updated_at();
create trigger touch_movements_updated before update on public.movements for each row execute function public.touch_updated_at();
create trigger touch_goals_updated before update on public.goals for each row execute function public.touch_updated_at();
create trigger touch_vehicles_updated before update on public.vehicles for each row execute function public.touch_updated_at();

-- Activar RLS en todas las tablas de datos.
alter table public.profiles enable row level security;
alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.permissions enable row level security;
alter table public.invitations enable row level security;
alter table public.categories enable row level security;
alter table public.movements enable row level security;
alter table public.goals enable row level security;
alter table public.vehicles enable row level security;
alter table public.vehicle_records enable row level security;
alter table public.audit_logs enable row level security;

-- Políticas: profiles
create policy "profiles_select_own_or_same_household" on public.profiles
for select using (
  user_id = auth.uid()
  or exists (
    select 1 from public.household_members mine
    join public.household_members other on other.household_id = mine.household_id
    where mine.user_id = auth.uid() and mine.status = 'active' and other.user_id = profiles.user_id
  )
);
create policy "profiles_insert_own" on public.profiles for insert with check (user_id = auth.uid());
create policy "profiles_update_own" on public.profiles for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Políticas: households
create policy "households_select_members" on public.households
for select using (public.is_household_member(id) or owner_id = auth.uid());
create policy "households_insert_owner" on public.households
for insert with check (owner_id = auth.uid());
create policy "households_update_admin" on public.households
for update using (public.is_household_admin(id)) with check (public.is_household_admin(id));
create policy "households_delete_owner" on public.households
for delete using (owner_id = auth.uid());

-- Políticas: household_members
create policy "members_select_same_household" on public.household_members
for select using (public.is_household_member(household_id));
create policy "members_insert_admin_or_invited_self" on public.household_members
for insert with check (
  public.is_household_admin(household_id)
  or (
    user_id = auth.uid()
    and exists (
      select 1 from public.invitations inv
      where inv.household_id = household_members.household_id
        and lower(inv.invited_email) = public.auth_email()
        and inv.status = 'pending'
    )
  )
);
create policy "members_update_admin" on public.household_members
for update using (public.is_household_admin(household_id)) with check (public.is_household_admin(household_id));
create policy "members_delete_admin" on public.household_members
for delete using (public.is_household_admin(household_id));

-- Políticas: permissions
create policy "permissions_select_member" on public.permissions
for select using (public.is_household_member(household_id));
create policy "permissions_admin_all" on public.permissions
for all using (public.is_household_admin(household_id)) with check (public.is_household_admin(household_id));

-- Políticas: invitations
create policy "invitations_select_admin_or_invited" on public.invitations
for select using (public.is_household_admin(household_id) or lower(invited_email) = public.auth_email());
create policy "invitations_insert_admin" on public.invitations
for insert with check (public.is_household_admin(household_id));
create policy "invitations_update_admin_or_invited" on public.invitations
for update using (public.is_household_admin(household_id) or lower(invited_email) = public.auth_email())
with check (public.is_household_admin(household_id) or lower(invited_email) = public.auth_email());
create policy "invitations_delete_admin" on public.invitations
for delete using (public.is_household_admin(household_id));

-- Políticas: categories
create policy "categories_select_member" on public.categories
for select using (public.is_household_member(household_id));
create policy "categories_insert_permission" on public.categories
for insert with check (public.has_household_permission(household_id, 'categories', 'create'));
create policy "categories_update_permission" on public.categories
for update using (public.has_household_permission(household_id, 'categories', 'edit')) with check (public.has_household_permission(household_id, 'categories', 'edit'));
create policy "categories_delete_permission" on public.categories
for delete using (public.has_household_permission(household_id, 'categories', 'delete'));

-- Políticas: movements
create policy "movements_select_by_role" on public.movements
for select using (
  public.is_household_admin(household_id)
  or user_id = auth.uid()
  or member_id = auth.uid()
  or (is_shared = true and public.is_household_member(household_id))
  or public.has_household_permission(household_id, 'reports', 'view')
);
create policy "movements_insert_permission" on public.movements
for insert with check (
  user_id = auth.uid()
  and public.is_household_member(household_id)
  and (
    public.has_household_permission(household_id, 'movements', 'create')
    or public.has_household_permission(household_id, 'register', 'create')
  )
);
create policy "movements_update_permission" on public.movements
for update using (
  public.is_household_admin(household_id)
  or (user_id = auth.uid() and public.has_household_permission(household_id, 'movements', 'edit'))
)
with check (
  public.is_household_admin(household_id)
  or (user_id = auth.uid() and public.has_household_permission(household_id, 'movements', 'edit'))
);
create policy "movements_delete_permission" on public.movements
for delete using (
  public.is_household_admin(household_id)
  or (user_id = auth.uid() and public.has_household_permission(household_id, 'movements', 'delete'))
);

-- Políticas: goals
create policy "goals_select_owner_or_admin" on public.goals
for select using (public.is_household_admin(household_id) or user_id = auth.uid());
create policy "goals_insert_permission" on public.goals
for insert with check (user_id = auth.uid() and public.has_household_permission(household_id, 'goals', 'create'));
create policy "goals_update_owner_or_admin" on public.goals
for update using (public.is_household_admin(household_id) or user_id = auth.uid())
with check (public.is_household_admin(household_id) or user_id = auth.uid());
create policy "goals_delete_owner_or_admin" on public.goals
for delete using (public.is_household_admin(household_id) or user_id = auth.uid());

-- Políticas: vehicles
create policy "vehicles_select_permission" on public.vehicles
for select using (public.is_household_admin(household_id) or public.has_household_permission(household_id, 'vehicles', 'view'));
create policy "vehicles_insert_permission" on public.vehicles
for insert with check (owner_id = auth.uid() and public.has_household_permission(household_id, 'vehicles', 'create'));
create policy "vehicles_update_permission" on public.vehicles
for update using (public.is_household_admin(household_id) or (owner_id = auth.uid() and public.has_household_permission(household_id, 'vehicles', 'edit')))
with check (public.is_household_admin(household_id) or (owner_id = auth.uid() and public.has_household_permission(household_id, 'vehicles', 'edit')));
create policy "vehicles_delete_permission" on public.vehicles
for delete using (public.is_household_admin(household_id) or (owner_id = auth.uid() and public.has_household_permission(household_id, 'vehicles', 'delete')));

-- Políticas: vehicle_records
create policy "vehicle_records_select_permission" on public.vehicle_records
for select using (public.is_household_admin(household_id) or public.has_household_permission(household_id, 'vehicles', 'view'));
create policy "vehicle_records_insert_permission" on public.vehicle_records
for insert with check (user_id = auth.uid() and public.has_household_permission(household_id, 'vehicles', 'create'));
create policy "vehicle_records_update_admin" on public.vehicle_records
for update using (public.is_household_admin(household_id)) with check (public.is_household_admin(household_id));
create policy "vehicle_records_delete_admin" on public.vehicle_records
for delete using (public.is_household_admin(household_id));

-- Políticas: audit_logs
create policy "audit_select_admin" on public.audit_logs
for select using (household_id is null or public.is_household_admin(household_id));
create policy "audit_insert_member" on public.audit_logs
for insert with check (household_id is null or public.is_household_member(household_id));

-- Índices útiles
create index if not exists idx_household_members_household on public.household_members(household_id);
create index if not exists idx_household_members_user on public.household_members(user_id);
create index if not exists idx_permissions_household_user on public.permissions(household_id, user_id);
create index if not exists idx_movements_household_date on public.movements(household_id, date desc);
create index if not exists idx_movements_user on public.movements(user_id);
create index if not exists idx_movements_member on public.movements(member_id);
create index if not exists idx_invitations_email on public.invitations(lower(invited_email));
