# Seguridad y roles

## Roles

### admin
Puede ver y administrar todo el hogar.

### member
Puede registrar sus datos y ver información común permitida.

### viewer
Puede ver información, pero no crear ni editar si el admin no le da permiso.

## Permisos

Cada módulo tiene:

- can_view
- can_create
- can_edit
- can_delete

## Módulos

- dashboard
- register
- movements
- household
- categories
- goals
- vehicles
- reports
- backup
- admin

## Seguridad real

La seguridad no depende solo de esconder botones.

La app también tiene políticas RLS en Supabase. Eso significa que la base de datos bloquea acciones no permitidas incluso si alguien intenta manipular el navegador.
