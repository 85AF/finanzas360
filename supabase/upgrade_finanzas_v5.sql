-- Finanzas 360 Real · upgrade v5
-- Añade soporte para seguros financiados por cuotas y datos avanzados usados por la app.
-- Ejecuta este archivo en Supabase > SQL Editor después de schema.sql y upgrades anteriores.

alter table public.vehicle_records add column if not exists installment_count integer;
alter table public.vehicle_records add column if not exists installment_amount numeric(12,2);
alter table public.vehicle_records add column if not exists installments_json jsonb;

create index if not exists idx_vehicle_records_installments
on public.vehicle_records(household_id, type, payment_mode, date);

comment on column public.vehicle_records.installment_count is 'Número de cuotas del seguro financiado. La app lo usa para proyectar cada cuota mensual en Inicio y Movimientos.';
comment on column public.vehicle_records.installment_amount is 'Importe de cada cuota del seguro. Si queda vacío, la app divide el total entre installment_count.';
comment on column public.vehicle_records.installments_json is 'Lista opcional de cuotas personalizadas [{"date":"YYYY-MM-DD","amount":123.45}].';
