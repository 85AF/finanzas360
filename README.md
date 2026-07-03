# Finanzas 360 Real

App financiera familiar con:

- Base de datos real en Supabase/PostgreSQL.
- Login con email y contraseña.
- Hogares familiares.
- Roles: `admin`, `member`, `viewer`.
- Permisos por módulo: ver, crear, editar y borrar.
- Movimientos personales y movimientos comunes del hogar.
- Vista global para administrador.
- Vista personal para cada integrante.
- Exportación JSON/CSV.
- Lista para publicar en Vercel, GitHub Pages, Netlify o cualquier hosting estático.

---

## 1. Crear proyecto en Supabase

1. Entra en https://supabase.com
2. Crea un proyecto nuevo.
3. Ve a **SQL Editor**.
4. Copia y ejecuta completo el archivo:

```txt
supabase/schema.sql
```

Ese archivo crea las tablas, roles, permisos, invitaciones, seguridad RLS y categorías iniciales.

---

## 2. Conseguir las claves de Supabase

En Supabase:

1. Ve a **Project Settings**.
2. Entra en **API**.
3. Copia:
   - Project URL
   - anon public key

Luego abre:

```txt
src/config.js
```

Y reemplaza:

```js
export const SUPABASE_URL = "PEGA_AQUI_TU_SUPABASE_URL";
export const SUPABASE_ANON_KEY = "PEGA_AQUI_TU_SUPABASE_ANON_KEY";
```

Por tus datos reales.

No pongas nunca la `service_role key` en el frontend.

---

## 3. Probar la app en local

Como usa módulos JavaScript, no la abras con doble clic si el navegador bloquea módulos.

Opciones rápidas:

### Opción A: VS Code

1. Abre la carpeta del proyecto en VS Code.
2. Instala la extensión **Live Server**.
3. Clic derecho en `index.html`.
4. **Open with Live Server**.

### Opción B: Python

Desde la carpeta del proyecto:

```bash
python -m http.server 8080
```

Luego abre:

```txt
http://localhost:8080
```

---

## 4. Primer uso

1. Crea tu usuario desde la app.
2. Crea tu hogar, por ejemplo: `Familia Fernández`.
3. Ese primer usuario será administrador automáticamente.
4. Ve a **Admin**.
5. Invita a familiares por email.
6. Cada familiar debe crear cuenta con ese mismo email.
7. Al entrar verá la invitación pendiente y podrá aceptarla.
8. Luego el admin puede darle permisos.

---

## 5. Publicar online con Vercel

1. Crea un repositorio en GitHub.
2. Sube todos estos archivos.
3. Entra a https://vercel.com
4. Importa el repositorio.
5. Publica.

Como esta app es estática, no necesita backend propio. Supabase hace de BBDD, Auth y seguridad.

---

## 6. Publicar con GitHub Pages

También puedes usar GitHub Pages:

1. Sube el proyecto a GitHub.
2. Ve a **Settings > Pages**.
3. Selecciona la rama `main`.
4. Carpeta `/root`.
5. Guarda.

GitHub Pages solo publica HTML/CSS/JS. La base de datos sigue estando en Supabase.

---

## 7. Permisos recomendados

### Admin

Todo activo.

### Miembro

- Ver Dashboard.
- Crear movimientos.
- Ver movimientos propios y comunes.
- Crear metas.
- Exportar respaldo propio.

### Viewer / solo lectura

- Ver Dashboard.
- Ver casa común.
- Sin crear, editar ni borrar.

---

## 8. Qué guarda la app

La app guarda en Supabase:

- Hogares.
- Usuarios/perfiles.
- Miembros del hogar.
- Permisos.
- Invitaciones.
- Categorías.
- Ingresos/gastos.
- Gastos comunes del hogar.
- Metas.
- Vehículos.
- Respaldos exportables.

---

## 9. Seguridad

La seguridad real está en Supabase con Row Level Security.

Aunque alguien intente manipular el navegador, las políticas SQL bloquean lo que no tenga permiso.

---

## 10. Migración desde tu app vieja

Tu app vieja guardaba datos en `localStorage`. Si todavía puedes abrirla y exportar JSON, luego se puede crear un importador para pasar esos datos a Supabase.

En esta primera versión dejé la estructura lista para eso.


## Look & feel Neon Core

Esta entrega mantiene la lógica original de la app real con Supabase, usuarios, roles y permisos, pero añade una capa visual en `assets/neon-look.css` y efectos ambientales en `assets/neon-look.js`.

Si necesitas volver al aspecto anterior, elimina del `index.html` estas dos líneas:

```html
<link rel="stylesheet" href="./assets/neon-look.css" />
<script src="./assets/neon-look.js" defer></script>
```

## Nota visual - Look Neon Core Light

Esta versión usa una capa visual nueva en `assets/neon-look.css` y `assets/neon-look.js`. No cambia la lógica de Supabase, roles, permisos ni base de datos.

Importante: no abras `index.html` directamente con `file:///...` porque los módulos JavaScript pueden quedarse en la pantalla de carga. Levanta la app con un servidor local:

```bash
python -m http.server 8080
```

Luego abre:

```txt
http://localhost:8080
```

También puedes usar la extensión **Live Server** de VS Code.


---

## Auditoría lógica Finanzas v4 (sin CRM)

Se agregó una revisión técnica en `docs/AUDITORIA_LOGICA_FINANZAS.md` y una migración segura en `supabase/upgrade_finanzas_v4.sql`.

Esta versión NO agrega contactos, clientes, proveedores, actividades CRM ni documentos. La mejora queda centrada en finanzas familiares: miembros, filtros, movimientos, reparto de gastos compartidos, hogar, recurrentes y análisis mensual/anual.

Si llegaste a ejecutar por error la migración anterior llamada `upgrade_crm_professional_v4.sql`, usa `supabase/rollback_remove_crm_v4.sql` para limpiar esas tablas/campos antes de continuar.
