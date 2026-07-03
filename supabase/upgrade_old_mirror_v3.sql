-- Finanzas 360 Real · Upgrade V3 espejo app antigua
-- Ejecuta UNA VEZ en Supabase > SQL Editor después del upgrade robust_v2.
-- Agrega campos para que la app nueva tenga la misma profundidad visual/funcional que la app vieja.

create extension if not exists pgcrypto;

-- Categorías con presupuesto mensual como en la app antigua.
alter table public.categories add column if not exists budget numeric(12,2) not null default 0;

-- Metas con icono y notas.
alter table public.goals add column if not exists emoji text default '🎯';
alter table public.goals add column if not exists notes text;

-- Miembros del hogar con datos financieros y perfil doméstico.
alter table public.household_members add column if not exists display_name text;
alter table public.household_members add column if not exists household_type text default 'family';
alter table public.household_members add column if not exists monthly_income numeric(12,2) not null default 0;
alter table public.household_members add column if not exists pay_day integer;
alter table public.household_members add column if not exists income_category_id uuid references public.categories(id) on delete set null;
alter table public.household_members add column if not exists auto_income boolean not null default false;
alter table public.household_members add column if not exists participation_percent numeric(6,2);
alter table public.household_members add column if not exists works boolean not null default true;
alter table public.household_members add column if not exists contributes_income boolean not null default true;
alter table public.household_members add column if not exists dependent boolean not null default false;

-- Movimientos con tipo interno y reparto como en la app antigua.
alter table public.movements add column if not exists kind text default 'personal';
alter table public.movements add column if not exists share_method text default 'equal';
alter table public.movements add column if not exists notes text;

-- Recurrentes/deudas/servicios variables con datos ampliados.
alter table public.recurring_movements add column if not exists kind text default 'fixed';
alter table public.recurring_movements add column if not exists amount_mode text default 'fixed';
alter table public.recurring_movements add column if not exists end_mode text default 'indefinite';
alter table public.recurring_movements add column if not exists fixed_months integer;
alter table public.recurring_movements add column if not exists fixed_years integer;
alter table public.recurring_movements add column if not exists debt_original_amount numeric(12,2);
alter table public.recurring_movements add column if not exists debt_lender text;
alter table public.recurring_movements add column if not exists first_payment_date date;
alter table public.recurring_movements add column if not exists last_payment_date date;
alter table public.recurring_movements add column if not exists notes text;

-- Módulo members/hogar en permisos.
create or replace function public.default_permissions_for_role(p_role text)
returns table(module text, can_view boolean, can_create boolean, can_edit boolean, can_delete boolean)
language sql
stable
as $$
  select * from (values
    ('dashboard', true,  false, false, false),
    ('categories', true, p_role = 'member', p_role = 'member', false),
    ('members', p_role <> 'viewer', p_role = 'admin', p_role = 'admin', p_role = 'admin'),
    ('household', true,  false, false, false),
    ('register',  p_role <> 'viewer', p_role <> 'viewer', false, false),
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

-- Permisos faltantes para miembros existentes.
insert into public.permissions(household_id, user_id, module, can_view, can_create, can_edit, can_delete)
select hm.household_id, hm.user_id, d.module, d.can_view, d.can_create, d.can_edit, d.can_delete
from public.household_members hm
cross join lateral public.default_permissions_for_role(hm.role) d
on conflict (household_id, user_id, module) do nothing;

-- Admins con acceso total a módulos nuevos.
update public.permissions p
set can_view = true, can_create = true, can_edit = true, can_delete = true, updated_at = now()
from public.household_members hm
where hm.household_id = p.household_id
  and hm.user_id = p.user_id
  and hm.role = 'admin'
  and p.module in ('members','categories','household','register','vehicles','movements','goals','history','backup','recurring','reports','admin');

create index if not exists idx_movements_household_kind on public.movements(household_id, kind);
create index if not exists idx_categories_household_budget on public.categories(household_id, budget);
