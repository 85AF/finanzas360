export const MODULES = [
  { key: "dashboard", label: "1. Inicio", icon: "📊" },
  { key: "categories", label: "2. Categorías", icon: "🏷️" },
  { key: "members", label: "3. Hogar", icon: "🏠" },
  { key: "household", label: "4. Aportes", icon: "👨‍👩‍👧‍👦" },
  { key: "register", label: "5. Registrar", icon: "🖊️" },
  { key: "vehicles", label: "6. Vehículos", icon: "🚘" },
  { key: "movements", label: "7. Movimientos", icon: "📋" },
  { key: "goals", label: "8. Metas", icon: "🎯" },
  { key: "history", label: "9. Historial", icon: "🗓️" },
  { key: "backup", label: "10. Respaldo", icon: "💾" },
  { key: "recurring", label: "Recurrentes", icon: "🔁" },
  { key: "reports", label: "Reportes", icon: "📈" },
  { key: "admin", label: "Admin", icon: "🛡️" }
];

export const PERMISSION_FIELDS = ["can_view", "can_create", "can_edit", "can_delete"];

export const money = (value = 0) => {
  const n = Number(value || 0);
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(n);
};

export const todayISO = () => new Date().toISOString().slice(0, 10);
export const monthKey = (date = new Date()) => new Date(date).toISOString().slice(0, 7);

export const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

export const uid = () => crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());

export const downloadTextFile = (filename, content, type = "application/json") => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

export const toCSV = (rows) => {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const clean = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  return [headers.join(","), ...rows.map(row => headers.map(h => clean(row[h])).join(","))].join("\n");
};

export const groupBy = (items, fn) => items.reduce((acc, item) => {
  const key = fn(item);
  acc[key] ||= [];
  acc[key].push(item);
  return acc;
}, {});

export const sum = (items, fn) => items.reduce((acc, item) => acc + Number(fn(item) || 0), 0);
