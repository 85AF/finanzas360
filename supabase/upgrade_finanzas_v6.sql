-- Finanzas 360 · Upgrade V6
-- Ejecutar en Supabase > SQL Editor.
-- Objetivo: soportar todo lo adicional integrado desde el index.html antiguo
-- sin romper la estética ni la app existente.

-- Categorías con presupuesto mensual
alter table public.categories add column if not exists budget numeric(12,2) default 0;

-- Movimientos enriquecidos: notas, tipo interno, reparto y detalle manual
alter table public.movements add column if not exists notes text;
alter table public.movements add column if not exists kind text default 'personal';
alter table public.movements add column if not exists share_method text default 'none';
alter table public.movements add column if not exists share_details jsonb default '{}'::jsonb;

-- Miembros del hogar: datos para aportes avanzados
alter table public.household_members add column if not exists display_name text;
alter table public.household_members add column if not exists household_type text default 'family';
alter table public.household_members add column if not exists participation_percent numeric(7,2);
alter table public.household_members add column if not exists works boolean default true;
alter table public.household_members add column if not exists contributes_income boolean default true;
alter table public.household_members add column if not exists dependent boolean default false;

-- Metas mejoradas
alter table public.goals add column if not exists emoji text default '🎯';
alter table public.goals add column if not exists notes text;

-- Recurrentes / servicios variables / deudas
create table if not exists public.recurring_movements (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  member_id uuid references auth.users(id) on delete set null,
  type text not null default 'expense' check (type in ('income','expense')),
  category_id uuid references public.categories(id) on delete set null,
  amount numeric(12,2) not null default 0,
  description text,
  day_of_month integer default 1,
  frequency text default 'monthly',
  active boolean default true,
  is_shared boolean default false,
  start_date date default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.recurring_movements add column if not exists kind text default 'fixed';
alter table public.recurring_movements add column if not exists amount_mode text default 'fixed';
alter table public.recurring_movements add column if not exists end_mode text default 'indefinite';
alter table public.recurring_movements add column if not exists fixed_months integer;
alter table public.recurring_movements add column if not exists fixed_years integer;
alter table public.recurring_movements add column if not exists end_date date;
alter table public.recurring_movements add column if not exists debt_original_amount numeric(12,2);
alter table public.recurring_movements add column if not exists debt_lender text;
alter table public.recurring_movements add column if not exists first_payment_date date;
alter table public.recurring_movements add column if not exists last_payment_date date;
alter table public.recurring_movements add column if not exists notes text;
alter table public.recurring_movements add column if not exists share_method text default 'equal';
alter table public.recurring_movements add column if not exists share_details jsonb default '{}'::jsonb;

-- Vehículos completos
alter table public.vehicles add column if not exists brand text;
alter table public.vehicles add column if not exists model text;
alter table public.vehicles add column if not exists year integer;
alter table public.vehicles add column if not exists km integer;
alter table public.vehicles add column if not exists status text default 'activo';
alter table public.vehicles add column if not exists notes text;

-- Historial vehículo / seguros financiados / avisos
alter table public.vehicle_records add column if not exists concept text;
alter table public.vehicle_records add column if not exists status text default 'realizado';
alter table public.vehicle_records add column if not exists km integer;
alter table public.vehicle_records add column if not exists next_date date;
alter table public.vehicle_records add column if not exists next_km integer;
alter table public.vehicle_records add column if not exists provider text;
alter table public.vehicle_records add column if not exists insurance_company text;
alter table public.vehicle_records add column if not exists payment_mode text default 'cash';
alter table public.vehicle_records add column if not exists coverage_end date;
alter table public.vehicle_records add column if not exists installment_day integer;
alter table public.vehicle_records add column if not exists installment_count integer;
alter table public.vehicle_records add column if not exists installment_amount numeric(12,2);
alter table public.vehicle_records add column if not exists installments_json jsonb default '[]'::jsonb;
alter table public.vehicle_records add column if not exists responsible_user_id uuid references auth.users(id) on delete set null;

-- Permisos para módulos nuevos/extendidos
insert into public.permissions (household_id, user_id, module, can_view, can_create, can_edit, can_delete)
select hm.household_id, hm.user_id, m.module,
       true,
       case when hm.role <> 'viewer' then true else false end,
       case when hm.role <> 'viewer' then true else false end,
       case when hm.role = 'admin' then true else false end
from public.household_members hm
cross join (values
  ('dashboard'),('register'),('movements'),('recurring'),('household'),('categories'),('goals'),('vehicles'),('reports'),('history'),('backup'),('admin')
) as m(module)
on conflict (household_id, user_id, module) do nothing;

-- RLS e índices para recurrentes si el proyecto no los tenía todavía
alter table public.recurring_movements enable row level security;

drop trigger if exists touch_recurring_updated on public.recurring_movements;
create trigger touch_recurring_updated before update on public.recurring_movements for each row execute function public.touch_updated_at();

create index if not exists idx_recurring_household on public.recurring_movements(household_id);
create index if not exists idx_recurring_member on public.recurring_movements(member_id);
create index if not exists idx_movements_household_month on public.movements(household_id, date);
create index if not exists idx_vehicle_records_household_date on public.vehicle_records(household_id, date);

drop policy if exists "recurring_select_by_role" on public.recurring_movements;
drop policy if exists "recurring_insert_permission" on public.recurring_movements;
drop policy if exists "recurring_update_permission" on public.recurring_movements;
drop policy if exists "recurring_delete_permission" on public.recurring_movements;

create policy "recurring_select_by_role" on public.recurring_movements
for select using (
  public.is_household_member(household_id)
  and (
    public.is_household_admin(household_id)
    or user_id = auth.uid()
    or member_id = auth.uid()
    or public.has_household_permission(household_id, 'recurring', 'view')
  )
);

create policy "recurring_insert_permission" on public.recurring_movements
for insert with check (
  user_id = auth.uid()
  and public.has_household_permission(household_id, 'recurring', 'create')
);

create policy "recurring_update_permission" on public.recurring_movements
for update using (
  public.is_household_admin(household_id)
  or (user_id = auth.uid() and public.has_household_permission(household_id, 'recurring', 'edit'))
) with check (
  public.is_household_admin(household_id)
  or (user_id = auth.uid() and public.has_household_permission(household_id, 'recurring', 'edit'))
);

create policy "recurring_delete_permission" on public.recurring_movements
for delete using (
  public.is_household_admin(household_id)
  or (user_id = auth.uid() and public.has_household_permission(household_id, 'recurring', 'delete'))
);
