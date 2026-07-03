# Auditoría lógica · Finanzas 360 Real (sin CRM)

## Veredicto directo
La app tiene buena base para finanzas familiares: Supabase, usuarios, roles, hogares, miembros, movimientos, vehículos, recurrentes, metas, reportes e historial. El problema principal no era falta de “CRM”; era que algunas piezas financieras estaban calculando o filtrando de forma floja.

Esta revisión deja el proyecto enfocado 100% en finanzas del hogar. Se eliminaron las ideas de contactos, clientes, proveedores, actividades CRM y documentos.

## Fallos críticos corregidos

### 1. Estado de miembros
El código usaba `inactive`, pero el esquema de Supabase trabaja con `active` y `disabled`. Eso podía romper la desactivación de miembros.

**Corrección aplicada:**
- La app guarda miembros inactivos como `disabled`.
- La lógica visual acepta `inactive` y `disabled` por compatibilidad.
- Se agregó `upgrade_finanzas_v4.sql` para normalizar datos si existieran registros antiguos.

### 2. Filtros duplicados en movimientos
La sección Movimientos tenía un selector de miembro duplicado con el mismo `id="filterPerson"`. Eso podía romper listeners y provocar filtros raros.

**Corrección aplicada:**
- Se eliminó el selector duplicado.
- Se deja el selector principal del toolbar.
- Se agregan filtros funcionales por categoría y búsqueda.

### 3. Botón muerto en dashboard
El botón “Cargar datos de ejemplo” no tenía acción conectada.

**Corrección aplicada:**
- Se eliminó para evitar confusión.

### 4. Gastos compartidos mal asignados por persona
Al seleccionar una persona, los gastos compartidos podían entrar completos en su balance. Eso inflaba gastos y hacía que el dashboard mintiera.

**Corrección aplicada:**
- Los gastos compartidos se reparten por persona.
- Soporta reparto igual, por ingresos o por porcentaje manual.
- Los dependientes no aportantes no alteran el reparto.

### 5. Aportes del hogar mezclaban miembros inactivos/dependientes
El cálculo podía dividir gastos entre todos los miembros, sin distinguir quién aporta y quién no.

**Corrección aplicada:**
- Se usan solo miembros activos y aportantes.
- Los dependientes siguen visibles, pero no distorsionan el cálculo.

### 6. Recurrentes no guardaban todos los campos del formulario
El formulario pedía datos de deudas/servicios, pero el guardado solo insertaba campos básicos.

**Corrección aplicada:**
- Ahora guarda `amount_mode`, `end_mode`, `debt_original_amount`, `debt_lender`, `notes` y `kind`.

### 7. Historial mensual corto
La vista de meses anteriores mostraba solo 6 meses.

**Corrección aplicada:**
- Ahora muestra los 12 meses del año activo.

## Qué NO incluye esta versión
Esta versión no agrega:
- Contactos.
- Clientes.
- Proveedores como módulo comercial.
- Actividades CRM.
- Documentos vinculados a contactos.
- Pipeline comercial.

## Recomendaciones para robustecer sin convertirlo en CRM

### Finanzas familiares
- Presupuestos por categoría con alerta de exceso.
- Comparación mes actual vs mes anterior.
- Comparación mismo mes del año anterior.
- Flujo de caja proyectado para 3, 6 y 12 meses.
- Balance por persona y balance total del hogar.

### Deudas y recurrentes
- Fecha de primer pago.
- Fecha de último pago.
- Meses restantes.
- Total pagado.
- Total pendiente.
- Estado: activo, pausado, finalizado.

### Hogar
- Adultos que aportan.
- Dependientes.
- Porcentaje de participación.
- Día de cobro por persona.
- Ingreso mensual estimado por persona.

### Vehículos
- Próxima ITV.
- Próximo mantenimiento por fecha o kilometraje.
- Seguro anual/cuotas.
- Historial por vehículo.

### Arquitectura recomendada
El archivo `src/main.js` sigue siendo grande. La próxima limpieza debería separar:
- `state.js`
- `services/supabase.js`
- `modules/dashboard.js`
- `modules/movements.js`
- `modules/household.js`
- `modules/vehicles.js`
- `modules/members.js`
- `modules/reports.js`

## Archivos modificados
- `src/main.js`
- `README.md`
- `docs/AUDITORIA_LOGICA_FINANZAS.md`
- `supabase/upgrade_finanzas_v4.sql`
- `supabase/rollback_remove_crm_v4.sql` (solo por si aplicaste la migración CRM anterior por error)

## Cómo aplicar esta versión
1. Sube los archivos nuevos.
2. En Supabase, ejecuta los scripts base si no los habías ejecutado:
   - `schema.sql`
   - `upgrade_robust_v2.sql`
   - `upgrade_old_mirror_v3.sql`
3. Luego ejecuta:
   - `upgrade_finanzas_v4.sql`
4. Si ejecutaste por error la migración CRM anterior, ejecuta antes:
   - `rollback_remove_crm_v4.sql`
