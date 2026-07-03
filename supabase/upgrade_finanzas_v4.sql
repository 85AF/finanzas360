-- Finanzas 360 Real · Upgrade Finanzas v4 (sin CRM)
-- Ejecuta este archivo UNA VEZ en Supabase > SQL Editor después de schema.sql, robust_v2 y old_mirror_v3.
-- Objetivo: normalizar estados de miembros y mantener la app centrada en finanzas familiares.

-- Normalizar estados viejos si existieran.
update public.household_members
set status = 'disabled'
where status = 'inactive';

-- Asegurar valores válidos en el esquema actual.
alter table public.household_members drop constraint if exists household_members_status_check;
alter table public.household_members
  add constraint household_members_status_check check (status in ('active','disabled'));

-- Asegurar que los módulos financieros base existan en permisos.
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

insert into public.permissions(household_id, user_id, module, can_view, can_create, can_edit, can_delete)
select hm.household_id, hm.user_id, d.module, d.can_view, d.can_create, d.can_edit, d.can_delete
from public.household_members hm
cross join lateral public.default_permissions_for_role(hm.role) d
on conflict (household_id, user_id, module) do nothing;

update public.permissions p
set can_view = true, can_create = true, can_edit = true, can_delete = true, updated_at = now()
from public.household_members hm
where hm.household_id = p.household_id
  and hm.user_id = p.user_id
  and hm.role = 'admin'
  and p.module in ('members','categories','household','register','vehicles','movements','goals','history','backup','recurring','reports','admin');
