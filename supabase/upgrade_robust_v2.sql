-- Finanzas 360 Real · Upgrade robusto v2
-- Ejecuta este archivo UNA VEZ en Supabase > SQL Editor antes de usar la versión robusta.

create extension if not exists pgcrypto;

-- Vehículos más completos
alter table public.vehicles add column if not exists brand text;
alter table public.vehicles add column if not exists model text;
alter table public.vehicles add column if not exists year integer;
alter table public.vehicles add column if not exists km integer;
alter table public.vehicles add column if not exists status text not null default 'activo';
alter table public.vehicles add column if not exists notes text;

-- Historial robusto de vehículos: seguros, ITV, aceite, neumáticos, reparaciones, cuotas y avisos.
alter table public.vehicle_records add column if not exists concept text;
alter table public.vehicle_records add column if not exists status text not null default 'realizado';
alter table public.vehicle_records add column if not exists km integer;
alter table public.vehicle_records add column if not exists next_date date;
alter table public.vehicle_records add column if not exists next_km integer;
alter table public.vehicle_records add column if not exists provider text;
alter table public.vehicle_records add column if not exists insurance_company text;
alter table public.vehicle_records add column if not exists payment_mode text;
alter table public.vehicle_records add column if not exists coverage_end date;
alter table public.vehicle_records add column if not exists installment_day integer;
alter table public.vehicle_records add column if not exists responsible_user_id uuid references auth.users(id) on delete set null;

-- Recurrentes: nómina, alquiler, suscripciones, comida perro, préstamos, servicios, etc.
create table if not exists public.recurring_movements (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  member_id uuid references auth.users(id) on delete set null,
  type text not null check (type in ('income','expense')),
  category_id uuid references public.categories(id) on delete set null,
  amount numeric(12,2) not null default 0 check (amount >= 0),
  description text not null,
  frequency text not null default 'monthly',
  day_of_month integer default 1,
  is_shared boolean not null default false,
  active boolean not null default true,
  start_date date default current_date,
  end_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.recurring_movements enable row level security;

create or replace function public.default_permissions_for_role(p_role text)
returns table(module text, can_view boolean, can_create boolean, can_edit boolean, can_delete boolean)
language sql
stable
as $$
  select * from (values
    ('dashboard', true,  false, false, false),
    ('register',  p_role <> 'viewer', p_role <> 'viewer', false, false),
    ('movements', true,  p_role <> 'viewer', p_role <> 'viewer', false),
    ('recurring', true, p_role <> 'viewer', p_role <> 'viewer', false),
    ('household', true,  false, false, false),
    ('categories', true, p_role = 'member', p_role = 'member', false),
    ('goals', true, p_role <> 'viewer', p_role <> 'viewer', p_role <> 'viewer'),
    ('vehicles', true, p_role <> 'viewer', p_role <> 'viewer', false),
    ('reports', p_role <> 'viewer', false, false, false),
    ('history', true, false, false, false),
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
      ('dashboard'),('register'),('movements'),('recurring'),('household'),('categories'),('goals'),('vehicles'),('reports'),('history'),('backup'),('admin')
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

-- Agrega permisos faltantes a usuarios ya creados.
insert into public.permissions(household_id, user_id, module, can_view, can_create, can_edit, can_delete)
select hm.household_id, hm.user_id, d.module, d.can_view, d.can_create, d.can_edit, d.can_delete
from public.household_members hm
cross join lateral public.default_permissions_for_role(hm.role) d
on conflict (household_id, user_id, module) do nothing;

-- Admins existentes: todos los permisos nuevos también quedan abiertos.
update public.permissions p
set can_view = true, can_create = true, can_edit = true, can_delete = true, updated_at = now()
from public.household_members hm
where hm.household_id = p.household_id
  and hm.user_id = p.user_id
  and hm.role = 'admin'
  and p.module in ('recurring','history','vehicles','reports');

-- Trigger updated_at para recurrentes.
drop trigger if exists touch_recurring_updated on public.recurring_movements;
create trigger touch_recurring_updated before update on public.recurring_movements for each row execute function public.touch_updated_at();

-- Políticas recurrentes, recreadas de forma segura.
drop policy if exists "recurring_select_by_role" on public.recurring_movements;
drop policy if exists "recurring_insert_permission" on public.recurring_movements;
drop policy if exists "recurring_update_permission" on public.recurring_movements;
drop policy if exists "recurring_delete_permission" on public.recurring_movements;

create policy "recurring_select_by_role" on public.recurring_movements
for select using (
  public.is_household_admin(household_id)
  or user_id = auth.uid()
  or member_id = auth.uid()
  or (is_shared = true and public.is_household_member(household_id))
  or public.has_household_permission(household_id, 'recurring', 'view')
);
create policy "recurring_insert_permission" on public.recurring_movements
for insert with check (user_id = auth.uid() and public.has_household_permission(household_id, 'recurring', 'create'));
create policy "recurring_update_permission" on public.recurring_movements
for update using (public.is_household_admin(household_id) or (user_id = auth.uid() and public.has_household_permission(household_id, 'recurring', 'edit')))
with check (public.is_household_admin(household_id) or (user_id = auth.uid() and public.has_household_permission(household_id, 'recurring', 'edit')));
create policy "recurring_delete_permission" on public.recurring_movements
for delete using (public.is_household_admin(household_id) or (user_id = auth.uid() and public.has_household_permission(household_id, 'recurring', 'delete')));

create index if not exists idx_vehicle_records_vehicle_date on public.vehicle_records(vehicle_id, date desc);
create index if not exists idx_vehicle_records_next_date on public.vehicle_records(next_date);
create index if not exists idx_recurring_household on public.recurring_movements(household_id);
