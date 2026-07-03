# Migrar datos desde la app vieja

La app vieja guardaba en el navegador usando `localStorage`.

## Intento rápido

1. Abre la app vieja en el mismo navegador donde estaba la data.
2. Busca la sección Respaldo.
3. Exporta JSON si aparece.
4. Guarda ese archivo.

## Si no aparece la data

Puede haberse borrado por limpieza del navegador, cambio de perfil, limpieza de datos del sitio o uso de otro navegador.

## Script manual para revisar localStorage

En la app vieja, abre consola del navegador y ejecuta:

```js
Object.keys(localStorage).filter(k => k.toLowerCase().includes('finanzas')).map(k => ({ key: k, value: localStorage.getItem(k) }))
```

Si devuelve algo, copia los valores y guárdalos en un archivo `.json`.

## Próximo paso

Con ese JSON se puede crear un importador a Supabase mapeando:

- members -> household_members/profiles
- incomes y expenses -> movements
- categories -> categories
- goals -> goals
- vehicles -> vehicles
