-- Finanzas 360 Real · Rollback de la migración CRM v4 errónea
-- USAR SOLO si ejecutaste antes `upgrade_crm_professional_v4.sql`.
-- Esto elimina tablas/campos que NO pertenecen a la app de finanzas familiares.

-- Quitar permisos agregados por error.
delete from public.permissions where module in ('contacts','documents');

-- Quitar tablas creadas por error. Se usa cascade porque tienen políticas, triggers e índices asociados.
drop table if exists public.crm_activities cascade;
drop table if exists public.documents cascade;
drop table if exists public.contacts cascade;

-- Quitar columnas CRM agregadas por error en movimientos.
alter table public.movements drop column if exists vendor;
alter table public.movements drop column if exists payment_method;
alter table public.movements drop column if exists document_url;
alter table public.movements drop column if exists reference;
alter table public.movements drop column if exists status;
alter table public.movements drop column if exists reconciled;
alter table public.movements drop column if exists tax_deductible;

-- Restaurar permisos financieros base.
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
