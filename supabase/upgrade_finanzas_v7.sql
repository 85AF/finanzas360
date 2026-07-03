-- Finanzas 360 Real · Upgrade v7
-- Integra las capacidades adicionales del index.html completo en la app con Supabase.
-- Ejecuta este archivo UNA VEZ en Supabase > SQL Editor después de los upgrades anteriores.

create extension if not exists pgcrypto;

-- Miembros: datos avanzados del hogar, aportes, nómina/referencia y dependientes.
alter table public.household_members add column if not exists display_name text;
alter table public.household_members add column if not exists household_type text default 'family';
alter table public.household_members add column if not exists participation_percent numeric(6,2);
alter table public.household_members add column if not exists works boolean default true;
alter table public.household_members add column if not exists contributes_income boolean default true;
alter table public.household_members add column if not exists dependent boolean default false;
alter table public.household_members add column if not exists monthly_income numeric(12,2);
alter table public.household_members add column if not exists pay_day integer;
alter table public.household_members add column if not exists income_category_id uuid references public.categories(id) on delete set null;
alter table public.household_members add column if not exists auto_income boolean default false;

alter table public.household_members drop constraint if exists household_members_status_check;
alter table public.household_members
  add constraint household_members_status_check check (status in ('active','disabled'));

-- Categorías: presupuesto mensual.
alter table public.categories add column if not exists budget numeric(12,2) default 0;

-- Movimientos: notas, tipo lógico y método de reparto.
alter table public.movements add column if not exists notes text;
alter table public.movements add column if not exists kind text default 'personal';
alter table public.movements add column if not exists share_method text default 'equal';
alter table public.movements add column if not exists updated_at timestamptz not null default now();

-- Recurrentes, deudas y servicios variables.
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
  active boolean not null default true,
  is_shared boolean not null default false,
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
alter table public.recurring_movements add column if not exists debt_first_payment_date date;
alter table public.recurring_movements add column if not exists debt_last_payment_date date;
alter table public.recurring_movements add column if not exists share_method text default 'equal';
alter table public.recurring_movements add column if not exists notes text;
alter table public.recurring_movements add column if not exists variable_actuals jsonb default '{}'::jsonb;
alter table public.recurring_movements add column if not exists skipped_months jsonb default '[]'::jsonb;

-- Metas: icono y notas.
alter table public.goals add column if not exists emoji text default '🎯';
alter table public.goals add column if not exists notes text;

-- Vehículos: ficha completa.
alter table public.vehicles add column if not exists brand text;
alter table public.vehicles add column if not exists model text;
alter table public.vehicles add column if not exists year integer;
alter table public.vehicles add column if not exists km integer;
alter table public.vehicles add column if not exists status text default 'activo';
alter table public.vehicles add column if not exists notes text;

-- Registros de vehículo: seguros, cuotas, mantenimiento, avisos y proveedor.
alter table public.vehicle_records add column if not exists concept text;
alter table public.vehicle_records add column if not exists status text default 'realizado';
alter table public.vehicle_records add column if not exists km integer;
alter table public.vehicle_records add column if not exists next_date date;
alter table public.vehicle_records add column if not exists next_km integer;
alter table public.vehicle_records add column if not exists provider text;
alter table public.vehicle_records add column if not exists insurance_company text;
alter table public.vehicle_records add column if not exists payment_mode text;
alter table public.vehicle_records add column if not exists coverage_end date;
alter table public.vehicle_records add column if not exists installment_day integer;
alter table public.vehicle_records add column if not exists responsible_user_id uuid references auth.users(id) on delete set null;
alter table public.vehicle_records add column if not exists parent_record_id uuid references public.vehicle_records(id) on delete cascade;
alter table public.vehicle_records add column if not exists installment_number integer;
alter table public.vehicle_records add column if not exists total_installments integer;

-- Triggers updated_at donde aplica.
drop trigger if exists touch_movements_updated_at on public.movements;
create trigger touch_movements_updated_at before update on public.movements
  for each row execute function public.touch_updated_at();

drop trigger if exists touch_recurring_movements_updated_at on public.recurring_movements;
create trigger touch_recurring_movements_updated_at before update on public.recurring_movements
  for each row execute function public.touch_updated_at();

-- Permisos: mismos módulos del index integrado.
create or replace function public.default_permissions_for_role(p_role text)
returns table(module text, can_view boolean, can_create boolean, can_edit boolean, can_delete boolean)
language sql
stable
as $$
  select * from (values
    ('dashboard', true,  false, false, false),
    ('categories', true, p_role <> 'viewer', p_role <> 'viewer', false),
    ('members', p_role <> 'viewer', p_role = 'admin', p_role = 'admin', p_role = 'admin'),
    ('household', true,  false, false, false),
    ('register',  p_role <> 'viewer', p_role <> 'viewer', p_role <> 'viewer', false),
    ('vehicles', true, p_role <> 'viewer', p_role <> 'viewer', false),
    ('movements', true,  p_role <> 'viewer', p_role <> 'viewer', false),
    ('goals', true, p_role <> 'viewer', p_role <> 'viewer', p_role <> 'viewer'),
    ('history', true, false, false, false),
    ('backup', true, false, false, false),
    ('recurring', true, p_role <> 'viewer', p_role <> 'viewer', false),
    ('reports', p_role <> 'viewer', false, false, false),
    ('admin', false, false, false, false)
  ) as x(module, can_view, can_create, can_edit, can_delete)
$$;

insert into public.permissions(household_id, user_id, module, can_view, can_create, can_edit, can_delete)
select hm.household_id, hm.user_id, d.module, d.can_view, d.can_create, d.can_edit, d.can_delete
from public.household_members hm
cross join lateral public.default_permissions_for_role(hm.role) d
on conflict (household_id, user_id, module) do nothing;

update public.permissions p
set can_view = true,
    can_create = true,
    can_edit = true,
    can_delete = true,
    updated_at = now()
from public.household_members hm
where hm.household_id = p.household_id
  and hm.user_id = p.user_id
  and hm.role = 'admin'
  and p.module in ('dashboard','members','categories','household','register','vehicles','movements','goals','history','backup','recurring','reports','admin');

-- Índices prácticos.
create index if not exists recurring_movements_household_idx on public.recurring_movements(household_id, active, start_date);
create index if not exists movements_household_date_idx on public.movements(household_id, date);
create index if not exists vehicle_records_household_date_idx on public.vehicle_records(household_id, date);
