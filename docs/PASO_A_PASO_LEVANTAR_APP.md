# Paso a paso para levantar Finanzas 360 Real

## Parte A · Supabase

1. Crea una cuenta en Supabase.
2. Crea un proyecto nuevo.
3. Entra en SQL Editor.
4. Abre el archivo `supabase/schema.sql`.
5. Copia todo y ejecútalo.
6. Espera a que termine sin errores.
7. Ve a Authentication > Providers.
8. Activa Email si no está activo.
9. En Authentication > URL Configuration, luego cuando tengas dominio, agrega la URL de tu app.

## Parte B · Configurar la app

1. Copia la Project URL de Supabase.
2. Copia la anon public key.
3. Abre `src/config.js`.
4. Pega los valores.
5. Guarda.

## Parte C · Probar

1. Abre la carpeta con VS Code.
2. Usa Live Server o `python -m http.server 8080`.
3. Crea el primer usuario.
4. Crea el primer hogar.
5. Revisa que aparezcan categorías iniciales.
6. Crea un ingreso y un gasto.
7. Sal de la cuenta y vuelve a entrar.
8. Si la data aparece, ya está conectada a BBDD.

## Parte D · Invitar familiares

1. Entra como admin.
2. Ve a Admin.
3. Coloca el email del familiar.
4. Selecciona rol.
5. Crea la invitación.
6. El familiar se registra con ese mismo email.
7. Le aparecerá la invitación.
8. La acepta.
9. Tú ajustas permisos desde Admin.

## Parte E · Publicar en Vercel

1. Crea repositorio en GitHub.
2. Sube todos los archivos.
3. Entra en Vercel.
4. Importa el repo.
5. Deploy.
6. Copia la URL final.
7. En Supabase > Authentication > URL Configuration agrega esa URL.

## Parte F · Publicar en GitHub Pages

1. Repo en GitHub.
2. Settings.
3. Pages.
4. Source: Deploy from branch.
5. Branch: main.
6. Folder: root.
7. Guardar.

## Parte G · Flujo normal de uso

- Cada usuario entra con email y contraseña.
- Cada quien registra sus ingresos/gastos.
- Si un gasto es de casa, marca “Movimiento común del hogar”.
- El admin puede ver todo junto.
- Un miembro normal ve su información y lo común.
- El viewer solo ve lo que se le permita.
