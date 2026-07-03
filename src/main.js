import { supabase, isSupabaseConfigured } from "./supabaseClient.js";
import { MODULES, PERMISSION_FIELDS, money, todayISO, monthKey, escapeHtml, downloadTextFile, toCSV, sum } from "./utils.js";

const app = document.getElementById("app");

const state = {
  session: null,
  user: null,
  profile: null,
  households: [],
  currentHouseholdId: null,
  currentMember: null,
  members: [],
  profilesByUserId: {},
  permissions: [],
  categories: [],
  movements: [],
  recurring: [],
  goals: [],
  vehicles: [],
  vehicleRecords: [],
  invitations: [],
  pendingInvitations: [],
  activeSection: "dashboard",
  authMode: "login",
  authError: "",
  filters: {
    person: "me",
    month: monthKey(),
    movementType: "all",
    category: "all",
    search: "",
    vehicle: "all",
    year: String(new Date().getFullYear()),
    sortField: "date",
    sortDirection: "desc"
  },
  analytics: {
    periodMonths: 12,
    compare: "prevMonth",
    category: "all",
    top: 7
  }
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const parseAmount = (value) => Number(String(value || "0").replace(",", ".")) || 0;
const dateOnly = (value) => String(value || "").slice(0, 10);
const activeMonth = () => state.filters.month || monthKey();
const activeYear = () => Number((state.filters.year || activeMonth().slice(0, 4)) || new Date().getFullYear());
const isSameMonth = (date, m = activeMonth()) => String(date || "").startsWith(m);
const isSameYear = (date, y = activeYear()) => String(date || "").slice(0, 4) === String(y);

const INACTIVE_MEMBER_STATUSES = new Set(["inactive", "disabled"]);
const isActiveMember = (member) => !INACTIVE_MEMBER_STATUSES.has(String(member?.status || "active").toLowerCase());

function activeHouseholdMembers() {
  return uniqueMembers(state.members).filter(isActiveMember);
}

function contributionMembers() {
  const eligible = activeHouseholdMembers().filter(m =>
    m.user_id &&
    m.dependent !== true &&
    m.contributes_income !== false
  );
  return eligible.length ? eligible : activeHouseholdMembers().filter(m => m.user_id);
}

function memberShareRatio(userId, movement = {}) {
  if (!userId) return 0;
  const members = contributionMembers();
  if (!members.some(m => m.user_id === userId)) return 0;
  let method = movement.share_method || "equal";
  if (method === "income" && !canSeeAll()) method = "manual";

  if (method === "income") {
    // Ya no usamos el sueldo escrito en la ficha del miembro: el reparto por ingresos
    // se calcula con ingresos reales registrados en Movimientos durante el mismo mes.
    const targetMonth = String(movement.date || activeMonth()).slice(0, 7) || activeMonth();
    const incomeFor = memberId => sum(
      state.movements.filter(x =>
        x.type === "income" &&
        isSameMonth(x.date, targetMonth) &&
        (x.member_id === memberId || x.user_id === memberId)
      ),
      x => x.amount
    );
    const totalIncome = sum(members, m => incomeFor(m.user_id));
    if (totalIncome > 0) return incomeFor(userId) / totalIncome;
  }

  if (method === "manual") {
    const totalPercent = sum(members, m => Number(m.participation_percent || 0));
    if (totalPercent > 0) {
      const pctValue = Number(members.find(m => m.user_id === userId)?.participation_percent || 0);
      return pctValue / totalPercent;
    }
  }

  return 1 / Math.max(1, members.length);
}

function allocateSharedMovementForPerson(movement, personId) {
  if (!movement?.is_shared || !personId) return movement;
  const ratio = memberShareRatio(personId, movement);
  if (ratio <= 0) return null;
  return {
    ...movement,
    amount: Number(movement.amount || 0) * ratio,
    _original_amount: Number(movement.amount || 0),
    _allocated: true,
    _share_ratio: ratio
  };
}

function applyPersonFilterWithSharedAllocation(items, person = state.filters.person) {
  if (person === "all") {
    if (!canSeeAll()) return applyPersonFilterWithSharedAllocation(items, "me");
    return [...items];
  }
  const targetId = person === "me" ? state.user?.id : person;
  if (!canSeeAll() && targetId !== state.user?.id) return [];
  return items
    .map(item => {
      const belongsToPerson = item.user_id === targetId || item.member_id === targetId;
      if (item.is_shared) return allocateSharedMovementForPerson(item, targetId);
      return belongsToPerson ? item : null;
    })
    .filter(Boolean);
}

function movementMatchesText(movement, rawSearch = "") {
  const query = String(rawSearch || "").trim().toLowerCase();
  if (!query) return true;
  return [movement.description, movement.notes, categoryName(movement.category_id), memberName(movement.member_id || movement.user_id)]
    .some(value => String(value || "").toLowerCase().includes(query));
}

function movementsForMonthPerson(month = activeMonth(), person = state.filters.person, options = {}) {
  const { respectType = true } = options;
  let items = getVisibleMovements().filter(x => isSameMonth(x.date, month));
  if (respectType && state.filters.movementType && state.filters.movementType !== "all") items = items.filter(x => x.type === state.filters.movementType);
  return applyPersonFilterWithSharedAllocation(items, person);
}

function showToast(message, tone = "dark") {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.style.background = tone === "danger" ? "#991b1b" : tone === "ok" ? "#065f46" : "#172033";
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 4200);
}

function friendlyAuthMessage(error, mode = state.authMode) {
  const raw = String(error?.message || error || "").toLowerCase();

  if (mode === "login") {
    if (raw.includes("invalid") || raw.includes("credentials") || raw.includes("login")) {
      return "Usuario o contraseña incorrectos. Revisa el correo y la clave e inténtalo otra vez.";
    }
    if (raw.includes("email not confirmed") || raw.includes("not confirmed")) {
      return "Tu correo todavía no está confirmado. Revisa tu email antes de entrar.";
    }
    if (raw.includes("network") || raw.includes("fetch") || raw.includes("failed")) {
      return "No se pudo conectar con el servidor. Revisa internet y vuelve a intentarlo.";
    }
    return "No pudimos iniciar sesión. Verifica tu usuario y contraseña.";
  }

  if (raw.includes("already registered") || raw.includes("already exists") || raw.includes("user already")) {
    return "Ese correo ya está registrado. Prueba entrando con tu contraseña.";
  }
  if (raw.includes("password")) return "La contraseña debe tener mínimo 6 caracteres.";
  if (raw.includes("email")) return "Coloca un correo válido para crear la cuenta.";
  return error?.message || "No pudimos crear el usuario. Revisa los datos e inténtalo otra vez.";
}

function setAuthError(message) {
  state.authError = message;
  const box = document.getElementById("authMessage");
  if (box) {
    box.textContent = message;
    box.hidden = false;
  }
  showToast(message, "danger");
}

function clearAuthError() {
  state.authError = "";
  const box = document.getElementById("authMessage");
  if (box) {
    box.textContent = "";
    box.hidden = true;
  }
}

function getCurrentHousehold() {
  return state.households.find(h => h.id === state.currentHouseholdId) || null;
}

function isAdmin() {
  return state.currentMember?.role === "admin" || getCurrentHousehold()?.owner_id === state.user?.id;
}

function permissionFor(module) {
  return state.permissions.find(p => p.module === module && p.user_id === state.user?.id);
}

function can(module, action = "view") {
  if (isAdmin()) return true;
  const key = action === "view" ? "can_view" : action === "create" ? "can_create" : action === "edit" ? "can_edit" : "can_delete";
  return Boolean(permissionFor(module)?.[key]);
}

function uniqueMembers(list = state.members) {
  const seen = new Map();
  (list || []).forEach(member => {
    if (!member) return;
    const key = member.user_id || member.id || member.email || member.display_name;
    if (!key) return;
    const previous = seen.get(key);
    if (!previous) {
      seen.set(key, member);
      return;
    }
    const score = item =>
      (item.status === "active" ? 8 : 0) +
      (item.role === "admin" ? 4 : 0) +
      (item.user_id === state.user?.id ? 2 : 0) +
      (item.display_name ? 1 : 0);
    if (score(member) >= score(previous)) seen.set(key, { ...previous, ...member });
  });
  return [...seen.values()];
}

function visibleMembers(includeInactive = false) {
  return uniqueMembers(state.members).filter(m => includeInactive || isActiveMember(m));
}

function filterPersonOptions() {
  const options = [];
  if (canSeeAll()) options.push(`<option value="all" ${state.filters.person === "all" ? "selected" : ""}>Todo el hogar</option>`);
  options.push(`<option value="me" ${state.filters.person === "me" ? "selected" : ""}>Mi información</option>`);
  if (canSeeAll()) {
    visibleMembers().forEach(m => {
      if (!m.user_id || m.user_id === state.user?.id) return;
      options.push(`<option value="${m.user_id}" ${state.filters.person === m.user_id ? "selected" : ""}>${escapeHtml(memberName(m.user_id))}</option>`);
    });
  }
  return options.join("");
}

function memberRecord(userId) {
  return visibleMembers(true).find(m => m.user_id === userId) || null;
}

function memberName(userId) {
  if (!userId) return "Sin usuario";
  const m = memberRecord(userId);
  const p = state.profilesByUserId[userId];
  if (m?.display_name) return m.display_name;
  if (p?.full_name) return p.full_name;
  if (p?.email) return p.email;
  if (userId === state.user?.id) return state.profile?.full_name || state.user.email;
  return "Usuario";
}

function categoryName(id) {
  if (id === "__vehicle__") return "Vehículos";
  return state.categories.find(c => c.id === id)?.name || "Sin categoría";
}

function categoryOptions(type = "all", selected = "") {
  const cats = state.categories.filter(c => c.type === "both" || type === "all" || c.type === type);
  return `<option value="">Sin categoría</option>${cats.map(c => `<option value="${c.id}" ${selected === c.id ? "selected" : ""}>${escapeHtml(c.name)} · ${escapeHtml(c.type)}</option>`).join("")}`;
}

function memberOptions(selected = state.user?.id) {
  const selectedId = canSeeAll() ? selected : state.user?.id;
  const list = canSeeAll()
    ? visibleMembers(true).filter(m => m.user_id)
    : visibleMembers(true).filter(m => m.user_id === state.user?.id);
  const fallback = list.length ? list : [{ user_id: state.user?.id }];
  return fallback
    .filter(m => m.user_id)
    .map(m => `<option value="${m.user_id}" ${selectedId === m.user_id ? "selected" : ""}>${escapeHtml(memberName(m.user_id))}</option>`)
    .join("");
}

function canSeeAll() {
  // Regla de privacidad central: solo el administrador puede ver Todo el hogar
  // o filtrar por otros integrantes. Los demás ven su información + lo compartido.
  return isAdmin();
}

function enforceMemberPrivacyScope() {
  if (canSeeAll()) return;
  state.filters.person = "me";
  if (state.filters.member && state.filters.member !== "all" && state.filters.member !== state.user?.id) {
    state.filters.member = "all";
  }
}

function safeAssignableMemberId(value) {
  const requested = String(value || state.user?.id || "");
  if (canSeeAll() && visibleMembers(true).some(m => m.user_id === requested)) return requested;
  return state.user?.id || requested;
}

function canManageMovementRecord(record) {
  if (!record) return false;
  if (isAdmin()) return true;
  return record.user_id === state.user?.id || record.member_id === state.user?.id;
}

function canManageRecurringRecord(record) {
  if (!record) return false;
  if (isAdmin()) return true;
  return record.user_id === state.user?.id || record.member_id === state.user?.id;
}

function canManageVehicleRecord(record) {
  if (!record) return false;
  if (isAdmin()) return true;
  const vehicle = state.vehicles.find(v => v.id === record.vehicle_id);
  return record.user_id === state.user?.id || record.responsible_user_id === state.user?.id || vehicle?.owner_id === state.user?.id;
}

function canManageVehicle(vehicle) {
  if (!vehicle) return false;
  if (isAdmin()) return true;
  return vehicle.owner_id === state.user?.id;
}

function visibleRecurringItems() {
  if (isAdmin()) return state.recurring;
  return state.recurring.filter(r => r.user_id === state.user?.id || r.member_id === state.user?.id || r.is_shared);
}

function visibleVehicleItems() {
  if (isAdmin()) return state.vehicles;
  return state.vehicles.filter(v => v.owner_id === state.user?.id);
}

function visibleVehicleRecordItems() {
  if (isAdmin()) return state.vehicleRecords;
  return state.vehicleRecords.filter(r => canManageVehicleRecord(r));
}

function visibleModules() {
  return MODULES.filter(m => {
    if (m.key === "admin") return isAdmin();
    return can(m.key, "view") || m.key === "dashboard";
  });
}

function vehicleRecordResponsibleId(record) {
  const vehicle = state.vehicles.find(v => v.id === record.vehicle_id);
  return record.responsible_user_id || vehicle?.owner_id || record.user_id || state.user?.id || null;
}

function vehicleRecordDescription(record) {
  const vehicle = state.vehicles.find(v => v.id === record.vehicle_id);
  const concept = record.concept || record.insurance_company || record.note || vehicleRecordTypeLabel(record.type);
  return [vehicleRecordTypeLabel(record.type), vehicle?.name, concept]
    .filter(Boolean)
    .join(" · ");
}

function vehicleRecordAsMovement(record, installment = null) {
  const responsibleId = vehicleRecordResponsibleId(record);
  const installmentNumber = installment?.number || null;
  const installmentCount = installment?.count || null;
  const baseDescription = vehicleRecordDescription(record);
  const installmentText = installmentNumber && installmentCount ? ` · cuota ${installmentNumber}/${installmentCount}` : "";
  return {
    id: `vehicle:${record.id}${installmentNumber ? `:${installmentNumber}` : ""}`,
    _source: "vehicle",
    _vehicle_record_id: record.id,
    _vehicle_id: record.vehicle_id,
    household_id: record.household_id,
    user_id: record.user_id || responsibleId,
    member_id: responsibleId,
    type: "expense",
    category_id: "__vehicle__",
    amount: Number(installment?.amount ?? record.amount ?? 0),
    date: installment?.date || record.date || todayISO(),
    description: installment?.description || `${baseDescription}${installmentText}`,
    notes: record.note || "",
    kind: "vehicle",
    share_method: "none",
    is_shared: false,
    created_at: record.created_at
  };
}

function safeJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function insuranceInstallmentPlan(record) {
  if (record?.type !== "insurance") return [];
  const mode = String(record.payment_mode || "cash").toLowerCase();
  if (!["financed", "monthly", "installments", "cuotas"].includes(mode)) return [];
  const explicit = safeJsonArray(record.installments_json).filter(x => x && (x.date || x.amount));
  if (explicit.length) {
    return explicit.map((item, index) => ({
      number: index + 1,
      count: explicit.length,
      date: dateOnly(item.date) || record.date || todayISO(),
      amount: Number(item.amount || 0),
      description: item.description || `${vehicleRecordDescription(record)} · cuota ${index + 1}/${explicit.length}`
    })).filter(x => x.amount > 0);
  }

  const total = Number(record.amount || 0);
  if (total <= 0) return [];
  const start = dateOnly(record.date) || todayISO();
  const startMonth = start.slice(0, 7);
  const coverageEnd = dateOnly(record.coverage_end || "");
  const monthsByCoverage = coverageEnd ? Math.max(1, monthIndexFromKey(coverageEnd.slice(0, 7)) - monthIndexFromKey(startMonth) + 1) : 0;
  const count = Math.max(1, Math.min(60, Number(record.installment_count || 0) || monthsByCoverage || (mode === "monthly" ? 12 : 1)));
  if (count <= 1) return [];
  const installmentAmount = Number(record.installment_amount || 0) > 0 ? Number(record.installment_amount) : total / count;
  const day = Number(record.installment_day || String(start).slice(8, 10) || 1);
  return Array.from({ length: count }, (_, index) => {
    const key = addMonthsKey(startMonth, index);
    const date = `${key}-${clampDayForMonth(key, day)}`;
    return {
      number: index + 1,
      count,
      date,
      amount: Number(installmentAmount.toFixed(2)),
      description: `${vehicleRecordDescription(record)} · cuota ${index + 1}/${count}`
    };
  });
}

function vehicleRecordMovementInstances(record) {
  const installments = insuranceInstallmentPlan(record);
  return installments.length ? installments.map(item => vehicleRecordAsMovement(record, item)) : [vehicleRecordAsMovement(record)];
}

function vehicleRecordsAsMovements() {
  return visibleVehicleRecordItems()
    .filter(record => String(record.status || "").toLowerCase() !== "cancelado")
    .flatMap(vehicleRecordMovementInstances);
}

function monthIndexFromKey(key) {
  const [year, month] = String(key || monthKey()).split("-").map(Number);
  return (Number(year) || new Date().getFullYear()) * 12 + ((Number(month) || 1) - 1);
}

function monthKeyFromIndex(index) {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

function addMonthsKey(key, offset = 0) {
  return monthKeyFromIndex(monthIndexFromKey(key) + Number(offset || 0));
}

function clampDayForMonth(month, day = 1) {
  const [year, rawMonth] = String(month).split("-").map(Number);
  const safeDay = Math.max(1, Math.min(31, Number(day || 1)));
  const lastDay = new Date(year, rawMonth, 0).getDate();
  return String(Math.min(safeDay, lastDay)).padStart(2, "0");
}

function normalizeComparableText(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function recurringViewMonthKeys() {
  const keys = new Set();
  const active = activeMonth();
  for (let i = -24; i <= 18; i += 1) keys.add(addMonthsKey(active, i));

  const years = new Set([
    Number(String(active).slice(0, 4)),
    Number(state.filters.year),
    new Date().getFullYear(),
    activeYear(),
    activeYear() - 1
  ].filter(Boolean));

  const movementScope = isAdmin()
    ? state.movements
    : state.movements.filter(x => x.user_id === state.user?.id || x.member_id === state.user?.id || x.is_shared);
  [...movementScope, ...visibleVehicleRecordItems(), ...visibleRecurringItems()].forEach(item => {
    const year = Number(String(item?.date || item?.start_date || item?.first_payment_date || item?.created_at || "").slice(0, 4));
    if (year) years.add(year);
  });

  years.forEach(year => {
    for (let month = 1; month <= 12; month += 1) keys.add(`${year}-${String(month).padStart(2, "0")}`);
  });

  return [...keys].sort();
}

function recurringFrequencyStep(frequency = "monthly") {
  const value = String(frequency || "monthly").toLowerCase();
  if (["bimonthly", "bi-monthly", "every_2_months", "2months"].includes(value)) return 2;
  if (["yearly", "annual", "annually"].includes(value)) return 12;
  return 1;
}

function recurringDateForMonth(recurring, month) {
  if (!recurring || recurring.active === false || String(recurring.active).toLowerCase() === "false") return null;
  if (Number(recurring.amount || 0) <= 0) return null;

  const startDate = dateOnly(recurring.start_date || recurring.first_payment_date || recurring.created_at || todayISO());
  const startMonth = String(startDate || todayISO()).slice(0, 7);
  const targetIndex = monthIndexFromKey(month);
  const startIndex = monthIndexFromKey(startMonth);
  const monthDiff = targetIndex - startIndex;
  if (monthDiff < 0) return null;

  const step = recurringFrequencyStep(recurring.frequency);
  if (monthDiff % step !== 0) return null;

  const endDate = dateOnly(recurring.end_date || recurring.last_payment_date || "");
  if (endDate && targetIndex > monthIndexFromKey(endDate.slice(0, 7))) return null;

  const endMode = String(recurring.end_mode || "indefinite").toLowerCase();
  const fixedMonths = Number(recurring.fixed_months || 0);
  const fixedYears = Number(recurring.fixed_years || 0);
  if (endMode === "months" && fixedMonths > 0 && monthDiff >= fixedMonths) return null;
  if (endMode === "years" && fixedYears > 0 && monthDiff >= fixedYears * 12) return null;

  const day = clampDayForMonth(month, recurring.day_of_month || 1);
  let chargeDate = `${month}-${day}`;
  if (month === startMonth && chargeDate < startDate) chargeDate = startDate;
  if (endDate && chargeDate > endDate) return null;
  return chargeDate;
}

function recurringInstanceHasRealMovement(recurring, month, amount) {
  const memberId = recurring.member_id || recurring.user_id;
  const recurringText = normalizeComparableText(recurring.description || recurring.notes || "");
  return state.movements.some(movement => {
    if (!isSameMonth(movement.date, month)) return false;
    if (movement.type !== recurring.type) return false;
    const movementMember = movement.member_id || movement.user_id;
    if (memberId && movementMember && movementMember !== memberId) return false;
    if (Math.abs(Number(movement.amount || 0) - Number(amount || 0)) > 0.01) return false;
    const sameCategory = Boolean(recurring.category_id) && movement.category_id === recurring.category_id;
    const movementText = normalizeComparableText([movement.description, movement.notes].filter(Boolean).join(" "));
    const textMatches = recurringText && movementText && (movementText.includes(recurringText) || recurringText.includes(movementText));
    return sameCategory || textMatches;
  });
}

function recurringMovementAsMovement(recurring, month) {
  const date = recurringDateForMonth(recurring, month);
  if (!date) return null;
  const amount = Number(recurring.amount || 0);
  if (recurringInstanceHasRealMovement(recurring, month, amount)) return null;

  const type = recurring.type === "income" ? "income" : "expense";
  const memberId = recurring.member_id || recurring.user_id || state.user?.id || null;
  const frequencyLabel = {
    monthly: "mensual",
    bimonthly: "bimensual",
    yearly: "anual"
  }[String(recurring.frequency || "monthly").toLowerCase()] || String(recurring.frequency || "mensual");

  return {
    id: `recurring:${recurring.id}:${month}`,
    _source: "recurring",
    _recurring_id: recurring.id,
    _generated: true,
    household_id: recurring.household_id,
    user_id: recurring.user_id || memberId,
    member_id: memberId,
    type,
    category_id: recurring.category_id || null,
    amount,
    date,
    description: recurring.description || (type === "income" ? "Ingreso recurrente" : "Gasto recurrente"),
    notes: ["Movimiento proyectado desde recurrentes", frequencyLabel, recurring.notes].filter(Boolean).join(" · "),
    kind: recurring.kind || "recurring",
    share_method: recurring.share_method || "equal",
    is_shared: Boolean(recurring.is_shared),
    created_at: recurring.created_at
  };
}

function recurringMovementsAsMovements(months = recurringViewMonthKeys()) {
  return visibleRecurringItems()
    .flatMap(recurring => months.map(month => recurringMovementAsMovement(recurring, month)))
    .filter(Boolean);
}

function financialMovements(base = state.movements) {
  const movements = [...base];
  return base === state.movements
    ? [...movements, ...vehicleRecordsAsMovements(), ...recurringMovementsAsMovements()]
    : movements;
}

function getVisibleMovements(base = state.movements) {
  const items = financialMovements(base);
  if (isAdmin()) return items;
  return items.filter(x => x.user_id === state.user?.id || x.member_id === state.user?.id || x.is_shared);
}

function movementSortValue(movement, field = state.filters.sortField) {
  if (field === "amount") return Number(movement.amount || 0);
  if (field === "type") return movement.type === "income" ? 1 : 0;
  if (field === "category") return categoryName(movement.category_id).toLowerCase();
  if (field === "member") return memberName(movement.member_id || movement.user_id).toLowerCase();
  if (field === "concept") return String(movement.description || movement.notes || "").toLowerCase();
  return dateOnly(movement.date || movement.created_at || "");
}

function sortMovementItems(items = []) {
  const field = state.filters.sortField || "date";
  const direction = state.filters.sortDirection === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const av = movementSortValue(a, field);
    const bv = movementSortValue(b, field);
    if (typeof av === "number" || typeof bv === "number") return ((Number(av) || 0) - (Number(bv) || 0)) * direction;
    const result = String(av).localeCompare(String(bv), "es", { numeric: true, sensitivity: "base" });
    return result * direction;
  });
}

function getMovementsFiltered() {
  let items = getVisibleMovements();
  if (state.filters.month) items = items.filter(x => isSameMonth(x.date));
  if (state.filters.movementType !== "all") items = items.filter(x => x.type === state.filters.movementType);
  if (state.filters.category && state.filters.category !== "all") items = items.filter(x => x.category_id === state.filters.category);
  if (state.filters.search) items = items.filter(x => movementMatchesText(x, state.filters.search));
  return sortMovementItems(applyPersonFilterWithSharedAllocation(items, state.filters.person));
}

function metricsFor(items) {
  const incomes = items.filter(x => x.type === "income");
  const expenses = items.filter(x => x.type === "expense");
  const totalIncome = sum(incomes, x => x.amount);
  const totalExpense = sum(expenses, x => x.amount);
  const sharedExpense = sum(expenses.filter(x => x.is_shared), x => x.amount);
  const balance = totalIncome - totalExpense;
  return { incomes, expenses, totalIncome, totalExpense, sharedExpense, balance };
}

async function withError(promise, successMessage) {
  const { data, error } = await promise;
  if (error) {
    console.error(error);
    showToast(error.message || "Ocurrió un error", "danger");
    throw error;
  }
  if (successMessage) showToast(successMessage, "ok");
  return data;
}

async function insertWithSchemaFallback(table, payload, successMessage, fallbackFields = []) {
  const { data, error } = await supabase.from(table).insert(payload);
  if (!error) {
    if (successMessage) showToast(successMessage, "ok");
    return data;
  }

  const raw = String(error.message || "").toLowerCase();
  const looksLikeMissingTable = raw.includes("relation") && raw.includes("does not exist");
  if (looksLikeMissingTable) {
    console.error(error);
    showToast(`Falta la tabla ${table}. Ejecuta los archivos SQL de actualización en Supabase.`, "danger");
    throw error;
  }
  const looksLikeMissingColumn = raw.includes("column") || raw.includes("schema cache") || raw.includes("could not find") || raw.includes("does not exist");
  if (looksLikeMissingColumn && fallbackFields.length) {
    const fallback = {};
    fallbackFields.forEach(key => {
      if (Object.prototype.hasOwnProperty.call(payload, key)) fallback[key] = payload[key];
    });
    const retry = await supabase.from(table).insert(fallback);
    if (!retry.error) {
      console.warn(`Insert ${table} guardado con esquema base. Ejecuta los upgrades SQL para activar todos los campos.`, error.message);
      if (successMessage) showToast(`${successMessage} Revisa SQL upgrades si faltan campos avanzados.`, "ok");
      return retry.data;
    }
    console.error(retry.error);
    showToast(retry.error.message || "Ocurrió un error", "danger");
    throw retry.error;
  }

  console.error(error);
  showToast(error.message || "Ocurrió un error", "danger");
  throw error;
}


async function updateWithSchemaFallback(table, payload, filters, successMessage, fallbackFields = []) {
  const runUpdate = async (body) => {
    let query = supabase.from(table).update(body);
    Object.entries(filters || {}).forEach(([key, value]) => { query = query.eq(key, value); });
    return await query;
  };

  const { data, error } = await runUpdate(payload);
  if (!error) {
    if (successMessage) showToast(successMessage, "ok");
    return data;
  }

  const raw = String(error.message || "").toLowerCase();
  const looksLikeMissingColumn = raw.includes("column") || raw.includes("schema cache") || raw.includes("could not find") || raw.includes("does not exist");
  if (looksLikeMissingColumn && fallbackFields.length) {
    const fallback = {};
    fallbackFields.forEach(key => {
      if (Object.prototype.hasOwnProperty.call(payload, key)) fallback[key] = payload[key];
    });
    const retry = await runUpdate(fallback);
    if (!retry.error) {
      console.warn(`Update ${table} guardado con esquema base. Ejecuta los upgrades SQL para activar todos los campos.`, error.message);
      if (successMessage) showToast(`${successMessage} Revisa SQL upgrades si faltan campos avanzados.`, "ok");
      return retry.data;
    }
    console.error(retry.error);
    showToast(retry.error.message || "Ocurrió un error", "danger");
    throw retry.error;
  }

  console.error(error);
  showToast(error.message || "Ocurrió un error", "danger");
  throw error;
}

function setFormField(form, name, value) {
  const field = form?.elements?.[name];
  if (!field) return;
  if (field.type === "checkbox") {
    field.checked = value === true || value === "true" || value === 1 || value === "1";
    return;
  }
  field.value = value ?? "";
}

function setSelectField(form, name, value) {
  const field = form?.elements?.[name];
  if (!field) return;
  const raw = value ?? "";
  if (raw && ![...field.options].some(option => String(option.value) === String(raw))) {
    field.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(raw)}">${escapeHtml(raw)}</option>`);
  }
  field.value = raw;
}

async function init() {
  if (!isSupabaseConfigured()) {
    app.innerHTML = document.getElementById("config-warning-template").innerHTML;
    return;
  }
  const { data } = await supabase.auth.getSession();
  state.session = data.session;
  state.user = data.session?.user || null;

  supabase.auth.onAuthStateChange(async (_event, session) => {
    state.session = session;
    state.user = session?.user || null;
    if (state.user) await loadWorkspace();
    render();
  });

  if (state.user) await loadWorkspace();
  render();
}

async function loadWorkspace() {
  await ensureProfile();
  await loadPendingInvitations();
  await loadHouseholds();
  if (!state.currentHouseholdId && state.households.length) state.currentHouseholdId = state.households[0].id;
  if (state.currentHouseholdId) await loadHouseholdData();
}

async function ensureProfile() {
  const metaName = state.user.user_metadata?.full_name || state.user.email?.split("@")[0] || "Usuario";
  await supabase.from("profiles").upsert({ user_id: state.user.id, email: state.user.email, full_name: metaName }, { onConflict: "user_id" });
  const { data, error } = await supabase.from("profiles").select("*").eq("user_id", state.user.id).single();
  if (!error) state.profile = data;
}

async function loadPendingInvitations() {
  const { data, error } = await supabase.from("invitations").select("*, households(name)").eq("status", "pending").order("created_at", { ascending: false });
  if (!error) state.pendingInvitations = data || [];
}

async function loadHouseholds() {
  const { data, error } = await supabase.from("households").select("*").order("created_at", { ascending: true });
  if (error) {
    console.error(error);
    state.households = [];
    return;
  }
  state.households = data || [];
  if (state.currentHouseholdId && !state.households.some(h => h.id === state.currentHouseholdId)) state.currentHouseholdId = state.households[0]?.id || null;
}

async function safeSelect(table, queryBuilder, fallback = []) {
  const { data, error } = await queryBuilder;
  if (error) {
    console.warn(`No se pudo cargar ${table}:`, error.message);
    return fallback;
  }
  return data || fallback;
}

async function loadHouseholdData() {
  const householdId = state.currentHouseholdId;
  const [members, permissions, categories, movements, goals, vehicles, invitations, records, recurring] = await Promise.all([
    safeSelect("household_members", supabase.from("household_members").select("*").eq("household_id", householdId).order("created_at", { ascending: true })),
    safeSelect("permissions", supabase.from("permissions").select("*").eq("household_id", householdId)),
    safeSelect("categories", supabase.from("categories").select("*").eq("household_id", householdId).order("name")),
    safeSelect("movements", supabase.from("movements").select("*").eq("household_id", householdId).order("date", { ascending: false }).order("created_at", { ascending: false })),
    safeSelect("goals", supabase.from("goals").select("*").eq("household_id", householdId).order("created_at", { ascending: false })),
    safeSelect("vehicles", supabase.from("vehicles").select("*").eq("household_id", householdId).order("created_at", { ascending: false })),
    safeSelect("invitations", supabase.from("invitations").select("*").eq("household_id", householdId).order("created_at", { ascending: false })),
    safeSelect("vehicle_records", supabase.from("vehicle_records").select("*").eq("household_id", householdId).order("date", { ascending: false })),
    safeSelect("recurring_movements", supabase.from("recurring_movements").select("*").eq("household_id", householdId).order("created_at", { ascending: false }))
  ]);

  state.members = uniqueMembers(members);
  state.currentMember = state.members.find(m => m.user_id === state.user.id && isActiveMember(m)) || state.members.find(m => m.user_id === state.user.id) || null;
  state.permissions = permissions;
  enforceMemberPrivacyScope();
  state.categories = categories;
  state.movements = movements;
  state.goals = goals;
  state.vehicles = vehicles;
  state.invitations = invitations;
  state.vehicleRecords = records;
  state.recurring = recurring;

  const userIds = [...new Set(state.members.map(m => m.user_id).filter(Boolean))];
  if (userIds.length) {
    const { data: profiles } = await supabase.from("profiles").select("*").in("user_id", userIds);
    state.profilesByUserId = Object.fromEntries((profiles || []).map(p => [p.user_id, p]));
  } else {
    state.profilesByUserId = {};
  }
}

function render() {
  if (!state.user) return renderAuth();
  if (state.pendingInvitations.length && !state.households.length) return renderInvitationLanding();
  if (!state.households.length) return renderCreateHousehold();
  renderApp();
}

function passwordFieldHtml(name = "password", placeholder = "mínimo 6 caracteres") {
  return `
    <div class="field password-field">
      <label>Contraseña</label>
      <div class="password-wrap">
        <input name="${name}" type="password" placeholder="${escapeHtml(placeholder)}" autocomplete="current-password" required minlength="6" />
        <button type="button" class="password-toggle" aria-label="Ver contraseña" title="Ver contraseña">👁️</button>
      </div>
    </div>`;
}

function renderAuth() {
  app.className = "app-shell";
  app.innerHTML = `
    <section class="auth-wrap">
      <div class="auth-hero">
        <div class="brand-logo">F3</div>
        <h1>Finanzas 360 Real.</h1>
      </div>
      <div class="auth-card">
        <div class="auth-tabs">
          <button class="btn ${state.authMode === "login" ? "active dark" : "ghost"}" data-auth-mode="login" type="button">Entrar</button>
          <button class="btn ${state.authMode === "signup" ? "active dark" : "ghost"}" data-auth-mode="signup" type="button">Crear cuenta</button>
        </div>
        <form id="authForm">
          ${state.authMode === "signup" ? `<div class="field"><label>Nombre</label><input name="full_name" placeholder="Ej. Alberto" autocomplete="name" required /></div>` : ""}
          <div class="field"><label>Email</label><input name="email" type="email" placeholder="correo@dominio.com" autocomplete="email" required /></div>
          ${passwordFieldHtml("password")}
          <button class="btn primary block" type="submit">${state.authMode === "login" ? "Entrar a mi hogar" : "Crear mi usuario"}</button>
          <div id="authMessage" class="auth-message" role="alert" aria-live="polite" ${state.authError ? "" : "hidden"}>${escapeHtml(state.authError)}</div>
        </form>
        <p class="hint">La primera persona que crea el hogar queda como administrador. Luego puede invitar familiares y definir permisos.</p>
      </div>
    </section>
  `;
  $$('[data-auth-mode]').forEach(btn => btn.addEventListener("click", () => { state.authMode = btn.dataset.authMode; state.authError = ""; renderAuth(); }));
  bindPasswordToggles();
  $("#authForm").addEventListener("submit", handleAuth);
}

function bindPasswordToggles() {
  $$(".password-toggle").forEach(btn => btn.addEventListener("click", () => {
    const input = btn.closest(".password-wrap")?.querySelector("input");
    if (!input) return;
    input.type = input.type === "password" ? "text" : "password";
    btn.textContent = input.type === "password" ? "👁️" : "🙈";
  }));
}

async function handleAuth(event) {
  event.preventDefault();
  clearAuthError();

  const form = event.currentTarget;
  const submitBtn = form.querySelector('button[type="submit"]');
  const f = new FormData(form);
  const email = String(f.get("email") || "").trim().toLowerCase();
  const password = String(f.get("password") || "");

  if (!email || !password) {
    return setAuthError("Coloca tu correo y tu contraseña para poder entrar.");
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.dataset.originalText = submitBtn.textContent;
    submitBtn.textContent = state.authMode === "login" ? "Validando…" : "Creando…";
  }

  try {
    if (state.authMode === "signup") {
      const fullName = String(f.get("full_name") || "").trim();
      const { error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName } } });
      if (error) return setAuthError(friendlyAuthMessage(error, "signup"));
      showToast("Usuario creado. Si Supabase pide confirmar correo, revisa Gmail. Luego entra con tu usuario.", "ok");
      state.authMode = "login";
      state.authError = "";
      renderAuth();
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return setAuthError(friendlyAuthMessage(error, "login"));
      clearAuthError();
      showToast("Sesión iniciada.", "ok");
    }
  } catch (error) {
    setAuthError(friendlyAuthMessage(error, state.authMode));
  } finally {
    if (submitBtn && document.body.contains(submitBtn)) {
      submitBtn.disabled = false;
      submitBtn.textContent = submitBtn.dataset.originalText || (state.authMode === "login" ? "Entrar a mi hogar" : "Crear mi usuario");
    }
  }
}

function renderInvitationLanding() {
  app.className = "app-shell";
  app.innerHTML = `
    <section class="setup-warning">
      <div class="brand-logo">F3</div>
      <h1>Tienes invitaciones pendientes</h1>
      <p>Elige el hogar al que quieres entrar.</p>
      <div class="form-grid" style="margin-top:16px">
        ${state.pendingInvitations.map(i => `<article class="section-card"><h4>${escapeHtml(i.households?.name || "Hogar")}</h4><p class="sub">Rol: ${escapeHtml(i.role)}</p><button class="btn primary" data-accept-invite="${i.id}">Aceptar invitación</button></article>`).join("")}
      </div>
      <button class="btn ghost" id="logoutBtn" style="margin-top:14px">Salir</button>
    </section>`;
  bindCommonActions();
}

function renderCreateHousehold() {
  app.className = "app-shell";
  app.innerHTML = `
    <section class="setup-warning">
      <div class="brand-logo">F3</div>
      <h1>Crea tu hogar financiero</h1>
      <p>Este será el espacio principal donde se guardan movimientos, gastos de casa, miembros, vehículos, metas y permisos.</p>
      <form id="householdForm" style="margin-top:18px">
        <div class="field"><label>Nombre del hogar</label><input name="name" required placeholder="Ej. Familia Fernández" /></div>
        <button class="btn primary block" type="submit">Crear hogar y entrar como admin</button>
        <button class="btn ghost block" type="button" id="logoutBtn">Salir</button>
      </form>
    </section>`;
  $("#householdForm").addEventListener("submit", createHousehold);
  $("#logoutBtn")?.addEventListener("click", () => supabase.auth.signOut());
}

async function createHousehold(event) {
  event.preventDefault();
  const name = new FormData(event.currentTarget).get("name");
  const household = await withError(supabase.from("households").insert({ name, owner_id: state.user.id }).select("*").single(), "Hogar creado.");
  state.currentHouseholdId = household.id;
  await loadWorkspace();
  renderApp();
}

function renderApp() {
  app.className = "app app-sidebar";
  const currentHousehold = getCurrentHousehold();
  const modules = visibleModules();
  app.innerHTML = `
    <aside class="side-nav" aria-label="Menú principal">
      <div class="side-brand">
        <div class="brand-logo">F3</div>
        <div><h1>Finanzas 360 Real</h1><span>${escapeHtml(currentHousehold?.name || "Hogar")}</span></div>
      </div>
      ${state.households.length > 1 ? `<div class="field"><label>Hogar activo</label><select id="householdSwitcher">${state.households.map(h => `<option value="${h.id}" ${h.id === state.currentHouseholdId ? "selected" : ""}>${escapeHtml(h.name)}</option>`).join("")}</select></div>` : ""}
      <nav class="nav side-menu">
        ${modules.map(m => `<button type="button" class="${state.activeSection === m.key ? "active" : ""}" data-section="${m.key}"><span>${m.icon}</span><b>${m.label}</b></button>`).join("")}
      </nav>
      <div class="side-footer">
        <div class="side-user"><strong>${escapeHtml(state.profile?.full_name || state.user.email)}</strong><span>${escapeHtml(state.currentMember?.role || "usuario")}</span></div>
        <button class="btn ghost small" id="refreshBtn">↻ Actualizar</button>
        <button class="btn danger small" id="logoutBtn">Salir</button>
      </div>
    </aside>
    <main class="content-area">
      ${renderSection()}
    </main>
  `;
  bindCommonActions();
  bindSectionActions();
}

function renderSection() {
  const section = can(state.activeSection, "view") || state.activeSection === "dashboard" ? state.activeSection : "dashboard";
  if (section === "dashboard") return renderDashboard();
  if (section === "register") return renderRegister();
  if (section === "movements") return renderMovements();
  if (section === "recurring") return renderRecurring();
  if (section === "household") return renderHousehold();
  if (section === "categories") return renderCategories();
  if (section === "goals") return renderGoals();
  if (section === "vehicles") return renderVehicles();
  if (section === "reports") return renderReports();
  if (section === "history") return renderHistory();
  if (section === "backup") return renderBackup();
  if (section === "admin") return renderAdmin();
  return renderDashboard();
}

function renderFilters(extra = "") {
  return `
    <div class="filters command-bar">
      <div class="field"><label>Mes activo</label><input id="filterMonth" type="month" value="${escapeHtml(state.filters.month)}" /></div>
      <div class="field"><label>Vista</label><select id="filterPerson">${filterPersonOptions()}</select></div>
      ${extra}
    </div>
  `;
}

function renderDashboard() {
  const items = getMovementsFiltered();
  const metrics = metricsFor(items);
  const byCategory = getExpenseCategories(items).slice(0, 7);
  const recent = items.slice(0, 8);
  const recurringActive = visibleRecurringItems().filter(r => r.active !== false).length;
  const vehicleSpent = vehicleTotalSpent(null, activeYear());
  const savingsRate = metrics.totalIncome ? Math.round((metrics.balance / metrics.totalIncome) * 100) : 0;

  return `
    <section class="page-head">
      <span class="eyebrow">🛡️ Base de datos real · roles · hogar compartido</span>
      <h2>Panel financiero</h2>
      <p>Controla ingresos, gastos, casa común, vehículos, recurrentes y metas desde una BBDD real.</p>
    </section>
    ${renderFilters(`<div class="field"><label>Tipo</label><select id="filterType"><option value="all" ${state.filters.movementType === "all" ? "selected" : ""}>Todos</option><option value="income" ${state.filters.movementType === "income" ? "selected" : ""}>Ingresos</option><option value="expense" ${state.filters.movementType === "expense" ? "selected" : ""}>Gastos</option></select></div>`)}
    <section class="metrics-grid">
      <article class="metric good"><div class="top"><small>Ingresos</small><span class="icon">↗</span></div><strong>${money(metrics.totalIncome)}</strong><em>${metrics.incomes.length} registros</em></article>
      <article class="metric bad"><div class="top"><small>Gastos</small><span class="icon">↘</span></div><strong>${money(metrics.totalExpense)}</strong><em>${metrics.expenses.length} registros</em></article>
      <article class="metric warn"><div class="top"><small>Casa común</small><span class="icon">🏠</span></div><strong>${money(metrics.sharedExpense)}</strong><em>Gastos compartidos</em></article>
      <article class="metric ${metrics.balance >= 0 ? "good" : "bad"}"><div class="top"><small>Balance</small><span class="icon">=</span></div><strong>${money(metrics.balance)}</strong><em>${savingsRate}% de ahorro</em></article>
      <article class="metric"><div class="top"><small>Recurrentes</small><span class="icon">🔁</span></div><strong>${recurringActive}</strong><em>Pagos activos</em></article>
      <article class="metric"><div class="top"><small>Vehículos año</small><span class="icon">🚘</span></div><strong>${money(vehicleSpent)}</strong><em>${activeYear()}</em></article>
    </section>
    <section class="grid-2">
      <article class="section-card dark-panel">
        <h4>Gastos por categoría</h4>
        <p class="sub">Top de gastos del periodo activo.</p>
        <div class="form-grid">
          ${byCategory.length ? byCategory.map(c => {
            const pct = metrics.totalExpense ? Math.min(100, Math.round((c.total / metrics.totalExpense) * 100)) : 0;
            return `<div class="progress-row"><div class="progress-meta"><span>${escapeHtml(c.name)}</span><strong>${money(c.total)}</strong></div><div class="bar"><span style="width:${pct}%"></span></div></div>`;
          }).join("") : `<div class="empty-state"><strong>Sin gastos todavía</strong>Registra movimientos para ver el análisis.</div>`}
        </div>
      </article>
      <article class="section-card">
        <h4>Últimos movimientos</h4>
        <p class="sub">Lo más reciente cargado en la BBDD.</p>
        ${renderMovementTable(recent, false)}
      </article>
    </section>
    <section class="grid-2">
      <article class="section-card">${renderHouseholdMini()}</article>
      <article class="section-card">${renderVehicleMini()}</article>
    </section>
  `;
}

function getExpenseCategories(items = getMovementsFiltered()) {
  return Object.values(items.filter(x => x.type === "expense").reduce((acc, x) => {
    const name = categoryName(x.category_id);
    acc[name] ||= { name, total: 0, count: 0 };
    acc[name].total += Number(x.amount || 0);
    acc[name].count += 1;
    return acc;
  }, {})).sort((a, b) => b.total - a.total);
}

function renderRegister() {
  return `
    <section class="page-head"><h2>Registrar</h2><p>Carga ingresos, gastos personales, gastos comunes del hogar o pagos rápidos.</p></section>
    <section class="grid-main">
      <article class="section-card">
        <h4>Nuevo ingreso / gasto</h4>
        <form id="movementForm">
          <div class="inline-grid"><div class="field"><label>Tipo</label><select name="type" required><option value="expense">Gasto</option><option value="income">Ingreso</option></select></div><div class="field"><label>Monto</label><input name="amount" type="number" step="0.01" min="0" required placeholder="0,00" /></div></div>
          <div class="inline-grid"><div class="field"><label>Fecha</label><input name="date" type="date" value="${todayISO()}" required /></div><div class="field"><label>Categoría</label><select name="category_id">${categoryOptions()}</select></div></div>
          ${canSeeAll() ? `<div class="field"><label>Asignar a integrante</label><select name="member_id">${memberOptions(state.user.id)}</select></div>` : `<input type="hidden" name="member_id" value="${state.user.id}" />`}
          <div class="field"><label>Descripción</label><textarea name="description" placeholder="Ej. Mercado, nómina, gasolina, alquiler..."></textarea></div>
          <label class="switch-row"><span><strong>Movimiento común del hogar</strong><br><span class="hint">Úsalo para alquiler, comida, luz, agua, gas, internet, comunidad, etc.</span></span><input name="is_shared" type="checkbox" /></label>
          <button class="btn primary" type="submit">Guardar en BBDD</button>
        </form>
      </article>
      <article class="section-card dark-panel">
        <h4>Guía rápida</h4>
        <div class="guide-steps single">
          <div class="guide-step-card"><span class="step-marker">1</span><div><b>Datos personales</b><span>Cada usuario registra lo suyo con su cuenta.</span></div></div>
          <div class="guide-step-card"><span class="step-marker">2</span><div><b>Gastos comunes</b><span>Marca compartido para casa, comida, servicios o alquiler.</span></div></div>
          <div class="guide-step-card"><span class="step-marker">3</span><div><b>Admin</b><span>Puede ver todo o filtrar por integrante.</span></div></div>
        </div>
      </article>
    </section>
  `;
}

function renderMovements() {
  const extra = `<div class="field"><label>Tipo</label><select id="filterType"><option value="all" ${state.filters.movementType === "all" ? "selected" : ""}>Todos</option><option value="income" ${state.filters.movementType === "income" ? "selected" : ""}>Ingresos</option><option value="expense" ${state.filters.movementType === "expense" ? "selected" : ""}>Gastos</option></select></div>`;
  const items = getMovementsFiltered();
  return `<section class="page-head"><h2>Movimientos</h2><p>Consulta, filtra, edita y elimina según tus permisos.</p></section><article class="section-card">${renderFilters(extra)}${renderMovementTable(items, true)}</article>`;
}

function renderMovementTable(items, actions = true) {
  if (!items.length) return `<div class="empty-state"><strong>No hay movimientos</strong>Cuando alguien registre datos, aparecerán aquí.</div>`;
  return `
    <div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Tipo</th><th>Concepto</th><th>Categoría</th><th>Persona</th><th>Importe</th>${actions ? "<th>Acciones</th>" : ""}</tr></thead><tbody>
      ${items.map(x => {
        const isVehicle = x._source === "vehicle";
        const isRecurring = x._source === "recurring";
        const typeLabel = isVehicle ? "Vehículo" : isRecurring ? (x.type === "income" ? "Ingreso recurrente" : "Gasto recurrente") : x.type === "income" ? "Ingreso" : "Gasto";
        const typeClass = x.type === "income" ? "income" : "expense";
        let actionCell = "";
        if (actions) {
          if (isVehicle) {
            const record = state.vehicleRecords.find(r => r.id === x._vehicle_record_id);
            actionCell = canManageVehicleRecord(record)
              ? `<td><div class="td-actions"><button class="btn small" data-edit-vehicle-record="${x._vehicle_record_id}">Editar</button><button class="btn small" data-section="vehicles">Ver vehículo</button><button class="btn small danger" data-delete-vehicle-record="${x._vehicle_record_id}">Borrar</button></div></td>`
              : `<td><span class="hint">Solo lectura</span></td>`;
          } else if (isRecurring) {
            const recurring = state.recurring.find(r => r.id === x._recurring_id);
            actionCell = canManageRecurringRecord(recurring)
              ? `<td><div class="td-actions"><button class="btn small" data-edit-recurring="${x._recurring_id}">Editar plan</button><button class="btn small" data-section="register">Ver automático</button><button class="btn small danger" data-delete-recurring="${x._recurring_id}">Borrar automático</button></div></td>`
              : `<td><span class="hint">Solo lectura</span></td>`;
          } else {
            const sourceMovement = state.movements.find(m => m.id === x.id) || x;
            actionCell = canManageMovementRecord(sourceMovement)
              ? `<td><div class="td-actions"><button class="btn small" data-edit-movement="${x.id}">Editar</button><button class="btn small danger" data-delete-movement="${x.id}">Borrar</button></div></td>`
              : `<td><span class="hint">Solo lectura</span></td>`;
          }
        }
        return `<tr><td>${escapeHtml(dateOnly(x.date))}</td><td><span class="tag ${typeClass}">${typeLabel}</span>${x.is_shared ? ` <span class="tag neutral">Común</span>` : ""}${isRecurring ? ` <span class="tag neutral">Auto</span>` : ""}</td><td>${escapeHtml(x.description || "Sin descripción")}</td><td>${escapeHtml(categoryName(x.category_id))}</td><td>${escapeHtml(memberName(x.member_id || x.user_id))}</td><td><strong>${money(x.amount)}</strong></td>${actionCell}</tr>`;
      }).join("")}
    </tbody></table></div>`;
}

function renderRecurring() {
  return `
    <section class="page-head"><h2>Recurrentes</h2><p>Pagos automáticos como nómina, alquiler, comida de mascota, suscripciones, seguros o servicios.</p></section>
    <section class="grid-main">
      <article class="section-card">
        <h4>Nuevo recurrente</h4>
        <form id="recurringForm">
          <div class="inline-grid"><div class="field"><label>Tipo</label><select name="type"><option value="expense">Gasto</option><option value="income">Ingreso</option></select></div><div class="field"><label>Monto</label><input name="amount" type="number" step="0.01" min="0" required /></div></div>
          <div class="inline-grid"><div class="field"><label>Día del mes</label><input name="day_of_month" type="number" min="1" max="31" value="1" /></div><div class="field"><label>Categoría</label><select name="category_id">${categoryOptions()}</select></div></div>
          ${canSeeAll() ? `<div class="field"><label>Responsable</label><select name="member_id">${memberOptions(state.user.id)}</select></div>` : `<input type="hidden" name="member_id" value="${state.user.id}" />`}
          <div class="field"><label>Concepto</label><input name="description" placeholder="Ej. Nómina DirectMarkt, alquiler, Netflix..." required /></div>
          <label class="switch-row"><span><strong>Compartido</strong><br><span class="hint">Actívalo si este pago pertenece al hogar.</span></span><input name="is_shared" type="checkbox" /></label>
          <button class="btn primary" type="submit">Guardar recurrente</button>
        </form>
      </article>
      <article class="section-card">
        <h4>Recurrentes activos</h4>
        ${visibleRecurringItems().length ? `<div class="table-wrap"><table><thead><tr><th>Concepto</th><th>Tipo</th><th>Día</th><th>Persona</th><th>Monto</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${visibleRecurringItems().map(r => { const actions = canManageRecurringRecord(r) ? `<button class="btn small danger" data-delete-recurring="${r.id}">Borrar</button>` : `<span class="hint">Solo lectura</span>`; return `<tr><td>${escapeHtml(r.description)}</td><td>${r.type === "income" ? "Ingreso" : "Gasto"}</td><td>${escapeHtml(r.day_of_month || "-")}</td><td>${escapeHtml(memberName(r.member_id || r.user_id))}</td><td><strong>${money(r.amount)}</strong></td><td>${r.active === false ? "Pausado" : "Activo"}</td><td>${actions}</td></tr>`; }).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>Sin recurrentes</strong>Agrega pagos fijos para tener proyección mensual.</div>`}
      </article>
    </section>`;
}

function renderHousehold() {
  const items = getVisibleMovements().filter(x => isSameMonth(x.date));
  const metrics = metricsFor(items);
  return `
    <section class="page-head"><h2>Casa común y aportes</h2><p>Quién ingresa, quién paga, qué parte corresponde a cada persona y cuánto queda disponible.</p></section>
    ${renderFilters(`<div></div>`)}
    <section class="metrics-grid">
      <article class="metric"><div class="top"><small>Integrantes</small><span class="icon">👥</span></div><strong>${state.members.length}</strong><em>Usuarios del hogar</em></article>
      <article class="metric warn"><div class="top"><small>Gastos comunes</small><span class="icon">🏠</span></div><strong>${money(metrics.sharedExpense)}</strong><em>Mes activo</em></article>
      <article class="metric good"><div class="top"><small>Ingresos hogar</small><span class="icon">↗</span></div><strong>${money(metrics.totalIncome)}</strong><em>Visibles</em></article>
      <article class="metric ${metrics.balance >= 0 ? "good" : "bad"}"><div class="top"><small>Balance hogar</small><span class="icon">=</span></div><strong>${money(metrics.balance)}</strong><em>Mes activo</em></article>
    </section>
    <section class="grid-2">
      <article class="section-card"><h4>Resumen por persona</h4><p class="sub">Ingresos, gastos personales, parte común y ahorro estimado.</p>${renderMemberContributions(items)}</article>
      <article class="section-card"><h4>Gastos comunes del mes</h4><p class="sub">Gastos marcados como compartidos.</p>${renderCommonExpenses(items)}</article>
    </section>
    <article class="section-card"><h4>Lectura rápida</h4>${renderHouseholdInsights(items)}</article>`;
}

function renderHouseholdMini() {
  const items = getVisibleMovements().filter(x => isSameMonth(x.date));
  const shared = sum(items.filter(x => x.type === "expense" && x.is_shared), x => x.amount);
  return `<h4>Casa común</h4><p class="sub">Resumen del mes activo.</p><div class="mini-list"><div><span>Gastos compartidos</span><strong>${money(shared)}</strong></div><div><span>Integrantes</span><strong>${state.members.length}</strong></div></div>`;
}

function renderMemberContributions(items) {
  const members = state.members.length ? state.members : [{ user_id: state.user.id }];
  const sharedExpense = sum(items.filter(x => x.type === "expense" && x.is_shared), x => x.amount);
  const activeCount = Math.max(1, members.length);
  const equalShare = sharedExpense / activeCount;
  return `<div class="advice-list">${members.map(m => {
    const userId = m.user_id;
    const income = sum(items.filter(x => x.type === "income" && (x.member_id === userId || x.user_id === userId)), x => x.amount);
    const personalExpense = sum(items.filter(x => x.type === "expense" && !x.is_shared && (x.member_id === userId || x.user_id === userId)), x => x.amount);
    const balance = income - personalExpense - equalShare;
    return `<article class="advice ${balance >= 0 ? "ok" : "danger"}"><span class="badge">${balance >= 0 ? "✓" : "!"}</span><div><b>${escapeHtml(memberName(userId))}</b><p>Ingresos: ${money(income)} · Gastos propios: ${money(personalExpense)} · Parte común estimada: ${money(equalShare)} · Disponible: <strong>${money(balance)}</strong></p></div></article>`;
  }).join("")}</div>`;
}

function renderCommonExpenses(items) {
  const common = items.filter(x => x.type === "expense" && x.is_shared);
  if (!common.length) return `<div class="empty-state"><strong>Sin gastos comunes</strong>Marca un movimiento como común para que aparezca aquí.</div>`;
  return `<div class="advice-list">${common.map(x => `<article class="advice"><span class="badge">🏠</span><div><b>${escapeHtml(x.description || categoryName(x.category_id))}</b><p>${escapeHtml(dateOnly(x.date))} · ${escapeHtml(categoryName(x.category_id))} · ${money(x.amount)}</p></div></article>`).join("")}</div>`;
}

function renderHouseholdInsights(items) {
  const metrics = metricsFor(items);
  const warnings = [];
  if (!metrics.totalIncome) warnings.push(["Carga ingresos", "Sin ingresos registrados no hay lectura real del hogar."]);
  if (!metrics.sharedExpense) warnings.push(["Marca gastos comunes", "Alquiler, comida, luz, agua, gas e internet deberían marcarse como compartidos."]);
  if (metrics.balance < 0) warnings.push(["Alerta de caja", "El mes activo está en negativo. Revisa gastos grandes y recurrentes."]);
  if (!warnings.length) warnings.push(["Buen punto de control", "El hogar ya tiene datos suficientes para tomar decisiones."]);
  return `<div class="advice-list">${warnings.map(([title, text]) => `<article class="advice"><span class="badge">💡</span><div><b>${title}</b><p>${text}</p></div></article>`).join("")}</div>`;
}

function renderCategories() {
  return `<section class="page-head"><h2>Categorías</h2><p>Organiza ingresos y gastos para que los reportes sean útiles.</p></section><section class="grid-main"><article class="section-card"><h4>Nueva categoría</h4><form id="categoryForm"><div class="field"><label>Nombre</label><input name="name" required placeholder="Ej. Comida" /></div><div class="inline-grid"><div class="field"><label>Tipo</label><select name="type"><option value="expense">Gasto</option><option value="income">Ingreso</option><option value="both">Ambos</option></select></div><div class="field"><label>Color</label><input name="color" type="color" value="#1677ff" /></div></div><button class="btn primary" type="submit">Crear categoría</button></form></article><article class="section-card"><h4>Categorías guardadas</h4>${state.categories.length ? `<div class="table-wrap"><table><thead><tr><th>Nombre</th><th>Tipo</th><th>Color</th><th>Acciones</th></tr></thead><tbody>${state.categories.map(c => `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.type)}</td><td><span class="tag" style="background:${escapeHtml(c.color || "#1677ff")};color:white">${escapeHtml(c.color || "")}</span></td><td><button class="btn small danger" data-delete-category="${c.id}">Borrar</button></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>Sin categorías</strong>Crea tus primeras categorías.</div>`}</article></section>`;
}

function renderGoals() {
  return `<section class="page-head"><h2>Metas</h2><p>Metas personales o del hogar, según permisos.</p></section><section class="grid-main"><article class="section-card"><h4>Nueva meta</h4><form id="goalForm"><div class="field"><label>Nombre</label><input name="name" required placeholder="Ej. Entrada hipoteca" /></div><div class="inline-grid"><div class="field"><label>Objetivo</label><input name="target_amount" type="number" step="0.01" required /></div><div class="field"><label>Actual</label><input name="current_amount" type="number" step="0.01" value="0" /></div></div><div class="field"><label>Fecha límite</label><input name="deadline" type="date" /></div><button class="btn primary" type="submit">Guardar meta</button></form></article><article class="section-card dark-panel"><h4>Metas activas</h4><div class="form-grid">${state.goals.length ? state.goals.map(g => { const pct = g.target_amount ? Math.min(100, Math.round((Number(g.current_amount || 0) / Number(g.target_amount)) * 100)) : 0; return `<div class="progress-row"><div class="progress-meta"><strong>${escapeHtml(g.name)}</strong><span>${pct}%</span></div><div class="bar"><span style="width:${pct}%"></span></div><div class="progress-meta"><span>${money(g.current_amount)} / ${money(g.target_amount)}</span><button class="btn small danger" data-delete-goal="${g.id}">Borrar</button></div></div>`; }).join("") : `<div class="empty-state"><strong>Sin metas</strong>Agrega una meta para hacer seguimiento.</div>`}</div></article></section>`;
}

function vehicleTypeIcon(type) {
  return type === "motorcycle" ? "🏍️" : type === "van" ? "🚐" : type === "truck" ? "🚚" : type === "other" ? "⚙️" : "🚘";
}
function vehicleTypeLabel(type) {
  return { car: "Coche", motorcycle: "Moto", van: "Furgoneta", truck: "Camión", other: "Otro" }[type] || "Vehículo";
}
function vehicleRecordTypeLabel(type) {
  return { insurance: "Seguro", maintenance: "Mantenimiento", oil: "Aceite", tires: "Neumáticos", itv: "ITV", repair: "Reparación", fuel: "Combustible", tax: "Impuesto", other: "Otro" }[type] || type;
}
function vehicleTotalSpent(vehicleId = null, year = activeYear()) {
  return sum(vehicleRecordsAsMovements().filter(m => (!vehicleId || m._vehicle_id === vehicleId) && isSameYear(m.date, year)), m => m.amount);
}
function vehicleRecordsFor(vehicleId) {
  return visibleVehicleRecordItems().filter(r => r.vehicle_id === vehicleId).sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
function vehicleNextAlerts(limit = 8) {
  const today = new Date(todayISO());
  const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
  const max = addDays(today, 90);
  return visibleVehicleRecordItems().flatMap(r => {
    const vehicle = state.vehicles.find(v => v.id === r.vehicle_id);
    if (!vehicle) return [];
    const dates = [];
    if (r.next_date) dates.push({ label: `Próximo ${vehicleRecordTypeLabel(r.type)}`, date: r.next_date });
    if (r.coverage_end) dates.push({ label: `Vence seguro`, date: r.coverage_end });
    return dates.filter(x => {
      const d = new Date(x.date);
      return !Number.isNaN(d.valueOf()) && d >= today && d <= max;
    }).map(x => ({ ...x, vehicle, record: r }));
  }).sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, limit);
}

function renderVehicleMini() {
  const alerts = vehicleNextAlerts(3);
  return `<h4>Vehículos</h4><p class="sub">${visibleVehicleItems().length} registrados · ${money(vehicleTotalSpent(null, activeYear()))} en ${activeYear()}</p>${alerts.length ? `<div class="advice-list">${alerts.map(a => `<article class="advice warn"><span>!</span><div><b>${escapeHtml(a.label)}</b><p>${escapeHtml(a.vehicle.name)} · ${escapeHtml(dateOnly(a.date))}</p></div></article>`).join("")}</div>` : `<div class="empty-state"><strong>Sin avisos próximos</strong>Todo tranquilo por ahora.</div>`}`;
}

function renderVehicles() {
  const year = activeYear();
  const alerts = vehicleNextAlerts(20);
  const filteredRecords = visibleVehicleRecordItems().filter(r => state.filters.vehicle === "all" || r.vehicle_id === state.filters.vehicle);
  return `
    <section class="page-head"><h2>Vehículos, seguros y mantenimiento</h2><p>Controla coches y motos: seguros anuales, cuotas, revisiones, aceite, neumáticos, repuestos, reparaciones y próximos avisos.</p></section>
    <article class="section-card help-card"><strong>🛠️ Flujo recomendado:</strong> primero registra cada vehículo. Después añade seguros, mantenimientos o repuestos. Los importes se suman al año correspondiente y los avisos se calculan con próximas fechas.</article>
    <section class="metrics-grid vehicle-kpi-grid">
      <article class="metric"><div class="top"><small>Vehículos</small><span class="icon">🚘</span></div><strong>${visibleVehicleItems().length}</strong><em>Coches, motos u otros</em></article>
      <article class="metric warn"><div class="top"><small>Gasto anual</small><span class="icon">€</span></div><strong>${money(vehicleTotalSpent(null, year))}</strong><em>Año ${year}</em></article>
      <article class="metric"><div class="top"><small>Seguros activos</small><span class="icon">🛡️</span></div><strong>${visibleVehicleRecordItems().filter(r => r.type === "insurance" && r.status !== "cancelado" && r.status !== "finalizado").length}</strong><em>Pólizas registradas</em></article>
      <article class="metric ${alerts.length ? "warn" : "good"}"><div class="top"><small>Avisos próximos</small><span class="icon">🔔</span></div><strong>${alerts.length}</strong><em>90 días</em></article>
    </section>
    <section class="grid-main">
      <article class="section-card"><h4>Nuevo vehículo</h4>${renderVehicleForm()}</article>
      <article class="section-card"><h4>Vehículos registrados</h4>${renderVehicleList()}</article>
    </section>
    <section class="grid-main">
      <article class="section-card"><h4>Seguro anual / financiado</h4>${renderInsuranceForm()}</article>
      <article class="section-card"><h4>Mantenimiento, revisión o repuesto</h4>${renderVehicleRecordForm()}</article>
    </section>
    <section class="grid-main">
      <article class="section-card"><h4>Historial de vehículos</h4><div class="field"><label>Filtrar vehículo</label><select id="vehicleFilter"><option value="all">Todos</option>${visibleVehicleItems().map(v => `<option value="${v.id}" ${state.filters.vehicle === v.id ? "selected" : ""}>${escapeHtml(v.name)}</option>`).join("")}</select></div>${renderVehicleRecordsTable(filteredRecords)}</article>
      <article class="section-card"><h4>Alertas y próximos avisos</h4>${alerts.length ? `<div class="advice-list">${alerts.map(a => `<article class="advice warn"><span class="badge">🔔</span><div><b>${escapeHtml(a.label)}</b><p>${escapeHtml(a.vehicle.name)} · ${escapeHtml(dateOnly(a.date))}</p></div></article>`).join("")}</div>` : `<div class="empty-state"><strong>Sin avisos urgentes</strong>Cuando una revisión, ITV, seguro o próximo kilometraje esté cerca, aparecerá aquí.</div>`}</article>
    </section>`;
}

function renderVehicleForm() {
  return `<form id="vehicleForm">
    <input name="id" type="hidden" />
    <div class="field"><label>Nombre o alias</label><input name="name" required placeholder="Ej. Peugeot 308, Corolla, Burgman" /></div>
    <div class="inline-grid"><div class="field"><label>Tipo</label><select name="type"><option value="car">Coche</option><option value="motorcycle">Moto</option><option value="van">Furgoneta</option><option value="truck">Camión</option><option value="other">Otro</option></select></div><div class="field"><label>Responsable / propietario</label><select name="owner_id">${memberOptions(state.user.id)}</select></div></div>
    <div class="inline-grid"><div class="field"><label>Marca</label><input name="brand" placeholder="Ej. Peugeot, Toyota, Benelli" /></div><div class="field"><label>Modelo</label><input name="model" placeholder="Ej. 308, Corolla, Leoncino" /></div></div>
    <div class="inline-grid"><div class="field"><label>Matrícula</label><input name="plate" placeholder="Ej. 3979 JBC" /></div><div class="field"><label>Año</label><input name="year" type="number" min="1950" max="2100" placeholder="Ej. 2014" /></div></div>
    <div class="inline-grid"><div class="field"><label>Kilometraje actual</label><input name="km" type="number" min="0" placeholder="Ej. 120000" /></div><div class="field"><label>Estado</label><select name="status"><option value="activo">Activo</option><option value="vendido">Vendido</option><option value="taller">En taller</option><option value="inactivo">Inactivo</option></select></div></div>
    <div class="field"><label>Notas</label><textarea name="notes" placeholder="Seguro, uso, observaciones, taller habitual..."></textarea></div>
    <div class="form-actions"><button class="btn primary" id="saveVehicleBtn" type="submit">Guardar vehículo</button><button class="btn ghost" type="button" id="cancelVehicleEdit" hidden>Cancelar edición</button></div>
  </form>`;
}

function renderVehicleList() {
  const vehicles = visibleVehicleItems();
  if (!vehicles.length) return `<div class="empty-state"><strong>No tienes vehículos registrados.</strong>Añade tu coche, moto o cualquier vehículo para comenzar.</div>`;
  return `<div class="vehicle-list">${vehicles.map(v => {
    const spent = vehicleTotalSpent(v.id, activeYear());
    const records = vehicleRecordsFor(v.id);
    const next = vehicleNextAlerts(50).find(a => a.vehicle.id === v.id);
    return `<article class="vehicle-card"><header><div><h5>${vehicleTypeIcon(v.type)} ${escapeHtml(v.name)}</h5><p class="muted">${escapeHtml([v.brand, v.model, v.year, v.plate].filter(Boolean).join(" · ") || "Sin datos técnicos")}</p></div><span class="vehicle-chip ${v.status === "activo" || !v.status ? "ok" : "warn"}">${escapeHtml(v.status || "activo")}</span></header><div class="vehicle-meta-grid"><div class="mini-stat"><span>Kilómetros</span><strong>${v.km ? Number(v.km).toLocaleString("es-ES") : "-"}</strong></div><div class="mini-stat"><span>Gasto ${activeYear()}</span><strong>${money(spent)}</strong></div><div class="mini-stat"><span>Registros</span><strong>${records.length}</strong></div></div>${next ? `<p class="hint">Próximo aviso: ${escapeHtml(next.label)} · ${escapeHtml(dateOnly(next.date))}</p>` : ""}<div class="td-actions"><button class="btn small" data-edit-vehicle="${v.id}">Editar</button><button class="btn small danger" data-delete-vehicle="${v.id}">Borrar</button></div></article>`;
  }).join("")}</div>`;
}

function renderVehicleSelect(name, required = true) {
  const vehicles = visibleVehicleItems();
  if (!vehicles.length) return `<select name="${name}" ${required ? "required" : ""}><option value="">Primero crea un vehículo</option></select>`;
  return `<select name="${name}" ${required ? "required" : ""}>${vehicles.map(v => `<option value="${v.id}">${escapeHtml(v.name)}</option>`).join("")}</select>`;
}

function renderInsuranceForm() {
  return `<form id="vehicleInsuranceForm">
    <input name="id" type="hidden" />
    <div class="field"><label>Vehículo</label>${renderVehicleSelect("vehicle_id")}</div>
    <div class="inline-grid"><div class="field"><label>Aseguradora</label><input name="insurance_company" placeholder="Ej. Mapfre, Línea Directa, Mutua..." /></div><div class="field"><label>Total del seguro</label><input name="amount" type="number" step="0.01" min="0" placeholder="Ej. 455" /></div></div>
    <div class="inline-grid"><div class="field"><label>Forma de pago</label><select name="payment_mode"><option value="cash">Al contado</option><option value="financed">Financiado / cuotas</option><option value="monthly">Mensual</option></select></div><div class="field"><label>Estado</label><select name="status"><option value="activo">Activo</option><option value="pendiente">Pendiente</option><option value="finalizado">Finalizado</option><option value="cancelado">Cancelado</option></select></div></div>
    <div class="inline-grid"><div class="field"><label>Inicio / primer pago</label><input name="date" type="date" value="${todayISO()}" /></div><div class="field"><label>Fin de cobertura</label><input name="coverage_end" type="date" /></div></div>
    <div class="inline-grid"><div class="field"><label>Día de pago de cuota</label><input name="installment_day" type="number" min="1" max="31" value="1" /></div><div class="field"><label>Responsable del pago</label><select name="responsible_user_id">${memberOptions(state.user.id)}</select></div></div>
    <div class="inline-grid"><div class="field"><label>Nº de cuotas</label><input name="installment_count" type="number" min="1" max="60" placeholder="Ej. 12" /></div><div class="field"><label>Importe por cuota</label><input name="installment_amount" type="number" step="0.01" min="0" placeholder="Se calcula si lo dejas vacío" /></div></div>
    <p class="hint">Si el seguro está financiado, Inicio y Movimientos mostrarán cada cuota en su mes, no todo el total en un solo golpe.</p>
    <div class="field"><label>Notas</label><textarea name="note" placeholder="Nº de póliza, franquicia, teléfono, observaciones..."></textarea></div>
    <div class="form-actions"><button class="btn primary" id="saveInsuranceBtn" type="submit">Guardar seguro</button><button class="btn ghost" type="button" id="cancelInsuranceEdit" hidden>Cancelar edición</button></div>
  </form>`;
}

function renderVehicleRecordForm() {
  return `<form id="vehicleRecordForm">
    <input name="id" type="hidden" />
    <div class="inline-grid"><div class="field"><label>Vehículo</label>${renderVehicleSelect("vehicle_id")}</div><div class="field"><label>Tipo</label><select name="type"><option value="maintenance">Mantenimiento</option><option value="oil">Cambio de aceite</option><option value="tires">Neumáticos</option><option value="itv">ITV</option><option value="repair">Reparación</option><option value="fuel">Combustible</option><option value="tax">Impuesto</option><option value="other">Otro</option></select></div></div>
    <div class="field"><label>Concepto</label><input name="concept" placeholder="Ej. Cambio de aceite, 4 cauchos, revisión de frenos" required /></div>
    <div class="inline-grid"><div class="field"><label>Fecha del gasto / servicio</label><input name="date" type="date" value="${todayISO()}" /></div><div class="field"><label>Importe</label><input name="amount" type="number" step="0.01" min="0" placeholder="0,00" /></div></div>
    <div class="inline-grid"><div class="field"><label>Kilómetros al hacerlo</label><input name="km" type="number" min="0" placeholder="Ej. 120000" /></div><div class="field"><label>Estado</label><select name="status"><option value="realizado">Realizado / pagado</option><option value="pendiente">Pendiente</option><option value="programado">Programado</option><option value="cancelado">Cancelado</option></select></div></div>
    <div class="inline-grid"><div class="field"><label>Próxima fecha</label><input name="next_date" type="date" /></div><div class="field"><label>Próximo km</label><input name="next_km" type="number" min="0" placeholder="Ej. 130000" /></div></div>
    <div class="field"><label>Taller / proveedor</label><input name="provider" placeholder="Ej. Norauto, taller de confianza..." /></div>
    <div class="field"><label>Notas</label><textarea name="note" placeholder="Marca del aceite, medida de neumáticos, garantía, factura, observaciones..."></textarea></div>
    <div class="form-actions"><button class="btn primary" id="saveVehicleRecordBtn" type="submit">Guardar mantenimiento</button><button class="btn ghost" type="button" id="cancelVehicleRecordEdit" hidden>Cancelar edición</button></div>
  </form>`;
}

function renderVehicleRecordsTable(records) {
  if (!records.length) return `<div class="empty-state"><strong>Sin historial</strong>Los seguros, mantenimientos y gastos aparecerán aquí.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Vehículo</th><th>Tipo</th><th>Concepto</th><th>Importe</th><th>Próximo aviso</th><th>Acciones</th></tr></thead><tbody>${records.map(r => {
    const v = state.vehicles.find(x => x.id === r.vehicle_id);
    const actions = canManageVehicleRecord(r)
      ? `<div class="td-actions"><button class="btn small" data-edit-vehicle-record="${r.id}">Editar</button><button class="btn small danger" data-delete-vehicle-record="${r.id}">Borrar</button></div>`
      : `<span class="hint">Solo lectura</span>`;
    return `<tr><td>${escapeHtml(dateOnly(r.date))}</td><td>${escapeHtml(v?.name || "Vehículo")}</td><td>${escapeHtml(vehicleRecordTypeLabel(r.type))}</td><td>${escapeHtml(r.concept || r.insurance_company || r.note || "Registro")}${r.type === "insurance" && Number(r.installment_count || 0) > 1 ? `<br><span class="muted">${Number(r.installment_count)} cuotas${Number(r.installment_amount || 0) > 0 ? ` de ${money(r.installment_amount)}` : ""}</span>` : ""}</td><td><strong>${money(r.amount)}</strong></td><td>${escapeHtml(dateOnly(r.next_date || r.coverage_end) || "-")}</td><td>${actions}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

function renderReports() {
  const items = getMovementsFiltered();
  const metrics = metricsFor(items);
  const categories = getExpenseCategories(items);
  const byMember = visibleMembers(true).map(m => {
    const userId = m.user_id;
    return { name: memberName(userId), income: sum(items.filter(x => x.type === "income" && (x.member_id === userId || x.user_id === userId)), x => x.amount), expense: sum(items.filter(x => x.type === "expense" && (x.member_id === userId || x.user_id === userId)), x => x.amount) };
  });
  return `<section class="page-head"><h2>Reportes</h2><p>Resumen listo para revisar, exportar o imprimir.</p><button class="btn dark" onclick="window.print()">Imprimir</button></section><article class="section-card dark-panel">${renderFilters(`<div></div>`)}</article><section class="metrics-grid"><article class="metric good"><div class="top"><small>Total ingresos</small><span class="icon">↗</span></div><strong>${money(metrics.totalIncome)}</strong><em>Periodo filtrado</em></article><article class="metric bad"><div class="top"><small>Total gastos</small><span class="icon">↘</span></div><strong>${money(metrics.totalExpense)}</strong><em>Periodo filtrado</em></article><article class="metric ${metrics.balance >= 0 ? "good" : "bad"}"><div class="top"><small>Balance</small><span class="icon">=</span></div><strong>${money(metrics.balance)}</strong><em>Resultado</em></article><article class="metric warn"><div class="top"><small>Comunes</small><span class="icon">🏠</span></div><strong>${money(metrics.sharedExpense)}</strong><em>Casa</em></article></section><section class="grid-2"><article class="section-card"><h4>Top categorías</h4>${categories.length ? categories.map(c => `<div class="progress-row"><div class="progress-meta"><span>${escapeHtml(c.name)}</span><strong>${money(c.total)}</strong></div><div class="bar"><span style="width:${metrics.totalExpense ? Math.min(100, c.total / metrics.totalExpense * 100) : 0}%"></span></div></div>`).join("") : `<div class="empty-state"><strong>Sin datos</strong></div>`}</article><article class="section-card"><h4>Por persona</h4><div class="table-wrap"><table><thead><tr><th>Persona</th><th>Ingresos</th><th>Gastos</th><th>Balance</th></tr></thead><tbody>${byMember.map(m => `<tr><td>${escapeHtml(m.name)}</td><td>${money(m.income)}</td><td>${money(m.expense)}</td><td><strong>${money(m.income - m.expense)}</strong></td></tr>`).join("")}</tbody></table></div></article></section><article class="section-card">${renderMovementTable(items, false)}</article>`;
}

function renderHistory() {
  const events = getVisibleMovements()
    .map(m => ({
      date: m.date,
      type: m._source === "vehicle" ? "Vehículo" : m.type === "income" ? "Ingreso" : "Gasto",
      title: m.description || categoryName(m.category_id),
      amount: m.amount,
      detail: `${memberName(m.member_id || m.user_id)} · ${categoryName(m.category_id)}`
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 120);
  return `<section class="page-head"><h2>Historial</h2><p>Línea de tiempo de movimientos, seguros, mantenimientos y registros importantes.</p></section><article class="section-card">${events.length ? `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Tipo</th><th>Concepto</th><th>Detalle</th><th>Importe</th></tr></thead><tbody>${events.map(e => `<tr><td>${escapeHtml(dateOnly(e.date))}</td><td>${escapeHtml(e.type)}</td><td>${escapeHtml(e.title)}</td><td>${escapeHtml(e.detail)}</td><td><strong>${money(e.amount)}</strong></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>Sin historial</strong>Cuando cargues datos, aparecerán aquí.</div>`}</article>`;
}

function renderBackup() {
  return `<section class="page-head"><h2>Respaldo</h2><p>Exporta tus datos visibles. La fuente real sigue siendo Supabase.</p></section><section class="grid-2"><article class="section-card"><h4>Exportar</h4><p class="sub">Descarga JSON o CSV de lo que tu usuario tiene permiso de ver.</p><div class="form-grid"><button class="btn primary" id="exportJsonBtn">Exportar JSON</button><button class="btn dark" id="exportCsvBtn">Exportar movimientos CSV</button></div></article><article class="section-card dark-panel"><h4>Backup real</h4><p class="sub">Para copias completas usa Supabase Dashboard. Estos botones son respaldos prácticos del usuario.</p></article></section>`;
}

function renderAdmin() {
  if (!isAdmin()) return `<div class="empty-state"><strong>Sin permiso</strong>Solo el administrador puede entrar aquí.</div>`;
  return `<section class="page-head"><h2>Administrador</h2><p>Invita integrantes y define qué puede ver o tocar cada usuario.</p></section><section class="admin-stack"><article class="section-card admin-invite-card"><h4>Invitar integrante</h4><form id="inviteForm"><div class="field"><label>Email</label><input name="email" type="email" required placeholder="correo@dominio.com" /></div><div class="field"><label>Nombre opcional</label><input name="full_name" placeholder="Ej. Mercedes" /></div><div class="field"><label>Rol</label><select name="role"><option value="member">Miembro</option><option value="viewer">Solo lectura</option><option value="admin">Administrador</option></select></div><button class="btn primary" type="submit">Crear invitación</button></form><h4 style="margin-top:20px">Invitaciones</h4>${state.invitations.length ? `<div class="form-grid">${state.invitations.map(i => `<div class="progress-row"><div class="progress-meta"><strong>${escapeHtml(i.invited_email)}</strong><span>${escapeHtml(i.status)} · ${escapeHtml(i.role)}</span></div></div>`).join("")}</div>` : `<div class="empty-state"><strong>Sin invitaciones</strong>Invita a alguien por email.</div>`}</article><article class="section-card admin-members-card"><h4>Miembros</h4>${renderMembersAdmin()}</article></section><article class="section-card admin-permissions-card"><h4>Permisos por usuario</h4><div class="field"><label>Seleccionar usuario</label><select id="permissionUserSelect">${visibleMembers(true).map(m => `<option value="${m.user_id}">${escapeHtml(memberName(m.user_id))} · ${escapeHtml(m.role)}</option>`).join("")}</select></div><div id="permissionsEditor" style="margin-top:14px"></div></article>`;
}

function renderMembersAdmin() {
  if (!state.members.length) return `<div class="empty-state"><strong>Sin miembros</strong></div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>%</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${visibleMembers(true).map(m => {
    const p = state.profilesByUserId[m.user_id] || {};
    const isMe = m.user_id === state.user?.id;
    const active = isActiveMember(m);
    const statusLabel = active ? "Activo" : "Inactivo";
    const statusClass = active ? "income" : "neutral";
    return `<tr>
      <td><strong>${escapeHtml(memberName(m.user_id))}</strong>${m.dependent ? `<br><span class="hint">Dependiente</span>` : ""}</td>
      <td>${escapeHtml(p.email || "")}</td>
      <td><span class="tag neutral">${escapeHtml(m.role)}</span></td>
      <td>${m.participation_percent != null ? `${escapeHtml(m.participation_percent)}%` : "-"}</td>
      <td><span class="tag ${statusClass}">${statusLabel}</span></td>
      <td><div class="td-actions">
        <button class="btn small" data-edit-member="${m.user_id}">Editar</button>
        ${isAdmin() && !isMe ? (active
          ? `<button class="btn small danger" data-deactivate-member="${m.user_id}">Desactivar</button>`
          : `<button class="btn small ok" data-activate-member="${m.user_id}">Activar</button>`) : ""}
      </div></td>
    </tr>`;
  }).join("")}</tbody></table></div>`;
}

function renderPermissionEditor(userId) {
  const member = state.members.find(m => m.user_id === userId);
  const disabled = member?.role === "admin";
  const safeUserId = String(userId || "user").replace(/[^a-zA-Z0-9_-]/g, "-");
  const permissionLabels = {
    can_view: "Ver",
    can_create: "Crear",
    can_edit: "Editar",
    can_delete: "Borrar"
  };

  const rows = MODULES.map((mod, index) => {
    const p = state.permissions.find(x => x.user_id === userId && x.module === mod.key) || {};
    const activeCount = PERMISSION_FIELDS.filter(field => Boolean(p[field])).length;
    const controls = PERMISSION_FIELDS.map(field => {
      const inputId = `perm-${safeUserId}-${mod.key}-${field}`;
      return `<label class="permission-control" for="${inputId}">
        <span class="permission-control-label">${permissionLabels[field] || field}</span>
        <span class="permission-switch">
          <input id="${inputId}" type="checkbox" data-permission-field="${field}" ${p[field] ? "checked" : ""} ${disabled ? "disabled" : ""} />
          <span class="permission-switch-track" aria-hidden="true"></span>
        </span>
      </label>`;
    }).join("");

    return `<article class="permission-card" data-permission-module="${mod.key}">
      <div class="permission-module">
        <span class="permission-module-icon">${mod.icon}</span>
        <div>
          <strong>${escapeHtml(mod.label)}</strong>
          <small>${disabled ? "Admin: acceso total" : `${activeCount}/4 permisos activos`}</small>
        </div>
      </div>
      <div class="permission-actions" aria-label="Permisos de ${escapeHtml(mod.label)}">${controls}</div>
    </article>`;
  }).join("");

  const container = $("#permissionsEditor");
  if (!container) return;

  container.innerHTML = `<div class="permission-editor-panel">
    <header class="permission-editor-head">
      <div>
        <span class="permission-kicker">Permisos del usuario</span>
        <h5>${escapeHtml(memberName(userId))}</h5>
        <p>${disabled ? "Este usuario es administrador; por seguridad tiene todo activo por defecto." : "Activa solo lo necesario para cada módulo de la app."}</p>
      </div>
      <span class="permission-role-pill ${disabled ? "is-admin" : ""}">${escapeHtml(member?.role || "member")}</span>
    </header>
    <div class="permission-list">${rows}</div>
    <footer class="permission-savebar">
      <span>${disabled ? "Los permisos de admin no se editan desde aquí." : "Guarda los cambios para aplicar esta matriz de permisos."}</span>
      <button class="btn primary" id="savePermissionsBtn" data-user-id="${userId}" ${disabled ? "disabled" : ""}>Guardar permisos</button>
    </footer>
  </div>`;

  container.querySelector("#savePermissionsBtn")?.addEventListener("click", handleSavePermissions);
}

function bindCommonActions() {
  $$('[data-section]').forEach(btn => btn.addEventListener("click", () => { state.activeSection = btn.dataset.section; renderApp(); }));
  $("#logoutBtn")?.addEventListener("click", () => supabase.auth.signOut());
  $("#refreshBtn")?.addEventListener("click", async () => { await loadWorkspace(); renderApp(); showToast("Datos actualizados desde Supabase.", "ok"); });
  $("#householdSwitcher")?.addEventListener("change", async (e) => { state.currentHouseholdId = e.target.value; await loadHouseholdData(); renderApp(); });
  $("#filterMonth")?.addEventListener("change", e => { state.filters.month = e.target.value; state.filters.year = String(e.target.value || "").slice(0, 4) || state.filters.year; renderApp(); });
  $("#filterPerson")?.addEventListener("change", e => { state.filters.person = e.target.value; renderApp(); });
  $("#filterType")?.addEventListener("change", e => { state.filters.movementType = e.target.value; renderApp(); });
  $("#filterCategory")?.addEventListener("change", e => { state.filters.category = e.target.value || "all"; renderApp(); });
  $("#filterSearch")?.addEventListener("input", e => { state.filters.search = e.target.value || ""; renderApp(); });
  $("#filterSortField")?.addEventListener("change", e => { state.filters.sortField = e.target.value || "date"; renderApp(); });
  $("#filterSortDirection")?.addEventListener("change", e => { state.filters.sortDirection = e.target.value || "desc"; renderApp(); });
  $("#analyticsPeriod")?.addEventListener("change", e => { state.analytics.periodMonths = Number(e.target.value || 12); renderApp(); });
  $("#analyticsCompare")?.addEventListener("change", e => { state.analytics.compare = e.target.value || 'prevMonth'; renderApp(); });
  $("#analyticsCategory")?.addEventListener("change", e => { state.analytics.category = e.target.value || 'all'; renderApp(); });
  $("#topCategoriesLimit")?.addEventListener("change", e => { state.analytics.top = Number(e.target.value || 7); renderApp(); });
  $("#vehicleFilter")?.addEventListener("change", e => { state.filters.vehicle = e.target.value; renderApp(); });
  $$('[data-accept-invite]').forEach(btn => btn.addEventListener("click", () => acceptInvitation(btn.dataset.acceptInvite)));
}

function bindSectionActions() {
  $("#movementForm")?.addEventListener("submit", handleMovementSubmit);
  $("#recurringForm")?.addEventListener("submit", handleRecurringSubmit);
  $("#categoryForm")?.addEventListener("submit", handleCategorySubmit);
  $("#goalForm")?.addEventListener("submit", handleGoalSubmit);
  $("#vehicleForm")?.addEventListener("submit", handleVehicleSubmit);
  $("#vehicleInsuranceForm")?.addEventListener("submit", handleVehicleInsuranceSubmit);
  $("#vehicleRecordForm")?.addEventListener("submit", handleVehicleRecordSubmit);
  $("#inviteForm")?.addEventListener("submit", handleInviteSubmit);
  $("#exportJsonBtn")?.addEventListener("click", exportJson);
  $("#exportCsvBtn")?.addEventListener("click", exportCsv);

  $$('[data-delete-movement]').forEach(btn => btn.addEventListener("click", () => deleteMovement(btn.dataset.deleteMovement)));
  $$('[data-edit-movement]').forEach(btn => btn.addEventListener("click", () => editMovement(btn.dataset.editMovement)));
  $$('[data-delete-category]').forEach(btn => btn.addEventListener("click", () => deleteCategory(btn.dataset.deleteCategory)));
  $$('[data-delete-goal]').forEach(btn => btn.addEventListener("click", () => deleteGoal(btn.dataset.deleteGoal)));
  $$('[data-edit-vehicle]').forEach(btn => btn.addEventListener("click", () => editVehicle(btn.dataset.editVehicle)));
  $$('[data-delete-vehicle]').forEach(btn => btn.addEventListener("click", () => deleteVehicle(btn.dataset.deleteVehicle)));
  $$('[data-edit-vehicle-record]').forEach(btn => btn.addEventListener("click", () => editVehicleRecord(btn.dataset.editVehicleRecord)));
  $$('[data-delete-vehicle-record]').forEach(btn => btn.addEventListener("click", () => deleteVehicleRecord(btn.dataset.deleteVehicleRecord)));
  $("#cancelVehicleEdit")?.addEventListener("click", resetVehicleFormEdit);
  $("#cancelInsuranceEdit")?.addEventListener("click", resetInsuranceFormEdit);
  $("#cancelVehicleRecordEdit")?.addEventListener("click", resetVehicleRecordFormEdit);
  $$('[data-delete-recurring]').forEach(btn => btn.addEventListener("click", () => deleteRecurring(btn.dataset.deleteRecurring)));

  const permissionSelect = $("#permissionUserSelect");
  if (permissionSelect) {
    renderPermissionEditor(permissionSelect.value);
    permissionSelect.addEventListener("change", e => renderPermissionEditor(e.target.value));
  }
  $("#savePermissionsBtn")?.addEventListener("click", handleSavePermissions);
}

async function acceptInvitation(invitationId) {
  const inv = state.pendingInvitations.find(i => i.id === invitationId);
  if (!inv) return;
  await withError(supabase.from("household_members").insert({ household_id: inv.household_id, user_id: state.user.id, role: inv.role || "member", status: "active" }), "Entraste al hogar.");
  await supabase.from("invitations").update({ status: "accepted", accepted_at: new Date().toISOString() }).eq("id", inv.id);
  state.currentHouseholdId = inv.household_id;
  await loadWorkspace();
  render();
}

async function handleMovementSubmit(event) {
  event.preventDefault();
  const f = new FormData(event.currentTarget);
  const type = f.get("type");
  if (!can("movements", "create") && !can("register", "create")) return showToast("No tienes permiso para crear movimientos.", "danger");
  const payload = { household_id: state.currentHouseholdId, user_id: state.user.id, member_id: safeAssignableMemberId(f.get("member_id")), type, amount: parseAmount(f.get("amount")), date: f.get("date"), category_id: f.get("category_id") || null, description: String(f.get("description") || "").trim(), is_shared: Boolean(f.get("is_shared")) };
  await withError(supabase.from("movements").insert(payload), "Movimiento guardado en la BBDD.");
  await loadHouseholdData(); renderApp();
}

async function handleRecurringSubmit(event) {
  event.preventDefault();
  if (!can("recurring", "create") && !can("register", "create")) return showToast("No tienes permiso para crear recurrentes.", "danger");
  const f = new FormData(event.currentTarget);
  const payload = { household_id: state.currentHouseholdId, user_id: state.user.id, member_id: safeAssignableMemberId(f.get("member_id")), type: f.get("type"), amount: parseAmount(f.get("amount")), category_id: f.get("category_id") || null, description: String(f.get("description") || "").trim(), day_of_month: Number(f.get("day_of_month") || 1), frequency: "monthly", active: true, is_shared: Boolean(f.get("is_shared")) };
  await insertWithSchemaFallback("recurring_movements", payload, "Recurrente guardado.", ["household_id","user_id","member_id","type","amount","category_id","description","day_of_month","frequency","active","is_shared"]);
  await loadHouseholdData(); renderApp();
}

async function handleCategorySubmit(event) {
  event.preventDefault();
  if (!can("categories", "create")) return showToast("No tienes permiso para crear categorías.", "danger");
  const f = new FormData(event.currentTarget);
  await insertWithSchemaFallback("categories", { household_id: state.currentHouseholdId, name: String(f.get("name") || "").trim(), type: f.get("type"), color: f.get("color") }, "Categoría creada.", ["household_id","name","type","color"]);
  await loadHouseholdData(); renderApp();
}

async function handleGoalSubmit(event) {
  event.preventDefault();
  if (!can("goals", "create")) return showToast("No tienes permiso para crear metas.", "danger");
  const f = new FormData(event.currentTarget);
  await insertWithSchemaFallback("goals", { household_id: state.currentHouseholdId, user_id: state.user.id, name: String(f.get("name") || "").trim(), target_amount: parseAmount(f.get("target_amount")), current_amount: parseAmount(f.get("current_amount")), deadline: f.get("deadline") || null }, "Meta guardada.", ["household_id","user_id","name","target_amount","current_amount","deadline"]);
  await loadHouseholdData(); renderApp();
}

async function handleVehicleSubmit(event) {
  event.preventDefault();
  if (!can("vehicles", "create") && !can("vehicles", "edit")) return showToast("No tienes permiso para guardar vehículos.", "danger");
  const f = new FormData(event.currentTarget);
  const id = String(f.get("id") || "").trim();
  const payload = { household_id: state.currentHouseholdId, owner_id: safeAssignableMemberId(f.get("owner_id")), name: String(f.get("name") || "").trim(), plate: String(f.get("plate") || "").trim(), type: f.get("type"), brand: String(f.get("brand") || "").trim(), model: String(f.get("model") || "").trim(), year: f.get("year") ? Number(f.get("year")) : null, km: f.get("km") ? Number(f.get("km")) : null, status: f.get("status") || "activo", notes: String(f.get("notes") || "").trim() };
  if (id) {
    await updateWithSchemaFallback("vehicles", payload, { id, household_id: state.currentHouseholdId }, "Vehículo actualizado.", ["household_id","owner_id","name","plate","type"]);
  } else {
    await insertWithSchemaFallback("vehicles", payload, "Vehículo guardado.", ["household_id","owner_id","name","plate","type"]);
  }
  await loadHouseholdData(); renderApp();
}

async function handleVehicleInsuranceSubmit(event) {
  event.preventDefault();
  if (!can("vehicles", "create") && !can("vehicles", "edit")) return showToast("No tienes permiso para guardar seguros.", "danger");
  const f = new FormData(event.currentTarget);
  const id = String(f.get("id") || "").trim();
  const payload = { household_id: state.currentHouseholdId, vehicle_id: f.get("vehicle_id"), user_id: state.user.id, type: "insurance", amount: parseAmount(f.get("amount")), date: f.get("date") || todayISO(), note: String(f.get("note") || "").trim(), concept: "Seguro anual", insurance_company: String(f.get("insurance_company") || "").trim(), payment_mode: f.get("payment_mode"), status: f.get("status") || "activo", coverage_end: f.get("coverage_end") || null, installment_day: f.get("installment_day") ? Number(f.get("installment_day")) : null, installment_count: f.get("installment_count") ? Number(f.get("installment_count")) : null, installment_amount: f.get("installment_amount") ? parseAmount(f.get("installment_amount")) : null, responsible_user_id: safeAssignableMemberId(f.get("responsible_user_id")) };
  if (id) {
    await updateWithSchemaFallback("vehicle_records", payload, { id, household_id: state.currentHouseholdId }, "Seguro actualizado.", ["household_id","vehicle_id","user_id","type","amount","date","note"]);
  } else {
    await insertWithSchemaFallback("vehicle_records", payload, "Seguro guardado.", ["household_id","vehicle_id","user_id","type","amount","date","note"]);
  }
  await loadHouseholdData(); renderApp();
}

async function handleVehicleRecordSubmit(event) {
  event.preventDefault();
  if (!can("vehicles", "create") && !can("vehicles", "edit")) return showToast("No tienes permiso para guardar mantenimientos.", "danger");
  const f = new FormData(event.currentTarget);
  const id = String(f.get("id") || "").trim();
  const payload = { household_id: state.currentHouseholdId, vehicle_id: f.get("vehicle_id"), user_id: state.user.id, type: f.get("type"), amount: parseAmount(f.get("amount")), date: f.get("date") || todayISO(), note: String(f.get("note") || "").trim(), concept: String(f.get("concept") || "").trim(), status: f.get("status") || "realizado", km: f.get("km") ? Number(f.get("km")) : null, next_date: f.get("next_date") || null, next_km: f.get("next_km") ? Number(f.get("next_km")) : null, provider: String(f.get("provider") || "").trim() };
  if (id) {
    await updateWithSchemaFallback("vehicle_records", payload, { id, household_id: state.currentHouseholdId }, "Mantenimiento actualizado.", ["household_id","vehicle_id","user_id","type","amount","date","note"]);
  } else {
    await insertWithSchemaFallback("vehicle_records", payload, "Mantenimiento guardado.", ["household_id","vehicle_id","user_id","type","amount","date","note"]);
  }
  await loadHouseholdData(); renderApp();
}

async function handleInviteSubmit(event) {
  event.preventDefault();
  if (!isAdmin()) return showToast("Solo el admin puede invitar.", "danger");
  const f = new FormData(event.currentTarget);
  await withError(supabase.from("invitations").insert({ household_id: state.currentHouseholdId, invited_email: String(f.get("email") || "").trim().toLowerCase(), full_name: String(f.get("full_name") || "").trim(), role: f.get("role"), invited_by: state.user.id, status: "pending" }), "Invitación creada. Esa persona debe registrarse con ese email.");
  await loadHouseholdData(); renderApp();
}

async function handleSavePermissions(event) {
  const userId = event.currentTarget.dataset.userId;
  const rows = $$('[data-permission-module]');
  const payload = rows.map(row => {
    const record = { household_id: state.currentHouseholdId, user_id: userId, module: row.dataset.permissionModule };
    PERMISSION_FIELDS.forEach(field => record[field] = row.querySelector(`[data-permission-field="${field}"]`)?.checked || false);
    return record;
  });
  await withError(supabase.from("permissions").upsert(payload, { onConflict: "household_id,user_id,module" }), "Permisos actualizados.");
  await loadHouseholdData(); renderApp();
}

async function deleteMovement(id) { const movement = state.movements.find(m => m.id === id); if (!canManageMovementRecord(movement)) return showToast("No puedes borrar movimientos de otro integrante.", "danger"); if (!confirm("¿Borrar este movimiento?")) return; await withError(supabase.from("movements").delete().eq("id", id), "Movimiento eliminado."); await loadHouseholdData(); renderApp(); }
async function editMovement(id) { const movement = state.movements.find(m => m.id === id); if (!movement) return; if (!canManageMovementRecord(movement)) return showToast("No puedes editar movimientos de otro integrante.", "danger"); const amount = prompt("Nuevo monto", movement.amount); if (amount === null) return; const description = prompt("Descripción", movement.description || "") ?? movement.description; await withError(supabase.from("movements").update({ amount: parseAmount(amount), description }).eq("id", id), "Movimiento actualizado."); await loadHouseholdData(); renderApp(); }

function resetVehicleFormEdit() {
  const form = document.getElementById("vehicleForm");
  if (!form) return;
  form.reset();
  setFormField(form, "id", "");
  document.getElementById("saveVehicleBtn").textContent = "Guardar vehículo";
  const cancel = document.getElementById("cancelVehicleEdit");
  if (cancel) cancel.hidden = true;
}

function editVehicle(id) {
  const vehicle = state.vehicles.find(v => v.id === id);
  if (!vehicle) return showToast("No encontré ese vehículo.", "danger");
  if (!canManageVehicle(vehicle)) return showToast("No puedes editar vehículos de otro integrante.", "danger");
  if (state.activeSection !== "vehicles") {
    state.activeSection = "vehicles";
    renderApp();
    setTimeout(() => editVehicle(id), 80);
    return;
  }
  const form = document.getElementById("vehicleForm");
  if (!form) return;
  setFormField(form, "id", vehicle.id);
  setFormField(form, "name", vehicle.name || "");
  setSelectField(form, "type", vehicle.type || "car");
  setSelectField(form, "owner_id", vehicle.owner_id || state.user?.id || "");
  setFormField(form, "brand", vehicle.brand || "");
  setFormField(form, "model", vehicle.model || "");
  setFormField(form, "plate", vehicle.plate || "");
  setFormField(form, "year", vehicle.year ?? "");
  setFormField(form, "km", vehicle.km ?? "");
  setSelectField(form, "status", vehicle.status || "activo");
  setFormField(form, "notes", vehicle.notes || "");
  document.getElementById("saveVehicleBtn").textContent = "Actualizar vehículo";
  const cancel = document.getElementById("cancelVehicleEdit");
  if (cancel) cancel.hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetInsuranceFormEdit() {
  const form = document.getElementById("vehicleInsuranceForm");
  if (!form) return;
  form.reset();
  setFormField(form, "id", "");
  setFormField(form, "date", todayISO());
  setFormField(form, "installment_day", 1);
  setFormField(form, "installment_count", "");
  setFormField(form, "installment_amount", "");
  document.getElementById("saveInsuranceBtn").textContent = "Guardar seguro";
  const cancel = document.getElementById("cancelInsuranceEdit");
  if (cancel) cancel.hidden = true;
}

function resetVehicleRecordFormEdit() {
  const form = document.getElementById("vehicleRecordForm");
  if (!form) return;
  form.reset();
  setFormField(form, "id", "");
  setFormField(form, "date", todayISO());
  document.getElementById("saveVehicleRecordBtn").textContent = "Guardar mantenimiento";
  const cancel = document.getElementById("cancelVehicleRecordEdit");
  if (cancel) cancel.hidden = true;
}

function editVehicleRecord(id) {
  const record = state.vehicleRecords.find(r => r.id === id);
  if (!record) return showToast("No encontré ese registro.", "danger");
  if (!canManageVehicleRecord(record)) return showToast("No puedes editar registros de vehículo de otro integrante.", "danger");
  if (state.activeSection !== "vehicles") {
    state.activeSection = "vehicles";
    renderApp();
    setTimeout(() => editVehicleRecord(id), 80);
    return;
  }
  const isInsurance = record.type === "insurance";
  const form = document.getElementById(isInsurance ? "vehicleInsuranceForm" : "vehicleRecordForm");
  if (!form) return;

  if (isInsurance) {
    resetVehicleRecordFormEdit();
    setFormField(form, "id", record.id);
    setSelectField(form, "vehicle_id", record.vehicle_id || "");
    setFormField(form, "insurance_company", record.insurance_company || "");
    setFormField(form, "amount", record.amount ?? "");
    setSelectField(form, "payment_mode", record.payment_mode || "cash");
    setSelectField(form, "status", record.status || "activo");
    setFormField(form, "date", dateOnly(record.date) || todayISO());
    setFormField(form, "coverage_end", dateOnly(record.coverage_end) || "");
    setFormField(form, "installment_day", record.installment_day ?? 1);
    setFormField(form, "installment_count", record.installment_count ?? "");
    setFormField(form, "installment_amount", record.installment_amount ?? "");
    setSelectField(form, "responsible_user_id", record.responsible_user_id || record.user_id || state.user?.id || "");
    setFormField(form, "note", record.note || "");
    document.getElementById("saveInsuranceBtn").textContent = "Actualizar seguro";
    const cancel = document.getElementById("cancelInsuranceEdit");
    if (cancel) cancel.hidden = false;
  } else {
    resetInsuranceFormEdit();
    setFormField(form, "id", record.id);
    setSelectField(form, "vehicle_id", record.vehicle_id || "");
    setSelectField(form, "type", record.type || "maintenance");
    setFormField(form, "concept", record.concept || record.insurance_company || "");
    setFormField(form, "date", dateOnly(record.date) || todayISO());
    setFormField(form, "amount", record.amount ?? "");
    setFormField(form, "km", record.km ?? "");
    setSelectField(form, "status", record.status || "realizado");
    setFormField(form, "next_date", dateOnly(record.next_date) || "");
    setFormField(form, "next_km", record.next_km ?? "");
    setFormField(form, "provider", record.provider || "");
    setFormField(form, "note", record.note || "");
    document.getElementById("saveVehicleRecordBtn").textContent = "Actualizar mantenimiento";
    const cancel = document.getElementById("cancelVehicleRecordEdit");
    if (cancel) cancel.hidden = false;
  }
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteCategory(id) { if (!confirm("¿Borrar categoría? Los movimientos que la usen quedarán sin categoría.")) return; await withError(supabase.from("categories").delete().eq("id", id), "Categoría eliminada."); await loadHouseholdData(); renderApp(); }
async function deleteGoal(id) { if (!confirm("¿Borrar meta?")) return; await withError(supabase.from("goals").delete().eq("id", id), "Meta eliminada."); await loadHouseholdData(); renderApp(); }
async function deleteVehicle(id) { const vehicle = state.vehicles.find(v => v.id === id); if (!canManageVehicle(vehicle)) return showToast("No puedes borrar vehículos de otro integrante.", "danger"); if (!confirm("¿Borrar vehículo? También se borrará su historial.")) return; await withError(supabase.from("vehicles").delete().eq("id", id), "Vehículo eliminado."); await loadHouseholdData(); renderApp(); }
async function deleteVehicleRecord(id) { const record = state.vehicleRecords.find(r => r.id === id); if (!canManageVehicleRecord(record)) return showToast("No puedes borrar registros de vehículo de otro integrante.", "danger"); if (!confirm("¿Borrar este registro de vehículo?")) return; await withError(supabase.from("vehicle_records").delete().eq("id", id), "Registro eliminado."); await loadHouseholdData(); renderApp(); }
async function deleteRecurring(id) { const recurring = state.recurring.find(r => r.id === id); if (!canManageRecurringRecord(recurring)) return showToast("No puedes borrar recurrentes de otro integrante.", "danger"); if (!confirm("¿Borrar este automático/recurrente? Ya no se proyectará en Inicio ni en gráficas.")) return; await withError(supabase.from("recurring_movements").delete().eq("id", id), "Automático eliminado."); await loadHouseholdData(); renderApp(); }

function exportJson() {
  const data = { exported_at: new Date().toISOString(), household: getCurrentHousehold(), profile: state.profile, members: state.members, categories: state.categories, movements: getMovementsFiltered(), recurring: visibleRecurringItems(), goals: state.goals, vehicles: visibleVehicleItems(), vehicle_records: visibleVehicleRecordItems() };
  downloadTextFile(`finanzas360-respaldo-${todayISO()}.json`, JSON.stringify(data, null, 2));
}
function exportCsv() { downloadTextFile(`finanzas360-movimientos-${todayISO()}.csv`, toCSV(getMovementsFiltered()), "text/csv"); }


// ─────────────────────────────────────────────────────────────
// V3 · Espejo de estructura de la app antigua + Supabase real
// Mantiene login/BBDD/roles, pero devuelve la jerarquía visual y funcional
// de Finanzas 360 original: dashboard amplio, registrar separado, aportes,
// vehículos completos, historial, metas y respaldo.
// ─────────────────────────────────────────────────────────────
const F360V3 = (() => {
  const MENU = [
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
    { key: "admin", label: "Admin", icon: "🛡️" }
  ];

  const months = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  const monthName = (key = activeMonth()) => `${months[Math.max(0, Number(String(key).slice(5,7)) - 1)] || "Mes"} de ${String(key).slice(0,4)}`;
  const pct = (part, total) => total ? Math.max(0, Math.min(100, Math.round((Number(part || 0) / Number(total || 0)) * 100))) : 0;
  const signedMoney = (n = 0) => `${Number(n || 0) >= 0 ? "+" : ""}${money(n)}`;
  const shortDate = (v) => v ? new Date(String(v).slice(0,10) + "T00:00:00").toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" }) : "-";
  const yearOf = (m = activeMonth()) => String(m).slice(0, 4);
  const monthNo = (m = activeMonth()) => Number(String(m).slice(5, 7));
  const currentPersonLabel = () => state.filters.person === "all" ? "Todo el hogar" : state.filters.person === "me" ? "Mi información" : memberName(state.filters.person);

  function visibleModules() {
    return MENU.filter(m => {
      if (m.key === "admin") return isAdmin();
      if (m.key === "members") return isAdmin() || can("admin", "view") || can("household", "view");
      return m.key === "dashboard" || can(m.key, "view") || isAdmin();
    });
  }

  function renderSection() {
    const section = state.activeSection;
    if (section === "dashboard") return renderDashboard();
    if (section === "categories") return renderCategories();
    if (section === "members") return renderMembersSection();
    if (section === "household") return renderHousehold();
    if (section === "register") return renderRegister();
    if (section === "vehicles") return renderVehicles();
    if (section === "movements") return renderMovements();
    if (section === "goals") return renderGoals();
    if (section === "history") return renderHistory();
    if (section === "backup") return renderBackup();
    if (section === "admin") return renderAdmin();
    return renderDashboard();
  }

  function renderApp() {
    app.className = "app app-sidebar app-old-mirror";
    const currentHousehold = getCurrentHousehold();
    const modules = visibleModules();
    app.innerHTML = `
      <aside class="side-nav old-side" aria-label="Menú principal">
        <div class="side-brand old-side-brand">
          <div class="brand-logo">F3</div>
          <div><h1>Finanzas 360</h1><span>Tu gestor financiero personal</span></div>
        </div>
        ${state.households.length > 1 ? `<div class="field side-switch"><label>Hogar activo</label><select id="householdSwitcher">${state.households.map(h => `<option value="${h.id}" ${h.id === state.currentHouseholdId ? "selected" : ""}>${escapeHtml(h.name)}</option>`).join("")}</select></div>` : `<div class="side-household-name">${escapeHtml(currentHousehold?.name || "Familia")}</div>`}
        <div class="side-divider"></div>
        <span class="side-menu-title">Menú principal</span>
        <nav class="nav side-menu old-menu">
          ${modules.map(m => `<button type="button" class="${state.activeSection === m.key ? "active" : ""}" data-section="${m.key}"><span>${m.icon}</span><b>${m.label}</b></button>`).join("")}
        </nav>
        <div class="side-footer">
          <div class="side-user"><strong>${escapeHtml(state.profile?.full_name || state.user.email)}</strong><span>${escapeHtml(state.currentMember?.role || "usuario")}</span></div>
          <button class="btn ghost small" id="exportJsonBtn">💾 Exportar datos</button>
          <button class="btn ok small" id="refreshBtn">Actualizar</button>
          <button class="btn danger small" id="logoutBtn">Salir</button>
        </div>
      </aside>
      <main class="content-area old-content">
        ${renderSection()}
      </main>
    `;
    bindCommonActions();
    bindSectionActions();
  }

  function periodToolbar() {
    const y = Number(yearOf());
    const personOptions = filterPersonOptions();
    return `
      <section class="period-toolbar old-period">
        <div class="section-card quick-period-card">
          <p class="mini-note">🗓️ <strong>Mes activo:</strong> todos los registros, gráficas y cálculos se refieren al mes que selecciones aquí.</p>
          <div class="period-grid old-period-grid">
            <div class="field"><label>Mes activo</label><input id="filterMonth" type="month" value="${escapeHtml(activeMonth())}" /></div>
            <div class="field"><label>Año activo</label><select id="oldYearSelector">${[y-1,y,y+1].map(v => `<option value="${v}" ${v===y ? "selected" : ""}>${v}</option>`).join("")}</select></div>
            <div class="field"><label>Vista del dashboard</label><select id="filterPerson">${personOptions}</select></div>
            <div class="quick-actions">
              <button class="btn primary" type="button" data-section="register">5A&nbsp;&nbsp;+ Ingreso</button>
              <button class="btn dark" type="button" data-open-expense>5B&nbsp;&nbsp;+ Gasto</button>
              <button class="btn ghost" type="button" data-section="register">5C&nbsp;&nbsp;↻ Recurrente</button>
              <button class="btn ghost" type="button" onclick="window.print()">🖨️ Informe</button>
            </div>
          </div>
        </div>
      </section>`;
  }

  function monthStrip() {
    const y = Number(yearOf());
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonthNo = now.getMonth() + 1;

    // Esta tira no debe mostrar meses futuros: van apareciendo a medida que el año avanza.
    // Enero siempre queda primero para que la lectura sea natural y no al revés.
    const lastVisibleMonth = y < currentYear ? 12 : y === currentYear ? currentMonthNo : 0;
    const keys = Array.from({ length: Math.max(0, lastVisibleMonth) }, (_, i) => `${y}-${String(i + 1).padStart(2,"0")}`);

    if (!keys.length) {
      return `<div class="section-card month-history-card month-history-card--empty">
        <div class="month-card-header"><h4>Meses activos</h4><div class="month-card-actions"><span class="hint">Aún no hay meses activos para ${y}.</span></div></div>
      </div>`;
    }

    return `<div class="section-card month-history-card">
      <div class="month-card-header"><h4>Meses activos de ${y}</h4><div class="month-card-actions"><span class="hint desktop-month-hint">Solo se muestran los meses que ya van del año. Orden natural: enero primero.</span></div></div>
      <div class="month-strip f360-month-progress">${keys.map(k => { const m = metricsFor(monthItems(k)); return `<button class="month-pill ${k === activeMonth() ? "active" : ""}" type="button" data-set-month="${k}"><strong>${monthName(k)}</strong><span>${money(m.balance)} · ${m.incomes.length + m.expenses.length} mov.</span></button>`; }).join("")}</div>
    </div>`;
  }

  function monthItems(month = activeMonth(), person = state.filters.person) {
    return movementsForMonthPerson(month, person, { respectType: true });
  }

  function getMonthsRange(count = 12) {
    const start = new Date(Number(yearOf()), monthNo() - 1, 1);
    return Array.from({ length: count }, (_, idx) => {
      const d = new Date(start);
      d.setMonth(d.getMonth() - (count - 1 - idx));
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    });
  }

  function yearlyItems(year = yearOf()) {
    return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`)
      .flatMap(month => monthItems(month, state.filters.person));
  }

  function oldKpis(items) {
    const m = metricsFor(items);
    const categories = getExpenseCategories(items);
    const top = categories[0];
    const sharedPart = m.sharedExpense;
    const prevKeyDate = new Date(Number(yearOf()), monthNo() - 2, 1);
    const prevKey = `${prevKeyDate.getFullYear()}-${String(prevKeyDate.getMonth()+1).padStart(2,"0")}`;
    const prevMetrics = metricsFor(monthItems(prevKey));
    const prevBalance = prevMetrics.balance;
    return [
      { title: `Ingresos de ${escapeHtml(currentPersonLabel())}`, value: money(m.totalIncome), sub: `${m.incomes.length} ingresos en la vista activa`, tone: "good" },
      { title: `Gastos de ${escapeHtml(currentPersonLabel())}`, value: money(m.totalExpense), sub: `${m.expenses.length} gastos · ${pct(m.totalExpense, m.totalIncome)}% de ingresos`, tone: "bad" },
      { title: `Balance de ${escapeHtml(currentPersonLabel())}`, value: money(m.balance), sub: `${signedMoney(m.balance - prevBalance)} vs mes anterior`, tone: m.balance >= 0 ? "good" : "bad" },
      { title: `Gasto asignado a ${escapeHtml(currentPersonLabel())}`, value: money(m.totalExpense), sub: "Gastos propios y parte de compartidos", tone: "warn" },
      { title: "Ahorro estimado", value: money(Math.max(0, m.balance)), sub: `${pct(Math.max(0,m.balance), m.totalIncome)}% sobre ingresos de la vista`, tone: "good" },
      { title: "Tu parte compartida", value: money(sharedPart), sub: `${pct(sharedPart, m.totalExpense)}% del gasto mostrado`, tone: "warn" },
      { title: "Categoría más cara", value: escapeHtml(top?.name || "Sin datos"), sub: top ? money(top.total) : "Registra gastos", tone: "" },
      { title: "Variación de gastos", value: signedMoney(m.totalExpense - prevMetrics.totalExpense), sub: "Comparado con el mes anterior", tone: (m.totalExpense - prevMetrics.totalExpense) <= 0 ? "good" : "bad" }
    ];
  }

  function renderKpiGrid(items) {
    return `<section class="metrics-grid old-kpi-grid">${oldKpis(items).map(k => `<article class="metric old-kpi ${k.tone}"><small>${k.title}</small><strong>${k.value}</strong><em>${k.sub}</em></article>`).join("")}</section>`;
  }


  function contributionTargetId(person = state.filters.person) {
    if (person === "all" && canSeeAll()) return null;
    if (!person || person === "me") return state.user?.id || null;
    return person;
  }

  function sharedContributionSummary(month = activeMonth(), person = state.filters.person) {
    const targetId = contributionTargetId(person);
    const rawShared = getVisibleMovements()
      .filter(x => x.type === "expense" && x.is_shared && isSameMonth(x.date, month));
    const rows = rawShared
      .map(item => {
        const original = Number(item.amount || 0);
        const allocated = targetId ? allocateSharedMovementForPerson(item, targetId) : item;
        if (!allocated) return null;
        return {
          item,
          amount: Number(allocated.amount || 0),
          original,
          ratio: targetId ? Number(allocated._share_ratio || memberShareRatio(targetId, item) || 0) : 1
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.amount - a.amount);
    const totalAssigned = sum(rows, row => row.amount);
    const totalHouse = sum(rawShared, x => x.amount);
    const label = targetId ? memberName(targetId) : "Todo el hogar";
    const personalExpenses = getVisibleMovements().filter(x => {
      if (x.type !== "expense" || x.is_shared || !isSameMonth(x.date, month)) return false;
      if (!targetId) return true;
      return x.user_id === targetId || x.member_id === targetId;
    });
    const personalTotal = sum(personalExpenses, x => x.amount);
    return { targetId, label, rows, totalAssigned, totalHouse, personalTotal };
  }

  const HOUSE_POT_MONTHLY_CONTRIBUTION = 450;

  function housePotActiveContributors() {
    return contributionMembers()
      .filter(m => m.user_id && isActiveMember(m) && m.dependent !== true && m.contributes_income !== false);
  }

  function housePotPendingContributors() {
    const activeIds = new Set(housePotActiveContributors().map(m => m.user_id));
    return uniqueMembers(state.members)
      .filter(m => m.dependent !== true && m.contributes_income !== false)
      .filter(m => !m.user_id || !isActiveMember(m) || !activeIds.has(m.user_id));
  }

  function housePotSharedRows(month = activeMonth()) {
    const rawShared = getVisibleMovements()
      .filter(x => x.type === "expense" && x.is_shared && isSameMonth(x.date, month))
      .map(item => ({
        item,
        amount: Number(item.amount || 0),
        concept: item.description || categoryName(item.category_id) || "Gasto compartido",
        category: categoryName(item.category_id) || "Sin categoría"
      }))
      .sort((a, b) => b.amount - a.amount);
    return rawShared;
  }

  function housePotMonthExpected() {
    return housePotActiveContributors().length * HOUSE_POT_MONTHLY_CONTRIBUTION;
  }

  function housePotMonthNet(month = activeMonth()) {
    const expected = housePotMonthExpected();
    const spent = sum(housePotSharedRows(month), row => row.amount);
    return expected - spent;
  }

  function housePotPreviousCarry(month = activeMonth()) {
    const y = Number(String(month).slice(0, 4));
    const selectedMonthNo = Number(String(month).slice(5, 7));
    if (!selectedMonthNo || selectedMonthNo <= 1) return 0;

    // El pote solo arrastra sobrantes reales. Si un mes quedó corto pero se pagó
    // con aporte extra fuera del sistema, el siguiente mes no debe heredar deuda.
    // Ejemplo: carry 0 + aporte 900 - gastos 1.100 = 0, no -200.
    return Array.from({ length: selectedMonthNo - 1 }, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`)
      .reduce((carry, key) => Math.max(0, carry + housePotMonthNet(key)), 0);
  }

  function housePotRegisteredContribution(memberId, month = activeMonth()) {
    const terms = ["aporte", "pote", "fondo comun", "fondo común", "caja casa", "caja de la casa"];
    const normalize = value => String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return sum(getVisibleMovements().filter(x => {
      if (x.type !== "income" || !isSameMonth(x.date, month)) return false;
      if (x.user_id !== memberId && x.member_id !== memberId) return false;
      const text = normalize([x.description, x.notes, categoryName(x.category_id)].join(" "));
      return terms.some(term => text.includes(normalize(term)));
    }), x => x.amount);
  }

  function housePotSummary(month = activeMonth()) {
    const contributors = housePotActiveContributors();
    const pending = housePotPendingContributors();
    const expected = contributors.length * HOUSE_POT_MONTHLY_CONTRIBUTION;
    const previousCarry = housePotPreviousCarry(month);
    const sharedRows = housePotSharedRows(month);
    const spent = sum(sharedRows, row => row.amount);
    const available = previousCarry + expected;
    const remaining = available - spent;
    const shortfall = Math.max(0, -remaining);
    const extraPerPerson = contributors.length ? shortfall / contributors.length : 0;
    const canPayWithCarry = previousCarry >= spent && spent > 0;
    const coveragePct = spent > 0 ? Math.max(0, Math.min(100, Math.round((available / spent) * 100))) : 100;
    const contributorRows = contributors.map(member => {
      const registered = housePotRegisteredContribution(member.user_id, month);
      const status = registered >= HOUSE_POT_MONTHLY_CONTRIBUTION
        ? "Registrado"
        : registered > 0
          ? "Parcial"
          : "Acordado";
      return { member, expected: HOUSE_POT_MONTHLY_CONTRIBUTION, registered, status };
    });
    return { contributors, pending, contributorRows, expected, previousCarry, sharedRows, spent, available, remaining, shortfall, extraPerPerson, canPayWithCarry, coveragePct };
  }

  function renderMonthlyContributionPanel() {
    const pot = housePotSummary();
    const monthLabel = monthName(activeMonth());
    const statusLabel = pot.shortfall > 0
      ? `Faltan ${money(pot.shortfall)}`
      : pot.canPayWithCarry
        ? "Se puede cubrir con sobrante"
        : "Mes cubierto";
    const statusClass = pot.shortfall > 0 ? "danger" : pot.canPayWithCarry ? "gold" : "ok";
    const currentUserRow = pot.contributorRows.find(row => row.member.user_id === state.user?.id);
    const personalLine = currentUserRow
      ? `<div class="house-pot-personal"><span>Tu aporte acordado</span><strong>${money(currentUserRow.expected)}</strong><em>${currentUserRow.status}${currentUserRow.registered ? ` · registrado ${money(currentUserRow.registered)}` : ""}</em></div>`
      : "";
    const contributorHtml = pot.contributorRows.length
      ? pot.contributorRows.map(row => `<div class="house-pot-person-row"><span><b>${escapeHtml(memberName(row.member.user_id))}</b><em>${escapeHtml(row.status)}</em></span><strong>${money(row.expected)}</strong></div>`).join("")
      : `<div class="empty-state"><strong>Sin integrantes activos</strong>Activa los miembros que aportan al pote para calcular el fondo común.</div>`;
    const pendingHtml = pot.pending.length
      ? `<div class="house-pot-pending"><b>Pendientes de activar</b>${pot.pending.slice(0, 4).map(m => `<span>${escapeHtml(m.display_name || memberName(m.user_id) || "Integrante")}</span>`).join("")}</div>`
      : "";
    const expenseHtml = pot.sharedRows.length
      ? pot.sharedRows.slice(0, 8).map(row => `<div class="contribution-row house-pot-expense-row"><span><b>${escapeHtml(row.concept)}</b><em>${escapeHtml(row.category)}</em></span><strong>${money(row.amount)}</strong></div>`).join("")
      : `<div class="empty-state"><strong>Sin gastos compartidos este mes</strong>Cuando registres alquiler, agua, luz, gas, comida o internet como compartidos, saldrán de este pote.</div>`;
    const footerMessage = pot.shortfall > 0
      ? `El pote queda corto. Aporte extra sugerido: ${money(pot.extraPerPerson)} por integrante activo.`
      : pot.canPayWithCarry
        ? `El sobrante acumulado alcanza para pagar los gastos de ${escapeHtml(monthLabel)}. Si igual aportan ${money(HOUSE_POT_MONTHLY_CONTRIBUTION)} cada uno, el colchón crece.`
        : `Después de cubrir los gastos compartidos, quedan ${money(pot.remaining)} para pasar al próximo mes.`;
    return `<section class="section-card monthly-contribution-card house-pot-card">
      <div class="contribution-head house-pot-head">
        <div>
          <span class="analytics-pill">Pote del hogar</span>
          <h4>Fondo común de ${escapeHtml(monthLabel)}</h4>
          <p class="sub">Cada integrante activo aporta ${money(HOUSE_POT_MONTHLY_CONTRIBUTION)}. De ese pote salen alquiler, comida, internet, agua, luz, gas y demás gastos de casa.</p>
          ${personalLine}
        </div>
        <div class="contribution-big house-pot-big ${statusClass}">
          <span>Disponible para el mes</span>
          <strong>${money(Math.max(0, pot.remaining))}</strong>
          <em>${escapeHtml(statusLabel)}</em>
        </div>
      </div>
      <div class="house-pot-stats">
        <div><span>Aporte esperado</span><strong>${money(pot.expected)}</strong><em>${pot.contributors.length} integrante(s) activo(s)</em></div>
        <div><span>Sobrante acumulado</span><strong>${money(pot.previousCarry)}</strong><em>Viene de meses anteriores</em></div>
        <div><span>Gastos de casa</span><strong>${money(pot.spent)}</strong><em>Compartidos del mes</em></div>
        <div><span>Cobertura</span><strong>${pot.coveragePct}%</strong><em>${pot.shortfall > 0 ? "Necesita refuerzo" : "Cubierto"}</em></div>
      </div>
      <div class="house-pot-progress"><span style="width:${pot.coveragePct}%"></span></div>
      <div class="contribution-body house-pot-body">
        <div class="contribution-summary house-pot-summary"><b>${footerMessage}</b>${pendingHtml}</div>
        <div class="house-pot-people"><h5>Aportes acordados</h5>${contributorHtml}</div>
        <div class="house-pot-expenses"><h5>Gastos que salen del pote</h5><div class="contribution-list">${expenseHtml}</div></div>
      </div>
    </section>`;
  }

  function cssBarChart(monthsList, metric = "balance") {
    const series = monthsList.map(k => { const m = metricsFor(monthItems(k)); return { key:k, income:m.totalIncome, expense:m.totalExpense, balance:m.balance }; });
    const max = Math.max(1, ...series.map(s => Math.max(s.income, s.expense, Math.abs(s.balance))));
    return `<div class="chart-bars">${series.map(s => `<div class="chart-month"><div class="bar-stack"><i class="income" style="height:${(s.income/max)*100}%"></i><i class="expense" style="height:${(s.expense/max)*100}%"></i><i class="balance ${s.balance>=0?'pos':'neg'}" style="height:${(Math.abs(s.balance)/max)*100}%"></i></div><span>${String(s.key).slice(5)}</span></div>`).join("")}</div>`;
  }

  function horizontalBars(categories, total) {
    if (!categories.length) return `<div class="empty-state"><strong>Sin datos</strong>Registra gastos para ver categorías.</div>`;
    return `<div class="old-bar-list">${categories.map(c => `<div class="progress-row"><div class="progress-meta"><span>${escapeHtml(c.name)}</span><strong>${money(c.total)}</strong></div><div class="bar"><span style="width:${pct(c.total,total)}%"></span></div></div>`).join("")}</div>`;
  }

  function analyticsMonthsCount() {
    return Number(state.analytics?.periodMonths || 12);
  }

  function analyticsTopCount() {
    return Number(state.analytics?.top || 7);
  }

  function analyticsCategoryFilter(items) {
    const selected = state.analytics?.category || "all";
    if (selected === "all") return items;
    return items.filter(x => categoryName(x.category_id) === selected);
  }

  function analyticsReferenceKey() {
    if ((state.analytics?.compare || "prevMonth") === "lastYear") {
      return `${Number(yearOf()) - 1}-${String(monthNo()).padStart(2, "0")}`;
    }
    const d = new Date(Number(yearOf()), monthNo() - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  function analyticsReferenceLabel() {
    const key = analyticsReferenceKey();
    return (state.analytics?.compare || "prevMonth") === "lastYear"
      ? `Mismo mes ${yearOf(key)}`
      : monthName(key);
  }

  function expenseCategoriesFrom(items, limit = analyticsTopCount()) {
    return getExpenseCategories(analyticsCategoryFilter(items)).slice(0, limit);
  }

  function donutChart(categories, total, centerLabel = "Total") {
    if (!categories.length || total <= 0) {
      return `<div class="donut-empty"><strong>Sin datos</strong><span>Registra gastos para ver la dona.</span></div>`;
    }
    const palette = ["#6c63ff", "#4aa3ff", "#34d399", "#f59e0b", "#fb7185", "#8b5cf6", "#22c55e", "#f97316", "#14b8a6", "#e879f9"];
    let acc = 0;
    const stops = categories.map((c, i) => {
      const portion = Math.max(0, Number(c.total || 0)) / total * 100;
      const start = acc.toFixed(2);
      acc += portion;
      const end = acc.toFixed(2);
      return `${palette[i % palette.length]} ${start}% ${end}%`;
    }).join(', ');
    return `<div class="donut-layout"><div class="donut-ring" style="--donut-bg: conic-gradient(${stops});"><div class="donut-hole"><span>${escapeHtml(centerLabel)}</span><strong>${money(total)}</strong></div></div><div class="donut-legend">${categories.map((c, i) => `<div class="legend-item"><i style="background:${palette[i % palette.length]}"></i><span>${escapeHtml(c.name)}</span><strong>${pct(c.total, total)}%</strong></div>`).join("")}</div></div>`;
  }

  function dualDonutCompare(activeCats, refCats, activeTotal, refTotal, activeLabel, refLabel) {
    return `<div class="dual-donut-grid"><div class="mini-donut-card"><h5>${escapeHtml(activeLabel)}</h5>${donutChart(activeCats, activeTotal, 'Mes activo')}</div><div class="mini-donut-card"><h5>${escapeHtml(refLabel)}</h5>${donutChart(refCats, refTotal, 'Referencia')}</div></div>`;
  }

  function compareKpiCards(currentMetrics, refMetrics, refLabel) {
    const rows = [
      ["Ingresos", currentMetrics.totalIncome, refMetrics.totalIncome],
      ["Gastos", currentMetrics.totalExpense, refMetrics.totalExpense],
      ["Balance", currentMetrics.balance, refMetrics.balance],
      ["Ahorro", Math.max(0, currentMetrics.balance), Math.max(0, refMetrics.balance)]
    ];
    return `<div class="compare-kpi-grid">${rows.map(([label, current, ref]) => `<div class="compare-kpi"><span>${escapeHtml(label)}</span><strong>${money(current)}</strong><em>${signedMoney(current - ref)} vs ${escapeHtml(refLabel)}</em></div>`).join("")}</div>`;
  }

  function compareBars(currentMetrics, refMetrics, refLabel) {
    const rows = [
      { key: 'Ingresos', current: currentMetrics.totalIncome, ref: refMetrics.totalIncome },
      { key: 'Gastos', current: currentMetrics.totalExpense, ref: refMetrics.totalExpense },
      { key: 'Balance', current: Math.abs(currentMetrics.balance), ref: Math.abs(refMetrics.balance) }
    ];
    const max = Math.max(1, ...rows.flatMap(r => [r.current, r.ref]));
    return `<div class="compare-bars-panel">${rows.map(r => `<div class="compare-bar-row"><div class="compare-bar-head"><strong>${r.key}</strong><span>Mes activo vs ${escapeHtml(refLabel)}</span></div><div class="compare-bar-track"><i class="current" style="width:${(r.current / max) * 100}%"></i><i class="reference" style="width:${(r.ref / max) * 100}%"></i></div><div class="compare-bar-values"><span>${money(r.current)}</span><span>${money(r.ref)}</span></div></div>`).join("")}</div>`;
  }

  function ytdCompareChart(currentMetrics, prevMetrics) {
    const rows = [
      { label: 'Ingresos', current: currentMetrics.totalIncome, prev: prevMetrics.totalIncome },
      { label: 'Gastos', current: currentMetrics.totalExpense, prev: prevMetrics.totalExpense },
      { label: 'Balance', current: Math.abs(currentMetrics.balance), prev: Math.abs(prevMetrics.balance) },
      { label: 'Personal', current: Math.max(0, currentMetrics.balance), prev: Math.max(0, prevMetrics.balance) }
    ];
    const max = Math.max(1, ...rows.flatMap(r => [r.current, r.prev]));
    return `<div class="ytd-bars">${rows.map(r => `<div class="ytd-group"><div class="ytd-group-bars"><i class="prev" style="height:${(r.prev / max) * 100}%"></i><i class="current" style="height:${(r.current / max) * 100}%"></i></div><span>${escapeHtml(r.label)}</span></div>`).join("")}</div>`;
  }

  function categoryCompareTable(currentCats, refCats) {
    const map = new Map();
    currentCats.forEach(c => map.set(c.name, { name: c.name, current: c.total, ref: 0 }));
    refCats.forEach(c => map.set(c.name, { name: c.name, current: map.get(c.name)?.current || 0, ref: c.total }));
    const rows = [...map.values()].sort((a, b) => (b.current - b.ref) - (a.current - a.ref)).slice(0, analyticsTopCount());
    if (!rows.length) return `<div class="empty-state"><strong>Sin categorías</strong>No hay datos para comparar.</div>`;
    return `<div class="category-compare-table"><div class="cat-row cat-head"><span>Categoría</span><span>Mes activo</span><span>Referencia</span><span>Diferencia</span></div>${rows.map(r => `<div class="cat-row"><strong>${escapeHtml(r.name)}</strong><span>${money(r.current)}</span><span>${money(r.ref)}</span><span class="${(r.current - r.ref) >= 0 ? 'up' : 'down'}">${signedMoney(r.current - r.ref)}</span></div>`).join("")}</div>`;
  }

  function smartTips(items) {
    const m = metricsFor(items);
    const cats = getExpenseCategories(items);
    const over = m.totalExpense > m.totalIncome && m.totalIncome > 0;
    const budgetCats = cats.filter(c => c.total > 0).slice(0, 4);
    const tips = [];
    if (over) tips.push(["!", "Gastos por encima de ingresos", "Este mes gastas más de lo que entra. Revisa ocio, suscripciones, transporte y compras variables antes de tocar gastos esenciales."]);
    tips.push(["•", "Margen de ahorro muy bajo", `Has usado el ${pct(m.totalExpense, m.totalIncome)}% de los ingresos. Objetivo sano: bajar al 85% y luego al 75%.`]);
    if (budgetCats[0]) tips.push(["!", "Categoría dominante", `${budgetCats[0].name} pesa ${money(budgetCats[0].total)} este mes. Ahí está el primer sitio para mirar.`]);
    tips.push(["✓", "Gastos compartidos controlados", "Revisa el reparto por persona cada mes. En hogares compartidos lo justo no siempre es dividir igual: puede ser por ingresos, uso o responsabilidad."]);
    return tips.map(t => `<div class="advice"><span class="badge">${t[0]}</span><div><b>${escapeHtml(t[1])}</b><p>${escapeHtml(t[2])}</p></div></div>`).join("");
  }

  function renderDashboard() {
    const items = monthItems();
    const m = metricsFor(items);
    const periodMonths = analyticsMonthsCount();
    const monthsList = getMonthsRange(periodMonths);
    const referenceKey = analyticsReferenceKey();
    const referenceItems = analyticsCategoryFilter(monthItems(referenceKey));
    const refMetrics = metricsFor(referenceItems);
    const refLabel = analyticsReferenceLabel();
    const categories = expenseCategoriesFrom(items);
    const activeCategories = expenseCategoriesFrom(items);
    const refCategories = expenseCategoriesFrom(monthItems(referenceKey));
    const yearItemsList = analyticsCategoryFilter(yearlyItems());
    const ym = metricsFor(yearItemsList);
    const prevYearItems = analyticsCategoryFilter(getVisibleMovements().filter(x => String(x.date || '').slice(0,4) === String(activeYear() - 1) && Number(String(x.date || '').slice(5,7) || 0) <= monthNo()));
    const prevYearMetrics = metricsFor(prevYearItems);
    const selectedCategoryLabel = state.analytics?.category && state.analytics.category !== 'all' ? ` · ${state.analytics.category}` : '';
    const monthsWithData = new Set(yearItemsList.map(x => String(x.date).slice(0,7))).size;
    const visibleYearMonths = Array.from({ length: monthNo() }, (_, i) => `${activeYear()}-${String(i + 1).padStart(2, "0")}`);
    const bestMonth = visibleYearMonths
      .map(key => ({ key, metrics: metricsFor(monthItems(key)) }))
      .sort((a, b) => b.metrics.balance - a.metrics.balance)[0];
    const totalCategory = activeCategories.reduce((a,c)=>a + Number(c.total || 0),0);
    const topCategory = activeCategories[0];
    return `
      ${periodToolbar()}
      <section class="section-header old-title-row"><div class="section-icon-row"><div class="section-badge">📊</div><div><h3>Panel principal</h3><p>Resumen limpio del mes activo: primero el pote del hogar, luego tendencias, categorías y comparaciones. Sin repetir datos.</p></div></div></section>
      ${renderMonthlyContributionPanel()}
      <section class="section-card analytics-toolbar old-analysis">
        <div class="analytics-toolbar-head">
          <div class="analytics-title-block">
            <span class="analytics-pill">Análisis</span>
            <h4>Panel de análisis dinámico</h4>
            <p>Ajusta periodo, comparación, tipo de dato y categoría. La información repetida se consolidó para que cada bloque tenga un propósito claro.</p>
          </div>
          <div class="analytics-summary-card">
            <span>Vista actual</span>
            <strong>${periodMonths} meses</strong>
            <em>${escapeHtml(refLabel)}</em>
          </div>
        </div>
        <div class="analytics-controls analytics-controls-pro">
          <div class="field analytics-field"><label>Periodo</label><select id="analyticsPeriod"><option value="12" ${periodMonths===12?'selected':''}>Últimos 12 meses</option><option value="6" ${periodMonths===6?'selected':''}>Últimos 6 meses</option></select></div>
          <div class="field analytics-field"><label>Comparar con</label><select id="analyticsCompare"><option value="prevMonth" ${state.analytics.compare==='prevMonth'?'selected':''}>Mes anterior</option><option value="lastYear" ${state.analytics.compare==='lastYear'?'selected':''}>Mismo mes año anterior</option></select></div>
          <div class="field analytics-field analytics-field-wide"><label>Dato principal</label><select id="filterType"><option value="all" ${state.filters.movementType==='all'?'selected':''}>Ingresos, gastos y balance</option><option value="income" ${state.filters.movementType==='income'?'selected':''}>Solo ingresos</option><option value="expense" ${state.filters.movementType==='expense'?'selected':''}>Solo gastos</option></select></div>
          <div class="field analytics-field analytics-field-wide"><label>Categoría</label><select id="analyticsCategory"><option value="all" ${state.analytics.category==='all'?'selected':''}>Todas las categorías</option>${state.categories.map(c=>`<option value="${escapeHtml(c.name)}" ${state.analytics.category===c.name?'selected':''}>${escapeHtml(c.name)}</option>`).join("")}</select></div>
          <div class="field analytics-field analytics-field-small"><label>Mostrar</label><select id="topCategoriesLimit"><option value="7" ${analyticsTopCount()===7?'selected':''}>Top 7</option><option value="5" ${analyticsTopCount()===5?'selected':''}>Top 5</option><option value="10" ${analyticsTopCount()===10?'selected':''}>Top 10</option></select></div>
        </div>
      </section>
      <section class="grid-2 old-dashboard-grid analytics-main-grid ux-dashboard-main-grid">
        <article class="section-card chart-card-large ux-primary-chart"><h4>Evolución mensual · ingresos, gastos y balance${escapeHtml(selectedCategoryLabel)}</h4><p class="sub">Tendencia principal de la vista activa. Es la gráfica grande porque responde la pregunta: ¿voy mejor o peor?</p>${cssBarChart(monthsList)}<div class="reading-box"><b>Lectura dinámica:</b> En ${monthName(activeMonth())}, ingresos ${money(m.totalIncome)}, gastos ${money(m.totalExpense)} y balance ${money(m.balance)}.</div></article>
        <article class="section-card compact-card ux-category-card"><h4>Gastos del mes por categoría</h4><p class="sub">Una sola lectura por categorías para evitar duplicar tortas, barras y porcentajes con el mismo dato.</p>${horizontalBars(categories, Math.max(1, m.totalExpense))}<div class="reading-box"><b>Lectura dinámica:</b> ${topCategory ? `${topCategory.name} concentra ${money(topCategory.total)} (${pct(topCategory.total, totalCategory)}%).` : "Aún no hay gastos para analizar."}</div></article>
      </section>
      <section class="grid-2 old-dashboard-grid analytics-compare-grid ux-executive-grid">
        <article class="section-card ux-year-summary-card"><h4>Resumen anual</h4><p class="sub">Acumulado del año activo y comparación con el mismo tramo del año anterior.</p><div class="indicator-grid ux-indicator-grid"><div><span>Ingresos anuales</span><strong>${money(ym.totalIncome)}</strong></div><div><span>Gastos anuales</span><strong>${money(ym.totalExpense)}</strong></div><div><span>Balance anual</span><strong>${money(ym.balance)}</strong></div><div><span>Promedio gasto/mes</span><strong>${money(ym.totalExpense / Math.max(1, monthNo()))}</strong></div><div><span>Mejor mes</span><strong>${bestMonth ? monthName(bestMonth.key) : "Sin datos"}</strong></div><div><span>Meses con datos</span><strong>${monthsWithData}/12</strong></div></div>${ytdCompareChart(ym, prevYearMetrics)}<div class="reading-box"><b>Lectura dinámica:</b> Acumulado ${activeYear()}: ingresos ${money(ym.totalIncome)}, gastos ${money(ym.totalExpense)} y balance ${money(ym.balance)}. Año anterior: ${money(prevYearMetrics.balance)} de balance.</div></article>
        <article class="section-card ux-month-compare-card"><h4>Comparador ejecutivo</h4><p class="sub">Cruza el mes activo contra ${escapeHtml(refLabel.toLowerCase())}: ingresos, gastos, balance y ahorro.</p>${compareKpiCards(m, refMetrics, refLabel)}${compareBars(m, refMetrics, refLabel)}<div class="reading-box"><b>Lectura dinámica:</b> ${refLabel}: ingresos ${money(refMetrics.totalIncome)}, gastos ${money(refMetrics.totalExpense)} y balance ${money(refMetrics.balance)}.</div></article>
      </section>
      <section class="grid-2 old-dashboard-grid analytics-compare-grid ux-detail-grid">
        <article class="section-card ux-category-compare-card"><h4>Categorías: mes activo vs referencia</h4><p class="sub">Detecta qué partidas suben o bajan contra el periodo de comparación. Sustituye la dona comparativa duplicada.</p>${categoryCompareTable(activeCategories, refCategories)}</article>
      </section>
`;
  }

  function renderRegister() {
    return `
      <section class="section-header"><div class="section-icon-row"><div class="section-badge">🖊️</div><div><h3>Registrar movimientos</h3><p>Primero eliges qué necesitas registrar; la app muestra el formulario correcto para evitar duplicados y errores.</p></div></div></section>
      <div class="help-banner"><span class="hb-icon">ℹ️</span><div><strong>La lógica queda separada por dentro, pero ordenada por fuera.</strong> Usa movimientos puntuales para pagos únicos y recurrentes para nóminas, servicios variables, deudas o cuotas.</div></div>
      <article class="section-card register-flow-card"><h4>¿Qué quieres registrar?</h4><div class="register-choice-grid" id="registerFlowChoices"><button class="register-choice-btn active" data-flow-target="incomePanel" type="button"><b>➕ Ingreso puntual</b><span>Nómina cobrada una vez, factura, venta, freelance o dinero que entra este mes.</span></button><button class="register-choice-btn" data-flow-target="expensePanel" type="button"><b>➖ Gasto puntual</b><span>Compra, factura pagada, comida, transporte o gasto único del mes.</span></button><button class="register-choice-btn" data-flow-target="recurringPanel" type="button"><b>↻ Recurrente, deuda o servicio variable</b><span>Pagos que se repiten, cambian de importe o necesitan planificación.</span></button></div><div class="register-flow-hint">Tip: los gastos comunes deben marcarse como compartidos para que aparezcan en Aportes y Casa común.</div></article>
      <section class="register-single-grid">
        <article class="section-card register-panel" id="incomePanel"><h4 id="incomeFormTitle">Nuevo ingreso puntual</h4><form id="incomeForm"><input name="id" type="hidden" /><div class="inline-grid"><div class="field"><label>Concepto</label><input name="concept" required placeholder="Ej. Nómina DirectMarkt" /></div><div class="field"><label>Monto</label><input name="amount" type="number" step="0.01" min="0" required placeholder="0,00" /></div></div><div class="inline-grid"><div class="field"><label>Fecha</label><input name="date" type="date" value="${todayISO()}" /></div><div class="field"><label>Categoría</label><select name="category_id">${categoryOptions("income")}</select></div></div><div class="field"><label>Miembro</label><select name="member_id">${memberOptions(state.user.id)}</select></div><div class="field"><label>Notas</label><textarea name="notes" placeholder="Opcional"></textarea></div><div class="form-actions"><button class="btn primary" id="saveIncomeBtn" type="submit">Guardar ingreso</button><button class="btn ghost" type="button" id="cancelIncomeEdit" hidden>Cancelar edición</button></div></form></article>
        <article class="section-card register-panel" id="expensePanel"><h4 id="expenseFormTitle">Nuevo gasto puntual</h4><form id="expenseForm"><input name="id" type="hidden" /><div class="inline-grid"><div class="field"><label>Concepto</label><input name="concept" required placeholder="Ej. Compra, gas, comida, gasolina" /></div><div class="field"><label>Monto total</label><input name="amount" type="number" step="0.01" min="0" required placeholder="0,00" /></div></div><div class="inline-grid"><div class="field"><label>Fecha</label><input name="date" type="date" value="${todayISO()}" /></div><div class="field"><label>Categoría</label><select name="category_id">${categoryOptions("expense")}</select></div></div><div class="inline-grid"><div class="field"><label>Responsable</label><select name="member_id">${memberOptions(state.user.id)}</select></div><div class="field"><label>Tipo de gasto</label><select name="kind"><option value="personal">Personal</option><option value="shared">Compartido / casa</option><option value="debt">Deuda</option><option value="vehicle">Vehículo</option></select></div></div><label class="switch-row"><span><strong>¿Gasto compartido?</strong><br><span class="hint">Alquiler, comida de casa, luz, agua, gas, internet...</span></span><input name="is_shared" type="checkbox" /></label><div class="field"><label>Método de reparto</label><select name="share_method"><option value="equal">Partes iguales</option><option value="income">Según ingresos</option><option value="manual">Manual</option></select></div><div class="field"><label>Notas</label><textarea name="notes" placeholder="Opcional"></textarea></div><div class="form-actions"><button class="btn primary" id="saveExpenseBtn" type="submit">Guardar gasto</button><button class="btn ghost" type="button" id="cancelExpenseEdit" hidden>Cancelar edición</button></div></form></article>
        <article class="section-card register-panel" id="recurringPanel"><h3>Recurrentes, deudas y servicios variables</h3><form id="recurringForm"><input name="id" type="hidden" /><h4 id="recurringFormTitle">Nuevo recurrente o servicio variable</h4><div class="inline-grid"><div class="field"><label>Concepto</label><input name="description" required placeholder="Ej. Nómina, luz, agua, gas, crédito coche, comida de Papito" /></div><div class="field"><label>Importe mensual / estimado</label><input name="amount" type="number" step="0.01" min="0" required placeholder="0,00" /></div></div><div class="inline-grid"><div class="field"><label>Empieza en</label><input name="start_date" type="date" value="${todayISO()}" /></div><div class="field"><label>Categoría</label><select name="category_id">${categoryOptions()}</select></div></div><div class="inline-grid"><div class="field"><label>Persona</label><select name="member_id">${memberOptions(state.user.id)}</select></div><div class="field"><label>Tipo de automático</label><select name="type"><option value="expense">Gasto</option><option value="income">Ingreso</option></select></div></div><div class="inline-grid"><div class="field"><label>Día de cargo</label><input name="day_of_month" type="number" min="1" max="31" value="1" /></div><div class="field"><label>Frecuencia</label><select name="frequency"><option value="monthly">Mensual</option><option value="bimonthly">Bimensual</option><option value="yearly">Anual</option></select></div></div><div class="inline-grid"><div class="field"><label>Tipo de importe</label><select name="amount_mode"><option value="fixed">Fijo</option><option value="variable">Variable</option></select></div><div class="field"><label>¿Hasta cuándo se repite?</label><select name="end_mode"><option value="indefinite">Indefinido</option><option value="months">Por meses</option><option value="years">Por años</option><option value="date">Hasta fecha</option></select></div></div><div class="inline-grid"><div class="field"><label>Nº de meses</label><input name="fixed_months" type="number" min="1" placeholder="Si elegiste por meses" /></div><div class="field"><label>Nº de años / fecha fin</label><div class="inline-grid compact-inner"><input name="fixed_years" type="number" min="1" placeholder="Años" /><input name="end_date" type="date" /></div></div></div><h4>Datos de deuda o préstamo</h4><div class="inline-grid"><div class="field"><label>Importe total original</label><input name="debt_original_amount" type="number" step="0.01" placeholder="Ej. 11000" /></div><div class="field"><label>Entidad / referencia</label><input name="debt_lender" placeholder="Ej. Sofinco, Campus Training" /></div></div><label class="switch-row"><span><strong>¿Automático compartido?</strong><br><span class="hint">Útil para alquiler, luz, agua, gas, internet o comida de casa.</span></span><input name="is_shared" type="checkbox" /></label><label class="switch-row"><span><strong>Activo</strong><br><span class="hint">Desactívalo cuando ya no aplique.</span></span><input name="active" type="checkbox" checked /></label><div class="field"><label>Notas</label><textarea name="notes" placeholder="Cuota coche, agua bimensual, comida mensual del perro..."></textarea></div><div class="form-actions"><button class="btn primary" id="saveRecurringBtn" type="submit">Guardar automático</button><button class="btn ghost" type="button" id="cancelRecurringEdit" hidden>Cancelar edición</button></div></form></article>
      </section>`;
  }

  function renderMovements() {
    const items = getMovementsFiltered();
    const extra = `<div class="field"><label>Tipo</label><select id="filterType"><option value="all" ${state.filters.movementType === "all" ? "selected" : ""}>Todos</option><option value="income" ${state.filters.movementType === "income" ? "selected" : ""}>Ingresos</option><option value="expense" ${state.filters.movementType === "expense" ? "selected" : ""}>Gastos</option></select></div>`;
    const categoryFilter = `<div class="field"><label>Categoría</label><select id="filterCategory"><option value="all" ${state.filters.category === "all" ? "selected" : ""}>Todas</option>${state.categories.map(c=>`<option value="${c.id}" ${state.filters.category === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</select></div>`;
    const searchFilter = `<div class="field"><label>Buscar</label><input id="filterSearch" value="${escapeHtml(state.filters.search || "")}" placeholder="Concepto, nota, categoría o persona" /></div>`;
    const sortFilter = `<div class="field"><label>Ordenar por</label><select id="filterSortField"><option value="date" ${state.filters.sortField === "date" ? "selected" : ""}>Fecha</option><option value="amount" ${state.filters.sortField === "amount" ? "selected" : ""}>Importe</option><option value="concept" ${state.filters.sortField === "concept" ? "selected" : ""}>Concepto</option><option value="category" ${state.filters.sortField === "category" ? "selected" : ""}>Categoría</option><option value="member" ${state.filters.sortField === "member" ? "selected" : ""}>Persona</option><option value="type" ${state.filters.sortField === "type" ? "selected" : ""}>Tipo</option></select></div><div class="field"><label>Dirección</label><select id="filterSortDirection"><option value="desc" ${state.filters.sortDirection !== "asc" ? "selected" : ""}>Descendente</option><option value="asc" ${state.filters.sortDirection === "asc" ? "selected" : ""}>Ascendente</option></select></div>`;
    return `<section class="section-header"><div class="section-icon-row"><div class="section-badge">📋</div><div><h3>Movimientos del mes</h3><p>Consulta, filtra, edita y elimina según tus permisos.</p></div></div></section><article class="section-card">${periodToolbar()}<div class="filters">${categoryFilter}${extra}${searchFilter}${sortFilter}</div>${renderMovementTable(items, true)}</article>`;
  }

  function renderRecurring() {
    const recurringItems = visibleRecurringItems();
    return `<section class="section-header"><div class="section-icon-row"><div class="section-badge">🔁</div><div><h3>Recurrentes configurados</h3><p>Pagos, ingresos, deudas y servicios variables que se repiten.</p></div></div></section><article class="section-card"><h4>Automáticos y servicios configurados</h4>${recurringItems.length ? `<div class="table-wrap"><table><thead><tr><th>Concepto</th><th>Tipo</th><th>Importe</th><th>Día</th><th>Frecuencia</th><th>Persona</th><th>Compartido</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${recurringItems.map(r=>{ const actions = canManageRecurringRecord(r) ? `<div class="td-actions"><button class="btn small" data-edit-recurring="${r.id}">Editar</button><button class="btn small warn" data-toggle-recurring="${r.id}">${r.active!==false?'Pausar':'Activar'}</button><button class="btn small danger" data-delete-recurring="${r.id}">Borrar</button></div>` : `<span class="hint">Solo lectura</span>`; return `<tr><td>${escapeHtml(r.description)}</td><td>${r.type==='income'?'Ingreso':'Gasto'}</td><td><strong>${money(r.amount)}</strong></td><td>${escapeHtml(r.day_of_month || '-')}</td><td>${escapeHtml(r.frequency || 'monthly')}</td><td>${escapeHtml(memberName(r.member_id || r.user_id))}</td><td>${r.is_shared?'Sí':'No'}</td><td>${r.active!==false?'Activo':'Inactivo'}</td><td>${actions}</td></tr>`; }).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>Sin recurrentes todavía</strong>Créalo desde Registrar.</div>`}</article>`;
  }

  function renderHousehold() {
    const personScope = canSeeAll() ? "all" : "me";
    const items = movementsForMonthPerson(activeMonth(), personScope, { respectType: false });
    const commonItems = getVisibleMovements().filter(x => x.type === "expense" && x.is_shared && isSameMonth(x.date, activeMonth()));
    const title = canSeeAll() ? "Aportes del hogar y ahorro por persona" : "Mi aporte y gastos compartidos";
    const subtitle = canSeeAll()
      ? "Contabilidad doméstica avanzada: quién ingresa, quién paga, qué parte corresponde a cada persona y cuánto podría ahorrar cada miembro."
      : "Aquí ves tus ingresos, tus gastos personales y la parte que te corresponde de los gastos compartidos. Lo privado de otros integrantes no se muestra.";
    return `<section class="section-header"><div class="section-icon-row"><div class="section-badge">👨‍👩‍👧‍👦</div><div><h3>${title}</h3><p>${subtitle}</p></div></div></section><div class="help-banner"><span class="hb-icon">🧭</span><div><strong>Cómo leer esta sección:</strong> crea miembros, registra ingresos y marca como compartidos los gastos comunes como luz, agua, gas, internet, alquiler o comida.</div></div><div class="guide-steps"><div class="guide-step-card"><span class="step-marker">1</span><div><b>Elige el mes</b><span>Todo se calcula sobre el mes activo.</span></div></div><div class="guide-step-card"><span class="step-marker">2</span><div><b>Crea el hogar</b><span>Añade adultos y dependientes.</span></div></div><div class="guide-step-card"><span class="step-marker">3</span><div><b>Registra ingresos</b><span>Nóminas por persona.</span></div></div><div class="guide-step-card"><span class="step-marker">4</span><div><b>Marca gastos comunes</b><span>Divide servicios y alquiler.</span></div></div><div class="guide-step-card"><span class="step-marker">5</span><div><b>Revisa aportes</b><span>Consulta cuánto paga cada persona.</span></div></div></div>${renderMonthlyContributionPanel()}<div class="household-summary-grid">${householdKpis(items)}</div><div class="household-grid"><article class="section-card"><h4>${canSeeAll() ? 'Resumen por persona' : 'Mi resumen'}</h4><p class="sub">Ingresos, gastos personales, parte compartida, aporte real y ahorro estimado.</p><div class="advice-list">${renderMemberContributions(items)}</div></article><article class="section-card"><h4>Gastos comunes del mes</h4><p class="sub">Gastos marcados como compartidos${canSeeAll() ? ' y cómo se reparten.' : ' y tu parte estimada.'}</p><div class="advice-list">${renderCommonExpenses(commonItems)}</div></article></div><article class="section-card" style="margin-top:14px"><h4>Lectura rápida</h4><div class="advice-list">${renderHouseholdInsights(items)}</div></article>`;
  }

  function householdKpis(items) {
    const m = metricsFor(items);
    const contributors = contributionMembers();
    const sharedPer = m.sharedExpense / Math.max(1, contributors.length);
    const scope = canSeeAll() ? "hogar" : "mi vista";
    const sharedLabel = canSeeAll() ? "Gasto común" : "Mi parte común";
    return `<div class="household-kpi"><span>${canSeeAll() ? 'Ingresos hogar' : 'Mis ingresos'}</span><strong>${money(m.totalIncome)}</strong><em>${scope}</em></div><div class="household-kpi"><span>${sharedLabel}</span><strong>${money(m.sharedExpense)}</strong><em>${canSeeAll() ? `${contributors.length || 1} aportantes activos` : 'Compartidos asignados'}</em></div><div class="household-kpi"><span>${canSeeAll() ? 'Parte promedio' : 'Ahorro estimado'}</span><strong>${money(canSeeAll() ? sharedPer : Math.max(0, m.balance))}</strong><em>${canSeeAll() ? 'Promedio por aportante' : 'Según tu vista'}</em></div><div class="household-kpi"><span>Balance</span><strong>${money(m.balance)}</strong><em>${m.balance>=0?'Positivo':'Negativo'}</em></div>`;
  }

  function renderMemberContributions() {
    const members = canSeeAll()
      ? activeHouseholdMembers()
      : activeHouseholdMembers().filter(m => m.user_id === state.user?.id);
    const safeMembers = members.length ? members : [{ user_id: state.user?.id }];
    if (!safeMembers.length || !safeMembers[0]?.user_id) return `<div class="empty-state"><strong>Sin miembros</strong>Agrega integrantes o invita usuarios.</div>`;
    return safeMembers.map(mem => {
      const id = mem.user_id;
      const mine = movementsForMonthPerson(activeMonth(), id, { respectType: false });
      const mm = metricsFor(mine);
      const sharedAssigned = sum(mine.filter(x => x.type === "expense" && x.is_shared), x => x.amount);
      return `<div class="person-summary-card"><header><h5>${escapeHtml(memberName(id))}${mem.dependent ? ' <span class="hint">· Dependiente</span>' : ''}</h5><span class="settlement-pill ${mm.balance>=0?'positive':'negative'}">${money(mm.balance)}</span></header><div class="person-grid"><div class="mini-stat"><span>Ingresos</span><strong>${money(mm.totalIncome)}</strong></div><div class="mini-stat"><span>Gastos propios</span><strong>${money(mm.totalExpense - sharedAssigned)}</strong></div><div class="mini-stat"><span>Parte común</span><strong>${money(sharedAssigned)}</strong></div></div></div>`;
    }).join("");
  }

  function renderCommonExpenses(items) {
    const shared = items.filter(x => x.type === "expense" && x.is_shared);
    const members = contributionMembers();
    if (!shared.length) return `<div class="empty-state"><strong>Sin gastos comunes</strong>Marca gastos como compartidos para ver el reparto.</div>`;
    return shared.map(x => {
      const total = Number(x._original_amount || x.amount || 0);
      if (!canSeeAll()) {
        const myPart = total * memberShareRatio(state.user?.id, x);
        return `<div class="common-expense-row"><header><b>${escapeHtml(x.description || categoryName(x.category_id))}</b><strong>${money(total)}</strong></header><div class="mini-share-list">Tu parte estimada: ${money(myPart)} · ${escapeHtml(categoryName(x.category_id))}</div></div>`;
      }
      return `<div class="common-expense-row"><header><b>${escapeHtml(x.description || categoryName(x.category_id))}</b><strong>${money(total)}</strong></header><div class="mini-share-list">${members.map(m=>`${escapeHtml(memberName(m.user_id))}: ${money(total * memberShareRatio(m.user_id, x))}`).join(" · ")}</div></div>`;
    }).join("");
  }

  function renderHouseholdInsights(items) {
    const m = metricsFor(items);
    const label = canSeeAll() ? "Hogar" : "Tu vista";
    return `<div class="advice ok"><span>✓</span><div><b>Dato guardado</b><p>Cada registro queda en PostgreSQL/Supabase, no en caché del navegador.</p></div></div><div class="advice ${m.balance>=0?'ok':'warn'}"><span class="badge">${m.balance>=0?'✓':'!'}</span><div><b>${m.balance>=0?`${label} en positivo`:`${label} en negativo`}</b><p>Balance del mes: ${money(m.balance)}.</p></div></div>`;
  }

  function renderMembersSection() {
    return `<section class="section-header"><div class="section-icon-row"><div class="section-badge">🏠</div><div><h3>Miembros del hogar</h3><p>Administra integrantes, roles y participación. Los ingresos reales se registran desde la sección Registrar.</p></div></div></section>
    <section class="members-grid">
      <article class="section-card"><h4 id="memberFormTitle">Nuevo miembro / invitación</h4>
        <form id="memberForm">
          <input name="member_id" type="hidden" />
          <div class="field"><label>Tipo de hogar</label><select name="household_type"><option value="family">Familia</option><option value="shared">Piso compartido</option><option value="couple">Pareja</option><option value="single">Una persona</option></select></div>
          <div class="field"><label>Nombre visible</label><input name="full_name" placeholder="Ej. Mercedes" /></div>
          <div class="field"><label>Email para invitar</label><input name="email" type="email" placeholder="correo@dominio.com" /><p class="hint">Para editar un miembro existente no hace falta cambiar el email. El nombre visible se guarda en el hogar.</p></div>
          <div class="inline-grid"><div class="field"><label>% participación sugerido</label><input name="participation_percent" type="number" step="0.01" placeholder="Ej. 50" /></div><div class="field"><label>Rol de acceso</label><select name="role"><option value="member">Miembro</option><option value="viewer">Solo lectura</option><option value="admin">Administrador</option></select></div></div>
          <div class="field"><label>Estado</label><select name="status"><option value="active">Activo</option><option value="disabled">Inactivo</option></select></div>
          <label class="switch-row"><span>Es dependiente</span><input name="dependent" type="checkbox" /></label>
          <div class="form-actions"><button class="btn primary" type="submit" id="saveMemberBtn">Guardar / invitar</button><button class="btn ghost hidden" type="button" id="cancelMemberEdit">Cancelar edición</button></div>
        </form>
      </article>
      <article class="section-card"><h4>Personas registradas</h4>${renderMembersAdmin()}</article>
    </section>`;
  }

  function renderCategories() {
    return `<section class="section-header"><div class="section-icon-row"><div class="section-badge">🏷️</div><div><h3>Categorías y presupuestos</h3><p>Organiza ingresos y gastos con presupuesto mensual para detectar excesos.</p></div></div></section><section class="categories-grid"><article class="section-card"><h4 id="categoryFormTitle">Nueva categoría</h4><form id="categoryForm"><input name="id" type="hidden" /><div class="field"><label>Nombre</label><input name="name" required placeholder="Ej. Mascotas" /></div><div class="inline-grid"><div class="field"><label>Tipo</label><select name="type"><option value="expense">Gasto</option><option value="income">Ingreso</option><option value="both">Ambos</option></select></div><div class="field"><label>Presupuesto mensual</label><input name="budget" type="number" step="0.01" placeholder="Solo gastos" /></div></div><div class="field"><label>Color</label><input name="color" type="color" value="#4aa8ff" /></div><div class="form-actions"><button class="btn primary" id="saveCategoryBtn" type="submit">Guardar categoría</button><button class="btn ghost" type="button" id="cancelCategoryEdit" hidden>Cancelar edición</button></div></form></article><article class="section-card"><h4>Listado de categorías</h4>${state.categories.length ? `<div class="table-wrap"><table><thead><tr><th>Nombre</th><th>Tipo</th><th>Presupuesto</th><th>Color</th><th>Acciones</th></tr></thead><tbody>${state.categories.map(c=>`<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.type)}</td><td>${money(c.budget || 0)}</td><td><span class="tag" style="background:${escapeHtml(c.color || '#4aa8ff')};color:white">${escapeHtml(c.color || '')}</span></td><td><div class="td-actions"><button class="btn small" data-edit-category="${c.id}">Editar</button><button class="btn small danger" data-delete-category="${c.id}">Borrar</button></div></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>Sin categorías</strong>Crea tus primeras categorías.</div>`}</article></section>`;
  }

  function renderGoals() {
    return `<section class="section-header"><div class="section-icon-row"><div class="section-badge">🎯</div><div><h3>Metas de ahorro</h3><p>Objetivos personales o familiares con progreso, fecha límite y notas.</p></div></div></section><section class="goals-grid"><article class="section-card"><h4 id="goalFormTitle">Nueva meta de ahorro</h4><form id="goalForm"><input name="id" type="hidden" /><div class="field"><label>Nombre de la meta</label><input name="name" required placeholder="Ej. Fondo de emergencia, Vacaciones 2026" /></div><div class="inline-grid"><div class="field"><label>Importe objetivo (€)</label><input name="target_amount" type="number" step="0.01" required /></div><div class="field"><label>Ahorro acumulado (€)</label><input name="current_amount" type="number" step="0.01" value="0" /></div></div><div class="inline-grid"><div class="field"><label>Fecha límite</label><input name="deadline" type="date" /></div><div class="field"><label>Icono</label><select name="emoji"><option>🎯</option><option>🏠</option><option>🚗</option><option>✈️</option><option>🛟</option><option>💰</option></select></div></div><div class="field"><label>Notas</label><textarea name="notes" placeholder="Describe para qué es esta meta o cómo vas a ahorrar"></textarea></div><div class="form-actions"><button class="btn primary" id="saveGoalBtn" type="submit">Guardar meta</button><button class="btn ghost" type="button" id="cancelGoalEdit" hidden>Cancelar edición</button></div></form></article><article class="section-card"><h4>Mis metas</h4>${state.goals.length ? state.goals.map(g=>{ const p = pct(g.current_amount, g.target_amount); return `<div class="goal-card"><header><h5>${escapeHtml(g.emoji || '🎯')} ${escapeHtml(g.name)}</h5><div class="td-actions"><button class="btn small" data-edit-goal="${g.id}">Editar</button><button class="btn small danger" data-delete-goal="${g.id}">Borrar</button></div></header><div class="goal-progress-info"><span>${money(g.current_amount)} / ${money(g.target_amount)}</span><b>${p}%</b></div><div class="goal-bar"><span style="width:${p}%"></span></div><p class="hint">${escapeHtml(g.notes || '')}</p></div>`; }).join("") : `<div class="empty-state"><strong>Sin metas todavía</strong>Añade tu primer objetivo de ahorro.</div>`}</article></section>`;
  }

  function renderVehicles() {
    const totalYear = vehicleTotalSpent(null, activeYear());
    const vehicleRecords = visibleVehicleRecordItems();
    const vehicles = visibleVehicleItems();
    const activeInsurances = vehicleRecords.filter(r=>r.type==='insurance' && r.status !== 'cancelado').length;
    const alerts = vehicleRecords.filter(r=>r.next_date || r.coverage_end).slice(0,8);
    return `<section class="section-header"><div class="section-icon-row"><div class="section-badge">🚘</div><div><h3>Vehículos, seguros y mantenimiento</h3><p>Controla coches y motos: seguros anuales, cuotas financiadas, revisiones, aceite, neumáticos, repuestos, reparaciones y próximos avisos.</p></div></div></section><div class="help-banner"><span class="hb-icon">🛠️</span><div><strong>Cómo usar este módulo:</strong> primero registra cada vehículo. Después añade seguros, mantenimientos o repuestos. Los importes con fecha se suman como gasto de vehículo en el mes correspondiente.</div></div><article class="section-card"><h4>Flujo recomendado para controlar tus vehículos</h4><div class="vehicle-flow-grid"><a class="vehicle-flow-step" href="#vehicleForm"><span>1</span><b>Registrar vehículo</b><em>Coche, moto, matrícula y responsable.</em></a><a class="vehicle-flow-step" href="#vehicleInsuranceForm"><span>2</span><b>Añadir seguro</b><em>Al contado o financiado por cuotas.</em></a><a class="vehicle-flow-step" href="#vehicleRecordForm"><span>3</span><b>Mantenimiento</b><em>Aceite, neumáticos, ITV, frenos, batería.</em></a><a class="vehicle-flow-step" href="#vehicleRecordsList"><span>4</span><b>Revisar historial</b><em>Consulta gastos y próximos avisos.</em></a></div></article><section class="vehicle-kpi-grid"><article class="metric"><small>Vehículos</small><strong>${vehicles.length}</strong><em>Coches, motos u otros activos</em></article><article class="metric"><small>Gasto anual vehículo</small><strong>${money(totalYear)}</strong><em>Año ${activeYear()}</em></article><article class="metric"><small>Seguros activos</small><strong>${activeInsurances}</strong><em>Pólizas o planes registrados</em></article><article class="metric"><small>Avisos próximos</small><strong>${alerts.length}</strong><em>Mantenimientos o vencimientos</em></article></section><div class="vehicles-grid"><article class="section-card">${renderVehicleForm()}</article><article class="section-card"><h4><span class="step-marker soft">1B</span>Vehículos registrados</h4>${renderVehicleList()}</article></div><div class="vehicle-panel-grid"><article class="section-card">${renderInsuranceForm()}</article><article class="section-card">${renderVehicleRecordForm()}</article></div><div class="vehicle-panel-grid"><article class="section-card"><h4><span class="step-marker soft">4</span>Seguros registrados</h4>${renderVehicleRecordsTable(vehicleRecords.filter(r=>r.type==='insurance'))}</article><article class="section-card"><h4><span class="step-marker soft">5</span>Alertas y próximos avisos</h4>${alerts.length ? renderVehicleRecordsTable(alerts) : `<div class="empty-state"><strong>Sin avisos urgentes</strong>Cuando una revisión, ITV, aceite, neumáticos o próximo kilometraje esté cerca, aparecerá aquí.</div>`}</article></div><article class="section-card" id="vehicleRecordsList"><h4><span class="step-marker soft">6</span>Historial de mantenimiento y gastos</h4>${renderVehicleRecordsTable(vehicleRecords.filter(r=>r.type!=='insurance'))}</article>`;
  }

  function renderHistory() {
    const years = [...new Set([...getVisibleMovements(), ...visibleVehicleRecordItems()].map(x=>String(x.date||'').slice(0,4)).filter(Boolean))].sort().reverse();
    const year = state.filters.year || String(new Date().getFullYear());
    const now = new Date();
    const selectedYear = Number(year);
    const currentYear = now.getFullYear();
    const currentMonthNo = now.getMonth() + 1;
    const lastVisibleMonth = selectedYear < currentYear ? 12 : selectedYear === currentYear ? currentMonthNo : 0;
    const monthKeys = Array.from({length: Math.max(0, lastVisibleMonth)},(_,i)=>`${year}-${String(i+1).padStart(2,'0')}`);
    const monthly = monthKeys.map(k=>({key:k, ...metricsFor(monthItems(k,'all'))}));
    const displayMonth = monthly.some(m => m.key === activeMonth()) ? activeMonth() : (monthly.at(-1)?.key || `${year}-01`);
    const displayItems = monthItems(displayMonth,'all');
    const displayMetrics = metricsFor(displayItems);
    const displayCats = getExpenseCategories(displayItems).slice(0,5);
    const monthlyHtml = monthly.length
      ? `<div class="month-strip history-month-strip">${monthly.map(m=>`<button class="month-pill ${m.key===displayMonth?'active':''}" type="button" data-set-month="${m.key}"><strong>${monthName(m.key)}</strong><span>${money(m.balance)} · ${m.incomes.length+m.expenses.length} mov.</span></button>`).join('')}</div>`
      : `<div class="empty-state"><strong>Sin meses visibles</strong>Este año todavía no tiene meses activos para mostrar.</div>`;
    const categoriesHtml = displayCats.length
      ? displayCats.map(c => `<div class="history-category-row"><div><strong>${escapeHtml(c.name)}</strong><span>${c.count} movimiento(s)</span></div><b>${money(c.total)}</b></div>`).join('')
      : `<div class="empty-state"><strong>Sin categorías</strong>Cuando haya gastos en el mes seleccionado aparecerá el resumen por categoría.</div>`;
    return `<section class="section-header"><div class="section-icon-row"><div class="section-badge">🗓️</div><div><h3>Historial mensual</h3><p>Resumen histórico por mes. No repite la tabla operativa de Movimientos; aquí ves evolución, totales y categorías del mes seleccionado.</p></div></div></section>
      <article class="section-card history-year-card"><h4>Año visible en historial</h4><p class="sub">Cambia el año para revisar balances anteriores. Los meses futuros no se muestran hasta que lleguen.</p><div class="field"><label>Buscar otro año</label><select id="historyYearFilter">${(years.length?years:[year]).map(y=>`<option value="${y}" ${String(y)===String(year)?'selected':''}>${y}</option>`).join('')}</select></div></article>
      <section class="history-stack">
        <article class="section-card history-summary-card"><h4>Resumen por mes</h4><p class="sub">Cada tarjeta resume ingresos, gastos y balance del mes. Haz clic en un mes para analizarlo.</p>${monthlyHtml}</article>
        <article class="section-card history-insight-card"><h4>Lectura histórica de ${monthName(displayMonth)}</h4><p class="sub">Vista ejecutiva del mes seleccionado. Para ver, editar o borrar movimientos exactos, usa la pestaña Movimientos.</p><div class="history-kpi-grid"><div><span>Ingresos</span><strong>${money(displayMetrics.totalIncome)}</strong></div><div><span>Gastos</span><strong>${money(displayMetrics.totalExpense)}</strong></div><div><span>Balance</span><strong>${money(displayMetrics.balance)}</strong></div><div><span>Compartido</span><strong>${money(displayMetrics.sharedExpense)}</strong></div></div><div class="history-actions"><button class="btn ghost small" type="button" data-section="movements">Ver detalle en Movimientos</button></div></article>
        <article class="section-card history-cats-card"><h4>Categorías del mes seleccionado</h4><p class="sub">Aquí se ve dónde se concentró el gasto, sin duplicar el listado de movimientos.</p><div class="history-category-list">${categoriesHtml}</div></article>
      </section>`;
  }

  function renderBackup() {
    return `<section class="section-header"><div class="section-icon-row"><div class="section-badge">💾</div><div><h3>Respaldo y exportación</h3><p>Exporta tus datos visibles. La fuente real sigue siendo Supabase.</p></div></div></section><section class="backup-grid"><article class="section-card"><h4>Copias de seguridad</h4><p class="sub">Descarga JSON o CSV de lo que tu usuario tiene permiso de ver.</p><div class="form-actions"><button class="btn primary" id="exportJsonBtn">Exportar JSON</button><button class="btn dark" id="exportCsvBtn">Exportar movimientos CSV</button></div></article><article class="section-card"><h4>Zona delicada</h4><p class="sub">Para backups completos o restauraciones grandes usa Supabase Dashboard. No dependas del navegador.</p></article></section>`;
  }

  function fillMemberFormForEdit(userId) {
    const member = state.members.find(m => m.user_id === userId);
    if (!member) return showToast("No encontré ese miembro.", "danger");
    if (state.activeSection !== "members") {
      state.activeSection = "members";
      renderApp();
      setTimeout(() => fillMemberFormForEdit(userId), 80);
      return;
    }
    const form = document.getElementById("memberForm");
    if (!form) return;
    const p = state.profilesByUserId[userId] || {};
    form.member_id.value = userId;
    form.household_type.value = member.household_type || "family";
    form.full_name.value = member.display_name || p.full_name || "";
    form.email.value = p.email || "";
    form.email.disabled = true;
    form.participation_percent.value = member.participation_percent ?? "";
    form.role.value = member.role || "member";
    form.status.value = member.status || "active";
    form.dependent.checked = Boolean(member.dependent);
    document.getElementById("memberFormTitle").textContent = `Editando: ${memberName(userId)}`;
    document.getElementById("saveMemberBtn").textContent = "Actualizar miembro";
    document.getElementById("cancelMemberEdit")?.classList.remove("hidden");
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function resetMemberFormEdit() {
    const form = document.getElementById("memberForm");
    if (!form) return;
    form.reset();
    form.member_id.value = "";
    form.email.disabled = false;
    document.getElementById("memberFormTitle").textContent = "Nuevo miembro / invitación";
    document.getElementById("saveMemberBtn").textContent = "Guardar / invitar";
    document.getElementById("cancelMemberEdit")?.classList.add("hidden");
  }

  async function setMemberStatus(userId, status) {
    if (!isAdmin()) return showToast("Solo el admin puede cambiar el estado de miembros.", "danger");
    if (userId === state.user?.id) return showToast("No puedes cambiar tu propio estado desde aquí.", "danger");
    const active = status === "active";
    const message = active
      ? "¿Activar este miembro de nuevo? Podrá volver a entrar y ver su información según sus permisos."
      : "¿Desactivar este miembro? No se borran sus movimientos; solo queda inactivo.";
    if (!confirm(message)) return;
    await withError(
      supabase.from("household_members")
        .update({ status })
        .eq("household_id", state.currentHouseholdId)
        .eq("user_id", userId),
      active ? "Miembro activado." : "Miembro desactivado."
    );
    await loadHouseholdData();
    renderApp();
  }

  async function deactivateMember(userId) {
    return setMemberStatus(userId, "disabled");
  }

  async function activateMember(userId) {
    return setMemberStatus(userId, "active");
  }

  function showRegisterPanel(panelId) {
    document.querySelectorAll('[data-flow-target]').forEach(btn => btn.classList.toggle('active', btn.dataset.flowTarget === panelId));
    const panel = document.getElementById(panelId);
    panel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function resetIncomeFormEdit() {
    const form = document.getElementById('incomeForm');
    if (!form) return;
    form.reset();
    setFormField(form, 'id', '');
    setFormField(form, 'date', todayISO());
    document.getElementById('incomeFormTitle') && (document.getElementById('incomeFormTitle').textContent = 'Nuevo ingreso puntual');
    document.getElementById('saveIncomeBtn') && (document.getElementById('saveIncomeBtn').textContent = 'Guardar ingreso');
    document.getElementById('cancelIncomeEdit') && (document.getElementById('cancelIncomeEdit').hidden = true);
  }

  function resetExpenseFormEdit() {
    const form = document.getElementById('expenseForm');
    if (!form) return;
    form.reset();
    setFormField(form, 'id', '');
    setFormField(form, 'date', todayISO());
    document.getElementById('expenseFormTitle') && (document.getElementById('expenseFormTitle').textContent = 'Nuevo gasto puntual');
    document.getElementById('saveExpenseBtn') && (document.getElementById('saveExpenseBtn').textContent = 'Guardar gasto');
    document.getElementById('cancelExpenseEdit') && (document.getElementById('cancelExpenseEdit').hidden = true);
  }

  function editMovement(id) {
    const movement = state.movements.find(m => m.id === id);
    if (!movement) return showToast('No encontré ese movimiento.', 'danger');
    if (!canManageMovementRecord(movement)) return showToast('No puedes editar movimientos de otro integrante.', 'danger');
    if (state.activeSection !== 'register') {
      state.activeSection = 'register';
      renderApp();
      setTimeout(() => editMovement(id), 80);
      return;
    }
    const isIncome = movement.type === 'income';
    const form = document.getElementById(isIncome ? 'incomeForm' : 'expenseForm');
    if (!form) return;
    if (isIncome) resetExpenseFormEdit(); else resetIncomeFormEdit();
    setFormField(form, 'id', movement.id);
    setFormField(form, 'concept', movement.description || '');
    setFormField(form, 'amount', movement.amount ?? '');
    setFormField(form, 'date', dateOnly(movement.date) || todayISO());
    setSelectField(form, 'category_id', movement.category_id || '');
    setSelectField(form, 'member_id', safeAssignableMemberId(movement.member_id || movement.user_id));
    setFormField(form, 'notes', movement.notes || '');
    if (!isIncome) {
      setSelectField(form, 'kind', movement.kind || (movement.is_shared ? 'shared' : 'personal'));
      const sharedBox = form.querySelector('[name="is_shared"]');
      if (sharedBox) sharedBox.checked = Boolean(movement.is_shared);
      setSelectField(form, 'share_method', movement.share_method || 'equal');
    }
    const title = document.getElementById(isIncome ? 'incomeFormTitle' : 'expenseFormTitle');
    const button = document.getElementById(isIncome ? 'saveIncomeBtn' : 'saveExpenseBtn');
    const cancel = document.getElementById(isIncome ? 'cancelIncomeEdit' : 'cancelExpenseEdit');
    if (title) title.textContent = isIncome ? 'Editando ingreso' : 'Editando gasto';
    if (button) button.textContent = isIncome ? 'Actualizar ingreso' : 'Actualizar gasto';
    if (cancel) cancel.hidden = false;
    showRegisterPanel(isIncome ? 'incomePanel' : 'expensePanel');
  }

  function resetRecurringFormEdit() {
    const form = document.getElementById('recurringForm');
    if (!form) return;
    form.reset();
    setFormField(form, 'id', '');
    setFormField(form, 'start_date', todayISO());
    const active = form.querySelector('[name="active"]');
    if (active) active.checked = true;
    document.getElementById('recurringFormTitle') && (document.getElementById('recurringFormTitle').textContent = 'Nuevo recurrente o servicio variable');
    document.getElementById('saveRecurringBtn') && (document.getElementById('saveRecurringBtn').textContent = 'Guardar automático');
    document.getElementById('cancelRecurringEdit') && (document.getElementById('cancelRecurringEdit').hidden = true);
  }

  function editRecurring(id) {
    const recurring = state.recurring.find(r => r.id === id);
    if (!recurring) return showToast('No encontré ese recurrente.', 'danger');
    if (!canManageRecurringRecord(recurring)) return showToast('No puedes editar recurrentes de otro integrante.', 'danger');
    if (state.activeSection !== 'register') {
      state.activeSection = 'register';
      renderApp();
      setTimeout(() => editRecurring(id), 80);
      return;
    }
    const form = document.getElementById('recurringForm');
    if (!form) return;
    setFormField(form, 'id', recurring.id);
    setFormField(form, 'description', recurring.description || '');
    setFormField(form, 'amount', recurring.amount ?? '');
    setFormField(form, 'start_date', dateOnly(recurring.start_date || recurring.date) || todayISO());
    setSelectField(form, 'category_id', recurring.category_id || '');
    setSelectField(form, 'member_id', safeAssignableMemberId(recurring.member_id || recurring.user_id));
    setSelectField(form, 'type', recurring.type || 'expense');
    setFormField(form, 'day_of_month', recurring.day_of_month || 1);
    setSelectField(form, 'frequency', recurring.frequency || 'monthly');
    setSelectField(form, 'amount_mode', recurring.amount_mode || 'fixed');
    setSelectField(form, 'end_mode', recurring.end_mode || 'indefinite');
    setFormField(form, 'fixed_months', recurring.fixed_months ?? '');
    setFormField(form, 'fixed_years', recurring.fixed_years ?? '');
    setFormField(form, 'end_date', dateOnly(recurring.end_date) || '');
    setFormField(form, 'debt_original_amount', recurring.debt_original_amount ?? '');
    setFormField(form, 'debt_lender', recurring.debt_lender || '');
    const shared = form.querySelector('[name="is_shared"]');
    if (shared) shared.checked = Boolean(recurring.is_shared);
    const active = form.querySelector('[name="active"]');
    if (active) active.checked = recurring.active !== false;
    setFormField(form, 'notes', recurring.notes || '');
    document.getElementById('recurringFormTitle') && (document.getElementById('recurringFormTitle').textContent = 'Editando recurrente');
    document.getElementById('saveRecurringBtn') && (document.getElementById('saveRecurringBtn').textContent = 'Actualizar automático');
    document.getElementById('cancelRecurringEdit') && (document.getElementById('cancelRecurringEdit').hidden = false);
    showRegisterPanel('recurringPanel');
  }

  async function toggleRecurring(id) {
    const recurring = state.recurring.find(r => r.id === id);
    if (!recurring) return showToast('No encontré ese recurrente.', 'danger');
    if (!canManageRecurringRecord(recurring)) return showToast('No puedes cambiar recurrentes de otro integrante.', 'danger');
    if (!can('recurring', 'edit') && !can('register', 'edit')) return showToast('No tienes permiso para cambiar recurrentes.', 'danger');
    await withError(supabase.from('recurring_movements').update({ active: recurring.active === false }).eq('id', id).eq('household_id', state.currentHouseholdId), recurring.active === false ? 'Recurrente activado.' : 'Recurrente pausado.');
    await loadHouseholdData();
    renderApp();
  }

  function editCategory(id) {
    const category = state.categories.find(c => c.id === id);
    if (!category) return showToast('No encontré esa categoría.', 'danger');
    if (state.activeSection !== 'categories') {
      state.activeSection = 'categories';
      renderApp();
      setTimeout(() => editCategory(id), 80);
      return;
    }
    const form = document.getElementById('categoryForm');
    if (!form) return;
    setFormField(form, 'id', category.id);
    setFormField(form, 'name', category.name || '');
    setSelectField(form, 'type', category.type || 'expense');
    setFormField(form, 'budget', category.budget ?? '');
    setFormField(form, 'color', category.color || '#4aa8ff');
    document.getElementById('categoryFormTitle') && (document.getElementById('categoryFormTitle').textContent = 'Editando categoría');
    document.getElementById('saveCategoryBtn') && (document.getElementById('saveCategoryBtn').textContent = 'Actualizar categoría');
    document.getElementById('cancelCategoryEdit') && (document.getElementById('cancelCategoryEdit').hidden = false);
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function resetCategoryFormEdit() {
    const form = document.getElementById('categoryForm');
    if (!form) return;
    form.reset();
    setFormField(form, 'id', '');
    setFormField(form, 'color', '#4aa8ff');
    document.getElementById('categoryFormTitle') && (document.getElementById('categoryFormTitle').textContent = 'Nueva categoría');
    document.getElementById('saveCategoryBtn') && (document.getElementById('saveCategoryBtn').textContent = 'Guardar categoría');
    document.getElementById('cancelCategoryEdit') && (document.getElementById('cancelCategoryEdit').hidden = true);
  }

  function editGoal(id) {
    const goal = state.goals.find(g => g.id === id);
    if (!goal) return showToast('No encontré esa meta.', 'danger');
    if (state.activeSection !== 'goals') {
      state.activeSection = 'goals';
      renderApp();
      setTimeout(() => editGoal(id), 80);
      return;
    }
    const form = document.getElementById('goalForm');
    if (!form) return;
    setFormField(form, 'id', goal.id);
    setFormField(form, 'name', goal.name || '');
    setFormField(form, 'target_amount', goal.target_amount ?? '');
    setFormField(form, 'current_amount', goal.current_amount ?? 0);
    setFormField(form, 'deadline', dateOnly(goal.deadline) || '');
    setSelectField(form, 'emoji', goal.emoji || '🎯');
    setFormField(form, 'notes', goal.notes || '');
    document.getElementById('goalFormTitle') && (document.getElementById('goalFormTitle').textContent = 'Editando meta');
    document.getElementById('saveGoalBtn') && (document.getElementById('saveGoalBtn').textContent = 'Actualizar meta');
    document.getElementById('cancelGoalEdit') && (document.getElementById('cancelGoalEdit').hidden = false);
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function resetGoalFormEdit() {
    const form = document.getElementById('goalForm');
    if (!form) return;
    form.reset();
    setFormField(form, 'id', '');
    setFormField(form, 'current_amount', 0);
    document.getElementById('goalFormTitle') && (document.getElementById('goalFormTitle').textContent = 'Nueva meta de ahorro');
    document.getElementById('saveGoalBtn') && (document.getElementById('saveGoalBtn').textContent = 'Guardar meta');
    document.getElementById('cancelGoalEdit') && (document.getElementById('cancelGoalEdit').hidden = true);
  }

  function bindSectionActions() {
    document.querySelectorAll('[data-flow-target]').forEach(btn => btn.addEventListener('click', () => { document.querySelectorAll('[data-flow-target]').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); document.getElementById(btn.dataset.flowTarget)?.scrollIntoView({behavior:'smooth', block:'start'}); }));
    document.querySelectorAll('[data-set-month]').forEach(btn => btn.addEventListener('click', () => { state.filters.month = btn.dataset.setMonth; state.filters.year = String(btn.dataset.setMonth || '').slice(0, 4) || state.filters.year; renderApp(); }));
    document.querySelectorAll('[data-month-jump]').forEach(select => select.addEventListener('change', e => { state.filters.month = e.target.value; state.filters.year = String(e.target.value || '').slice(0, 4) || state.filters.year; renderApp(); }));
    document.getElementById('oldYearSelector')?.addEventListener('change', e => { const mm = String(activeMonth()).slice(5,7); state.filters.month = `${e.target.value}-${mm}`; state.filters.year = e.target.value; renderApp(); });
    document.getElementById('historyYearFilter')?.addEventListener('change', e => { state.filters.year = e.target.value; renderApp(); });
    document.querySelector('[data-open-expense]')?.addEventListener('click', () => { state.activeSection='register'; renderApp(); setTimeout(()=>document.getElementById('expensePanel')?.scrollIntoView({behavior:'smooth'}),50); });
    document.getElementById('incomeForm')?.addEventListener('submit', handleIncomeSubmit);
    document.getElementById('expenseForm')?.addEventListener('submit', handleExpenseSubmit);
    document.getElementById('recurringForm')?.addEventListener('submit', handleRecurringSubmit);
    document.getElementById('memberForm')?.addEventListener('submit', handleMemberSubmit);
    document.getElementById('cancelMemberEdit')?.addEventListener('click', resetMemberFormEdit);
    document.querySelectorAll('[data-edit-member]').forEach(btn => btn.addEventListener('click', () => fillMemberFormForEdit(btn.dataset.editMember)));
    document.querySelectorAll('[data-deactivate-member]').forEach(btn => btn.addEventListener('click', () => deactivateMember(btn.dataset.deactivateMember)));
    document.querySelectorAll('[data-activate-member]').forEach(btn => btn.addEventListener('click', () => activateMember(btn.dataset.activateMember)));
    document.getElementById('categoryForm')?.addEventListener('submit', handleCategorySubmit);
    document.getElementById('goalForm')?.addEventListener('submit', handleGoalSubmit);
    document.getElementById('vehicleForm')?.addEventListener('submit', handleVehicleSubmit);
    document.getElementById('vehicleInsuranceForm')?.addEventListener('submit', handleVehicleInsuranceSubmit);
    document.getElementById('vehicleRecordForm')?.addEventListener('submit', handleVehicleRecordSubmit);
    document.getElementById('inviteForm')?.addEventListener('submit', handleInviteSubmit);
    document.getElementById('exportJsonBtn')?.addEventListener('click', exportJson);
    document.getElementById('exportCsvBtn')?.addEventListener('click', exportCsv);
    document.querySelectorAll('[data-delete-movement]').forEach(btn => btn.addEventListener('click', () => deleteMovement(btn.dataset.deleteMovement)));
    document.querySelectorAll('[data-edit-movement]').forEach(btn => btn.addEventListener('click', () => editMovement(btn.dataset.editMovement)));
    document.querySelectorAll('[data-delete-category]').forEach(btn => btn.addEventListener('click', () => deleteCategory(btn.dataset.deleteCategory)));
    document.querySelectorAll('[data-edit-category]').forEach(btn => btn.addEventListener('click', () => editCategory(btn.dataset.editCategory)));
    document.getElementById('cancelCategoryEdit')?.addEventListener('click', resetCategoryFormEdit);
    document.querySelectorAll('[data-delete-goal]').forEach(btn => btn.addEventListener('click', () => deleteGoal(btn.dataset.deleteGoal)));
    document.querySelectorAll('[data-edit-goal]').forEach(btn => btn.addEventListener('click', () => editGoal(btn.dataset.editGoal)));
    document.getElementById('cancelGoalEdit')?.addEventListener('click', resetGoalFormEdit);
    document.querySelectorAll('[data-edit-vehicle]').forEach(btn => btn.addEventListener('click', () => editVehicle(btn.dataset.editVehicle)));
    document.querySelectorAll('[data-delete-vehicle]').forEach(btn => btn.addEventListener('click', () => deleteVehicle(btn.dataset.deleteVehicle)));
    document.querySelectorAll('[data-edit-vehicle-record]').forEach(btn => btn.addEventListener('click', () => editVehicleRecord(btn.dataset.editVehicleRecord)));
    document.querySelectorAll('[data-delete-vehicle-record]').forEach(btn => btn.addEventListener('click', () => deleteVehicleRecord(btn.dataset.deleteVehicleRecord)));
    document.getElementById('cancelVehicleEdit')?.addEventListener('click', resetVehicleFormEdit);
    document.getElementById('cancelInsuranceEdit')?.addEventListener('click', resetInsuranceFormEdit);
    document.getElementById('cancelVehicleRecordEdit')?.addEventListener('click', resetVehicleRecordFormEdit);
    document.querySelectorAll('[data-delete-recurring]').forEach(btn => btn.addEventListener('click', () => deleteRecurring(btn.dataset.deleteRecurring)));
    document.querySelectorAll('[data-edit-recurring]').forEach(btn => btn.addEventListener('click', () => editRecurring(btn.dataset.editRecurring)));
    document.querySelectorAll('[data-toggle-recurring]').forEach(btn => btn.addEventListener('click', () => toggleRecurring(btn.dataset.toggleRecurring)));
    document.getElementById('cancelRecurringEdit')?.addEventListener('click', resetRecurringFormEdit);
    document.getElementById('cancelIncomeEdit')?.addEventListener('click', resetIncomeFormEdit);
    document.getElementById('cancelExpenseEdit')?.addEventListener('click', resetExpenseFormEdit);
    const permissionSelect = document.getElementById('permissionUserSelect');
    if (permissionSelect) { renderPermissionEditor(permissionSelect.value); permissionSelect.addEventListener('change', e => renderPermissionEditor(e.target.value)); }
    document.getElementById('savePermissionsBtn')?.addEventListener('click', handleSavePermissions);
  }

  async function handleIncomeSubmit(event) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const id = String(f.get("id") || "").trim();
    if (id) {
      if (!can("movements", "edit") && !can("register", "edit")) return showToast("No tienes permiso para editar ingresos.", "danger");
    } else if (!can("movements", "create") && !can("register", "create")) {
      return showToast("No tienes permiso para crear ingresos.", "danger");
    }
    const payload = { household_id: state.currentHouseholdId, user_id: state.user.id, member_id: safeAssignableMemberId(f.get("member_id")), type: "income", amount: parseAmount(f.get("amount")), date: f.get("date") || todayISO(), category_id: f.get("category_id") || null, description: String(f.get("concept") || "Ingreso").trim(), notes: String(f.get("notes") || "").trim(), kind: "personal", share_method: "none", is_shared: false };
    if (id) {
      await updateWithSchemaFallback("movements", payload, { id, household_id: state.currentHouseholdId }, "Ingreso actualizado.", ["household_id","user_id","member_id","type","amount","date","category_id","description","is_shared"]);
    } else {
      await insertWithSchemaFallback("movements", payload, "Ingreso guardado.", ["household_id","user_id","member_id","type","amount","date","category_id","description","is_shared"]);
    }
    await loadHouseholdData(); renderApp();
  }

  async function handleExpenseSubmit(event) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const id = String(f.get("id") || "").trim();
    if (id) {
      if (!can("movements", "edit") && !can("register", "edit")) return showToast("No tienes permiso para editar gastos.", "danger");
    } else if (!can("movements", "create") && !can("register", "create")) {
      return showToast("No tienes permiso para crear gastos.", "danger");
    }
    const isShared = Boolean(f.get("is_shared")) || f.get("kind") === "shared";
    const payload = { household_id: state.currentHouseholdId, user_id: state.user.id, member_id: safeAssignableMemberId(f.get("member_id")), type: "expense", amount: parseAmount(f.get("amount")), date: f.get("date") || todayISO(), category_id: f.get("category_id") || null, description: String(f.get("concept") || "Gasto").trim(), notes: String(f.get("notes") || "").trim(), kind: String(f.get("kind") || "personal"), share_method: String(f.get("share_method") || "equal"), is_shared: isShared };
    if (id) {
      await updateWithSchemaFallback("movements", payload, { id, household_id: state.currentHouseholdId }, "Gasto actualizado.", ["household_id","user_id","member_id","type","amount","date","category_id","description","is_shared"]);
    } else {
      await insertWithSchemaFallback("movements", payload, "Gasto guardado.", ["household_id","user_id","member_id","type","amount","date","category_id","description","is_shared"]);
    }
    await loadHouseholdData(); renderApp();
  }

  async function handleRecurringSubmit(event) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const id = String(f.get("id") || "").trim();
    if (id) {
      if (!can("recurring", "edit") && !can("register", "edit")) return showToast("No tienes permiso para editar recurrentes.", "danger");
    } else if (!can("recurring", "create") && !can("register", "create")) {
      return showToast("No tienes permiso para crear recurrentes.", "danger");
    }
    const payload = {
      household_id: state.currentHouseholdId,
      user_id: state.user.id,
      member_id: safeAssignableMemberId(f.get("member_id")),
      type: f.get("type") || "expense",
      amount: parseAmount(f.get("amount")),
      category_id: f.get("category_id") || null,
      description: String(f.get("description") || "Recurrente").trim(),
      day_of_month: Number(f.get("day_of_month") || 1),
      frequency: f.get("frequency") || "monthly",
      active: Boolean(f.get("active")),
      is_shared: Boolean(f.get("is_shared")),
      start_date: f.get("start_date") || todayISO(),
      kind: f.get("kind") || "fixed",
      amount_mode: f.get("amount_mode") || "fixed",
      end_mode: f.get("end_mode") || "indefinite",
      fixed_months: f.get("fixed_months") ? Number(f.get("fixed_months")) : null,
      fixed_years: f.get("fixed_years") ? Number(f.get("fixed_years")) : null,
      end_date: f.get("end_date") || null,
      debt_original_amount: f.get("debt_original_amount") ? parseAmount(f.get("debt_original_amount")) : null,
      debt_lender: String(f.get("debt_lender") || "").trim() || null,
      notes: String(f.get("notes") || "").trim()
    };
    if (id) {
      await updateWithSchemaFallback("recurring_movements", payload, { id, household_id: state.currentHouseholdId }, "Recurrente actualizado.", ["household_id","user_id","member_id","type","amount","category_id","description","day_of_month","frequency","active","is_shared","start_date"]);
    } else {
      await insertWithSchemaFallback("recurring_movements", payload, "Recurrente guardado.", ["household_id","user_id","member_id","type","amount","category_id","description","day_of_month","frequency","active","is_shared","start_date"]);
    }
    await loadHouseholdData(); renderApp();
  }

  async function handleMemberSubmit(event) {
    event.preventDefault();
    if (!isAdmin()) return showToast("Solo el admin puede administrar miembros.", "danger");
    const f = new FormData(event.currentTarget);
    const memberId = String(f.get("member_id") || "").trim();
    const displayName = String(f.get("full_name") || "").trim();
    const isDependent = Boolean(f.get("dependent"));
    const payload = {
      display_name: displayName || null,
      household_type: String(f.get("household_type") || "family"),
      participation_percent: f.get("participation_percent") === "" ? null : parseAmount(f.get("participation_percent")),
      role: String(f.get("role") || "member"),
      status: String(f.get("status") || "active"),
      works: !isDependent,
      contributes_income: !isDependent,
      dependent: isDependent
    };

    if (memberId) {
      await withError(
        supabase.from("household_members")
          .update(payload)
          .eq("household_id", state.currentHouseholdId)
          .eq("user_id", memberId),
        "Miembro actualizado."
      );
      if (memberId === state.user.id && displayName) {
        await supabase.from("profiles").update({ full_name: displayName }).eq("user_id", state.user.id);
      }
      await loadHouseholdData();
      renderApp();
      return;
    }

    const email = String(f.get("email") || "").trim().toLowerCase();
    if (!email) return showToast("Coloca un email para invitar a ese integrante, o pulsa Editar sobre uno existente.", "danger");
    await withError(supabase.from("invitations").upsert({
      household_id: state.currentHouseholdId,
      invited_email: email,
      full_name: displayName,
      role: payload.role,
      invited_by: state.user.id,
      status: "pending"
    }, { onConflict: "household_id,invited_email" }), "Invitación guardada. Esa persona debe registrarse con ese email.");
    await loadHouseholdData();
    renderApp();
  }

  async function handleCategorySubmit(event) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const id = String(f.get("id") || "").trim();
    if (id) {
      if (!can("categories", "edit")) return showToast("No tienes permiso para editar categorías.", "danger");
    } else if (!can("categories", "create")) {
      return showToast("No tienes permiso para crear categorías.", "danger");
    }
    const payload = { household_id: state.currentHouseholdId, name: String(f.get("name") || "").trim(), type: f.get("type"), color: f.get("color") || "#4aa8ff", budget: parseAmount(f.get("budget")) };
    if (id) {
      await updateWithSchemaFallback("categories", payload, { id, household_id: state.currentHouseholdId }, "Categoría actualizada.", ["household_id","name","type","color"]);
    } else {
      await insertWithSchemaFallback("categories", payload, "Categoría creada.", ["household_id","name","type","color"]);
    }
    await loadHouseholdData(); renderApp();
  }

  async function handleGoalSubmit(event) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const id = String(f.get("id") || "").trim();
    if (id) {
      if (!can("goals", "edit")) return showToast("No tienes permiso para editar metas.", "danger");
    } else if (!can("goals", "create")) {
      return showToast("No tienes permiso para crear metas.", "danger");
    }
    const payload = { household_id: state.currentHouseholdId, user_id: state.user.id, name: String(f.get("name") || "").trim(), target_amount: parseAmount(f.get("target_amount")), current_amount: parseAmount(f.get("current_amount")), deadline: f.get("deadline") || null, emoji: String(f.get("emoji") || "🎯"), notes: String(f.get("notes") || "") };
    if (id) {
      await updateWithSchemaFallback("goals", payload, { id, household_id: state.currentHouseholdId }, "Meta actualizada.", ["household_id","user_id","name","target_amount","current_amount","deadline"]);
    } else {
      await insertWithSchemaFallback("goals", payload, "Meta guardada.", ["household_id","user_id","name","target_amount","current_amount","deadline"]);
    }
    await loadHouseholdData(); renderApp();
  }

  return { visibleModules, renderSection, renderApp, renderDashboard, renderRegister, renderMovements, renderRecurring, renderHousehold, renderMembersSection, renderCategories, renderGoals, renderVehicles, renderHistory, renderBackup, bindSectionActions };
})();

visibleModules = F360V3.visibleModules;
renderSection = F360V3.renderSection;
renderApp = F360V3.renderApp;
renderDashboard = F360V3.renderDashboard;
renderRegister = F360V3.renderRegister;
renderMovements = F360V3.renderMovements;
renderRecurring = F360V3.renderRecurring;
renderHousehold = F360V3.renderHousehold;
renderCategories = F360V3.renderCategories;
renderGoals = F360V3.renderGoals;
renderVehicles = F360V3.renderVehicles;
renderHistory = F360V3.renderHistory;
renderBackup = F360V3.renderBackup;
bindSectionActions = F360V3.bindSectionActions;

// F360V6 necesita esta referencia fuera del bloque V3.
// Sin este alias, la pestaña "3. Hogar" intenta llamar a una función
// que solo existe dentro del cierre de V3 y se rompe al hacer clic.
const renderMembersSection = F360V3.renderMembersSection;


// ─────────────────────────────────────────────────────────────
// V6 · Integración visible del index.html antiguo dentro de la app Supabase
// Mantiene el look & feel actual, pero trae bloques funcionales que faltaban:
// - Centro financiero inteligente visible en Inicio
// - Filtros completos y ordenación real en Movimientos
// - Edición directa de categorías y metas
// - Edición rápida de recurrentes
// - Importar JSON y cargar datos demo desde Respaldo/Inicio
// ─────────────────────────────────────────────────────────────
const F360V6 = (() => {
  const baseRenderDashboard = renderDashboard;
  const baseRenderBackup = renderBackup;
  const baseBindSectionActions = bindSectionActions;

  state.filters.shared ||= "all";
  state.filters.member ||= "all";
  state.filters.sortField ||= "date";
  state.filters.sortDirection ||= "desc";
  state.financeCoach ||= { focus: "balance", investmentProfile: "balanced", cutIdeasLimit: 5 };

  const v6Months = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  const v6MonthName = (key = activeMonth()) => `${v6Months[Math.max(0, Number(String(key).slice(5,7)) - 1)] || "Mes"} de ${String(key).slice(0,4)}`;
  const v6Pct = (part, total) => total ? Math.max(0, Math.min(100, Math.round((Number(part || 0) / Number(total || 0)) * 100))) : 0;
  const v6SignedMoney = (n = 0) => `${Number(n || 0) >= 0 ? "+" : ""}${money(n)}`;

  function v6MonthItems(month = activeMonth(), person = state.filters.person) {
    return movementsForMonthPerson(month, person, { respectType: false });
  }

  function v6YearItems(year = activeYear()) {
    return Array.from({ length: 12 }, (_, idx) => `${year}-${String(idx + 1).padStart(2, "0")}`)
      .flatMap(month => v6MonthItems(month, state.filters.person));
  }

  function v6ExpenseCategories(items = []) {
    const grouped = new Map();
    items.filter(x => x.type === "expense").forEach(item => {
      const name = categoryName(item.category_id);
      const current = grouped.get(name) || { name, total: 0, count: 0 };
      current.total += Number(item.amount || 0);
      current.count += 1;
      grouped.set(name, current);
    });
    return [...grouped.values()].sort((a, b) => b.total - a.total);
  }

  function v6MovementSortValue(movement, field = state.filters.sortField) {
    if (field === "amount") return Number(movement.amount || 0);
    if (field === "type") return movement.type === "income" ? 1 : 0;
    if (field === "category") return categoryName(movement.category_id).toLowerCase();
    if (field === "member") return memberName(movement.member_id || movement.user_id).toLowerCase();
    if (field === "concept") return String(movement.description || movement.notes || "").toLowerCase();
    if (field === "share") return movement.is_shared ? 1 : 0;
    return dateOnly(movement.date || movement.created_at || "");
  }

  function v6FilteredMovements() {
    let items = getVisibleMovements();
    if (state.filters.month) items = items.filter(x => isSameMonth(x.date, state.filters.month));
    if (state.filters.movementType && state.filters.movementType !== "all") items = items.filter(x => x.type === state.filters.movementType);
    if (state.filters.category && state.filters.category !== "all") items = items.filter(x => x.category_id === state.filters.category);
    if (state.filters.member && state.filters.member !== "all") items = items.filter(x => (x.member_id || x.user_id) === state.filters.member);
    if (state.filters.shared === "shared") items = items.filter(x => Boolean(x.is_shared));
    if (state.filters.shared === "individual") items = items.filter(x => !x.is_shared);
    if (state.filters.search) items = items.filter(x => movementMatchesText(x, state.filters.search));
    items = applyPersonFilterWithSharedAllocation(items, state.filters.person);
    const direction = state.filters.sortDirection === "asc" ? 1 : -1;
    const field = state.filters.sortField || "date";
    return [...items].sort((a, b) => {
      const av = v6MovementSortValue(a, field);
      const bv = v6MovementSortValue(b, field);
      if (typeof av === "number" || typeof bv === "number") return ((Number(av) || 0) - (Number(bv) || 0)) * direction;
      return String(av).localeCompare(String(bv), "es", { numeric: true, sensitivity: "base" }) * direction;
    });
  }

  function v6CoachStatus(metrics) {
    if (metrics.totalIncome <= 0 && metrics.totalExpense <= 0) return { tone: "warn", label: "Sin datos", score: 0, text: "Registra ingresos y gastos para que el diagnóstico sea útil." };
    if (metrics.totalIncome <= 0) return { tone: "bad", label: "Sin ingresos", score: 15, text: "Hay gastos pero no ingresos registrados en este mes." };
    const expenseRatio = metrics.totalExpense / metrics.totalIncome;
    const score = Math.max(0, Math.min(100, Math.round(100 - expenseRatio * 100 + (metrics.balance > 0 ? 12 : 0))));
    if (expenseRatio <= 0.70) return { tone: "good", label: "Sano", score, text: "Buen margen. Puedes crear fondo de emergencia o acelerar metas." };
    if (expenseRatio <= 0.90) return { tone: "warn", label: "Apretado", score, text: "Hay margen, pero cualquier gasto sorpresa puede pegar fuerte." };
    return { tone: "bad", label: "Crítico", score, text: "Los gastos están comiéndose casi todo. Toca recortar y priorizar." };
  }

  function v6PriorityRows(items) {
    const cats = v6ExpenseCategories(items);
    if (!cats.length) return `<div class="empty-mini">Aún no hay gastos suficientes para priorizar. Registra movimientos y aquí aparecerá dónde atacar primero.</div>`;
    return cats.slice(0, Number(state.financeCoach.cutIdeasLimit || 5)).map((cat, index) => {
      const className = index === 0 ? "cut" : index < 3 ? "optimize" : "grow";
      const saving = cat.total * (index === 0 ? 0.15 : 0.10);
      return `<div class="priority-row"><span class="priority-rank ${className}">${index + 1}</span><div><b>${escapeHtml(cat.name)}</b><p>${cat.count} movimiento(s). Recorte sugerido: revisar tickets, duplicados o gastos variables.</p></div><div class="priority-amount">${money(cat.total)}<small>posible ${money(saving)}</small></div></div>`;
    }).join("");
  }

  function v6SmartTips(metrics, cats) {
    const tips = [];
    if (metrics.totalIncome <= 0) tips.push(["warn", "⚠", "Registra ingresos", "Sin ingresos el análisis queda cojo. Mete nóminas o entradas reales para calcular ahorro."]);
    else if (metrics.balance < 0) tips.push(["danger", "!", "Balance negativo", `Te faltan ${money(Math.abs(metrics.balance))} para cerrar el mes en cero.`]);
    else tips.push(["ok", "✓", "Balance positivo", `Te quedan ${money(metrics.balance)} después de gastos del mes.`]);
    if (cats[0]) tips.push(["warn", "↯", "Primera partida a revisar", `${cats[0].name} concentra ${money(cats[0].total)}. Ahí está el primer ajuste inteligente.`]);
    tips.push(["ok", "↻", "Revisa recurrentes", "Nóminas, seguros, cuotas, comida del perro y servicios deben estar como automáticos para que Inicio no mienta."]);
    return tips.map(t => `<div class="smart-tip ${t[0]}"><span class="tip-icon">${t[1]}</span><div><b>${escapeHtml(t[2])}</b><p>${escapeHtml(t[3])}</p></div></div>`).join("");
  }

  function v6InvestmentSuggestions(metrics) {
    const available = Math.max(0, Number(metrics.balance || 0));
    const profile = state.financeCoach.investmentProfile || "balanced";
    const emergencyPct = profile === "conservative" ? 70 : profile === "growth" ? 40 : 55;
    const goalsPct = profile === "growth" ? 45 : 30;
    const learningPct = Math.max(0, 100 - emergencyPct - goalsPct);
    if (available <= 0) return `<div class="empty-mini">Primero hay que cerrar el mes en positivo. Sin excedente real, invertir sería postureo financiero y de ese ya hay mucho en Instagram.</div>`;
    return [
      ["Fondo de emergencia", emergencyPct, "Prioridad para cubrir imprevistos sin endeudarte."],
      ["Metas activas", goalsPct, "Aporta a objetivos como entrada, coche, viaje o colchón."],
      ["Formación / crecimiento", learningPct, "Pequeña partida para mejorar ingresos futuros."]
    ].map(([title, pctValue, text]) => `<div class="investment-card"><header><b>${escapeHtml(title)}</b><span class="allocation">${pctValue}% · ${money(available * pctValue / 100)}</span></header><p>${escapeHtml(text)}</p></div>`).join("");
  }

  function v6ActionPlan(metrics, cats) {
    const top = cats[0]?.name || "la categoría más alta";
    const steps = [
      ["Cerrar foto del mes", `Verifica que estén metidos ingresos, gastos puntuales, recurrentes y cuotas de seguros de ${v6MonthName(activeMonth())}.`],
      ["Atacar el gasto dominante", `Revisa ${top}. No recortes a ciegas: recorta donde más impacto hay.`],
      ["Separar casa vs personal", "Marca como compartidos alquiler, servicios, comida de casa e internet para que Aportes sea justo."],
      ["Guardar excedente", metrics.balance > 0 ? `Mueve ${money(Math.max(0, metrics.balance) * 0.3)} mínimo a metas o emergencia.` : "Como el balance está negativo, la meta es llegar a cero antes de ahorrar."]
    ];
    return steps.map((s, i) => `<div class="action-step"><span class="step-number">${i + 1}</span><div><b>${escapeHtml(s[0])}</b><p>${escapeHtml(s[1])}</p></div></div>`).join("");
  }

  function v6FinancialCoachPanel() {
    const items = v6MonthItems();
    const metrics = metricsFor(items);
    const cats = v6ExpenseCategories(items);
    const status = v6CoachStatus(metrics);
    const yearMetrics = metricsFor(v6YearItems());
    return `<section class="section-card finance-command-center v6-financial-coach">
      <div class="finance-coach-head">
        <div class="section-icon-row"><div class="section-badge">🧠</div><div><h4>Centro financiero inteligente</h4><p class="sub">Tips y prioridades para mejorar después de revisar todas las gráficas del dashboard.</p></div></div>
        <button class="btn ok small finance-demo-btn" id="v6SeedDemoBtn" type="button">Cargar datos demo</button>
      </div>
      <div class="finance-coach-controls">
        <div class="field"><label>Enfoque</label><select id="financeFocus"><option value="balance" ${state.financeCoach.focus === "balance" ? "selected" : ""}>Balance y ahorro</option><option value="cuts" ${state.financeCoach.focus === "cuts" ? "selected" : ""}>Recortes inteligentes</option><option value="investment" ${state.financeCoach.focus === "investment" ? "selected" : ""}>Inversión / metas</option></select></div>
        <div class="field"><label>Perfil</label><select id="investmentProfile"><option value="conservative" ${state.financeCoach.investmentProfile === "conservative" ? "selected" : ""}>Conservador</option><option value="balanced" ${state.financeCoach.investmentProfile === "balanced" ? "selected" : ""}>Balanceado</option><option value="growth" ${state.financeCoach.investmentProfile === "growth" ? "selected" : ""}>Crecimiento</option></select></div>
        <div class="field"><label>Ideas de recorte</label><select id="cutIdeasLimit"><option value="3" ${Number(state.financeCoach.cutIdeasLimit) === 3 ? "selected" : ""}>Top 3</option><option value="5" ${Number(state.financeCoach.cutIdeasLimit) === 5 ? "selected" : ""}>Top 5</option><option value="8" ${Number(state.financeCoach.cutIdeasLimit) === 8 ? "selected" : ""}>Top 8</option></select></div>
      </div>
      <div class="coach-panel finance-summary-panel">
        <h5>Resumen inteligente: cómo vas y qué hacer ahora</h5>
        <p class="sub">Diagnóstico breve del mes activo, ahorro real, recorte potencial y lectura anual.</p>
        <div class="coach-summary-grid finance-coach-summary">
          <div class="coach-kpi ${status.tone}"><span>Salud financiera</span><strong>${status.score}/100</strong><em>${escapeHtml(status.label)} · ${escapeHtml(status.text)}</em></div>
          <div class="coach-kpi ${metrics.balance >= 0 ? "good" : "bad"}"><span>Balance del mes</span><strong>${money(metrics.balance)}</strong><em>${v6SignedMoney(metrics.balance)} en ${v6MonthName(activeMonth())}</em></div>
          <div class="coach-kpi"><span>Tasa de ahorro</span><strong>${v6Pct(Math.max(0, metrics.balance), metrics.totalIncome)}%</strong><em>Objetivo sano inicial: 10% a 20%.</em></div>
          <div class="coach-kpi warn"><span>Recorte potencial</span><strong>${money(cats.slice(0,3).reduce((acc, c) => acc + c.total * 0.1, 0))}</strong><em>Estimación conservadora del top 3.</em></div>
          <div class="coach-kpi"><span>Balance anual</span><strong>${money(yearMetrics.balance)}</strong><em>Año ${activeYear()} según la vista activa.</em></div>
        </div>
      </div>
      <div class="coach-panel-grid finance-coach-grid">
        <div class="coach-panel"><h5>Prioridad de gastos</h5><p class="sub">Dónde mirar primero para que el recorte se note.</p><div class="priority-list">${v6PriorityRows(items)}</div></div>
        <div class="coach-panel"><h5>Tips inteligentes</h5><p class="sub">Alertas simples, accionables y sin humo.</p><div class="smart-tip-list">${v6SmartTips(metrics, cats)}</div></div>
        <div class="coach-panel"><h5>Distribución sugerida del excedente</h5><p class="sub">Guía práctica para ordenar prioridades, sin vender humo.</p><div class="investment-list">${v6InvestmentSuggestions(metrics)}</div></div>
        <div class="coach-panel"><h5>Plan de acción recomendado</h5><p class="sub">Pasos concretos para cerrar mejor el mes activo.</p><div class="action-plan-list">${v6ActionPlan(metrics, cats)}</div></div>
      </div>
    </section>`;
  }

  function renderDashboardV6() {
    const html = baseRenderDashboard();
    if (html.includes("v6-financial-coach")) return html;
    return `${html}${v6FinancialCoachPanel()}`;
  }

  function renderMovementsV6() {
    const items = v6FilteredMovements();
    const memberFilterOptions = canSeeAll()
      ? [`<option value="all" ${state.filters.member === "all" ? "selected" : ""}>Todos</option>`, ...visibleMembers().filter(m => m.user_id).map(m => `<option value="${m.user_id}" ${state.filters.member === m.user_id ? "selected" : ""}>${escapeHtml(memberName(m.user_id))}</option>`)].join("")
      : [`<option value="all" ${state.filters.member === "all" ? "selected" : ""}>Todos visibles</option>`, `<option value="${state.user?.id}" ${state.filters.member === state.user?.id ? "selected" : ""}>${escapeHtml(memberName(state.user?.id))}</option>`].join("");
    const sortOptions = [
      ["date", "Fecha"], ["amount", "Monto"], ["concept", "Concepto"], ["category", "Categoría"], ["member", "Persona"], ["type", "Tipo"], ["share", "Reparto"]
    ].map(([value, label]) => `<option value="${value}" ${state.filters.sortField === value ? "selected" : ""}>${label}</option>`).join("");
    return `<section class="section-header"><div class="section-icon-row"><div class="section-badge">📋</div><div><h3>Movimientos del mes</h3><p>Consulta, filtra, ordena, edita y elimina. Incluye puntuales, recurrentes proyectados y cuotas de vehículos.</p></div></div></section>
      <article class="section-card">
        <div class="filters">
          <div class="field"><label>Mes activo</label><input id="filterMonth" type="month" value="${escapeHtml(state.filters.month)}" /></div>
          <div class="field"><label>Vista</label><select id="filterPerson">${filterPersonOptions()}</select></div>
          <div class="field"><label>Tipo</label><select id="filterType"><option value="all" ${state.filters.movementType === "all" ? "selected" : ""}>Todos</option><option value="income" ${state.filters.movementType === "income" ? "selected" : ""}>Ingresos</option><option value="expense" ${state.filters.movementType === "expense" ? "selected" : ""}>Gastos</option></select></div>
          <div class="field"><label>Categoría</label><select id="filterCategory"><option value="all" ${state.filters.category === "all" ? "selected" : ""}>Todas</option>${state.categories.map(c=>`<option value="${c.id}" ${state.filters.category === c.id ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</select></div>
          <div class="field"><label>Miembro</label><select id="filterMember">${memberFilterOptions}</select></div>
          <div class="field"><label>Compartido</label><select id="filterShared"><option value="all" ${state.filters.shared === "all" ? "selected" : ""}>Todos</option><option value="shared" ${state.filters.shared === "shared" ? "selected" : ""}>Solo compartidos</option><option value="individual" ${state.filters.shared === "individual" ? "selected" : ""}>Solo individuales</option></select></div>
          <div class="field"><label>Buscar</label><input id="filterSearch" value="${escapeHtml(state.filters.search || "")}" placeholder="Concepto, nota, categoría o persona" /></div>
          <div class="field"><label>Ordenar por</label><select id="filterSortField">${sortOptions}</select></div>
          <div class="field"><label>Dirección</label><select id="filterSortDirection"><option value="desc" ${state.filters.sortDirection === "desc" ? "selected" : ""}>Mayor / reciente primero</option><option value="asc" ${state.filters.sortDirection === "asc" ? "selected" : ""}>Menor / antiguo primero</option></select></div>
        </div>
        ${renderMovementTable(items, true)}
      </article>`;
  }

  function renderCategoriesV6() {
    return `<section class="section-header"><div class="section-icon-row"><div class="section-badge">🏷️</div><div><h3>Categorías y presupuestos</h3><p>Organiza ingresos y gastos con presupuesto mensual para detectar excesos.</p></div></div></section>
      <section class="categories-grid"><article class="section-card"><h4 id="categoryFormTitle">Nueva categoría</h4><form id="categoryFormV6"><input name="id" type="hidden" /><div class="field"><label>Nombre</label><input name="name" required placeholder="Ej. Mascotas" /></div><div class="inline-grid"><div class="field"><label>Tipo</label><select name="type"><option value="expense">Gasto</option><option value="income">Ingreso</option><option value="both">Ambos</option></select></div><div class="field"><label>Presupuesto mensual</label><input name="budget" type="number" step="0.01" placeholder="Solo gastos" /></div></div><div class="field"><label>Color</label><input name="color" type="color" value="#4aa8ff" /></div><div class="form-actions"><button class="btn primary" type="submit" id="saveCategoryBtn">Guardar categoría</button><button class="btn ghost hidden" type="button" id="cancelCategoryEdit">Cancelar edición</button></div></form></article>
      <article class="section-card"><h4>Listado de categorías</h4>${state.categories.length ? `<div class="table-wrap"><table><thead><tr><th>Nombre</th><th>Tipo</th><th>Presupuesto</th><th>Color</th><th>Acciones</th></tr></thead><tbody>${state.categories.map(c=>`<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.type)}</td><td>${money(c.budget || 0)}</td><td><span class="tag" style="background:${escapeHtml(c.color || '#4aa8ff')};color:white">${escapeHtml(c.color || '')}</span></td><td><div class="td-actions"><button class="btn small" data-edit-category="${c.id}">Editar</button><button class="btn small danger" data-delete-category="${c.id}">Borrar</button></div></td></tr>`).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>Sin categorías</strong>Crea tus primeras categorías.</div>`}</article></section>`;
  }

  function renderGoalsV6() {
    return `<section class="section-header"><div class="section-icon-row"><div class="section-badge">🎯</div><div><h3>Metas de ahorro</h3><p>Objetivos personales o familiares con progreso, fecha límite, icono y notas.</p></div></div></section>
      <section class="goals-grid"><article class="section-card"><h4 id="goalFormTitle">Nueva meta de ahorro</h4><form id="goalFormV6"><input name="id" type="hidden" /><div class="field"><label>Nombre de la meta</label><input name="name" required placeholder="Ej. Fondo de emergencia, Vacaciones 2026" /></div><div class="inline-grid"><div class="field"><label>Importe objetivo (€)</label><input name="target_amount" type="number" step="0.01" required /></div><div class="field"><label>Ahorro acumulado (€)</label><input name="current_amount" type="number" step="0.01" value="0" /></div></div><div class="inline-grid"><div class="field"><label>Fecha límite</label><input name="deadline" type="date" /></div><div class="field"><label>Icono</label><select name="emoji"><option>🎯</option><option>🏠</option><option>🚗</option><option>✈️</option><option>🛟</option><option>💰</option></select></div></div><div class="field"><label>Notas</label><textarea name="notes" placeholder="Describe para qué es esta meta o cómo vas a ahorrar"></textarea></div><div class="form-actions"><button class="btn primary" type="submit" id="saveGoalBtn">Guardar meta</button><button class="btn ghost hidden" type="button" id="cancelGoalEdit">Cancelar edición</button></div></form></article>
      <article class="section-card"><h4>Mis metas</h4>${state.goals.length ? state.goals.map(g=>{ const p = v6Pct(g.current_amount, g.target_amount); return `<div class="goal-card"><header><h5>${escapeHtml(g.emoji || '🎯')} ${escapeHtml(g.name)}</h5><div class="td-actions"><button class="btn small" data-edit-goal="${g.id}">Editar</button><button class="btn small danger" data-delete-goal="${g.id}">Borrar</button></div></header><div class="goal-progress-info"><span>${money(g.current_amount)} / ${money(g.target_amount)}</span><b>${p}%</b></div><div class="goal-bar"><span style="width:${p}%"></span></div><p class="hint">${escapeHtml(g.notes || '')}</p></div>`; }).join("") : `<div class="empty-state"><strong>Sin metas todavía</strong>Añade tu primer objetivo de ahorro.</div>`}</article></section>`;
  }

  function renderRecurringV6() {
    const recurringItems = visibleRecurringItems();
    return `<section class="section-header"><div class="section-icon-row"><div class="section-badge">🔁</div><div><h3>Recurrentes configurados</h3><p>Pagos, ingresos, deudas y servicios variables que se repiten. Se proyectan en Inicio y Movimientos.</p></div></div></section>
      <article class="section-card"><h4>Automáticos y servicios configurados</h4>${recurringItems.length ? `<div class="table-wrap"><table><thead><tr><th>Concepto</th><th>Tipo</th><th>Importe</th><th>Día</th><th>Frecuencia</th><th>Persona</th><th>Compartido</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>${recurringItems.map(r=>{ const actions = canManageRecurringRecord(r) ? `<div class="td-actions"><button class="btn small" data-edit-recurring="${r.id}">Editar</button><button class="btn small danger" data-delete-recurring="${r.id}">Borrar</button></div>` : `<span class="hint">Solo lectura</span>`; return `<tr><td>${escapeHtml(r.description)}</td><td>${r.type==='income'?'Ingreso':'Gasto'}</td><td><strong>${money(r.amount)}</strong></td><td>${escapeHtml(r.day_of_month || '-')}</td><td>${escapeHtml(r.frequency || 'monthly')}</td><td>${escapeHtml(memberName(r.member_id || r.user_id))}</td><td>${r.is_shared?'Sí':'No'}</td><td>${r.active!==false?'Activo':'Inactivo'}</td><td>${actions}</td></tr>`; }).join("")}</tbody></table></div>` : `<div class="empty-state"><strong>Sin recurrentes todavía</strong>Créalo desde Registrar.</div>`}</article>`;
  }

  function renderBackupV6() {
    return `<section class="section-header"><div class="section-icon-row"><div class="section-badge">💾</div><div><h3>Respaldo, importación y demo</h3><p>Exporta tus datos visibles, importa un JSON compatible o carga una prueba rápida.</p></div></div></section>
      <section class="backup-grid"><article class="section-card"><h4>Copias de seguridad</h4><p class="sub">Descarga JSON o CSV de lo que tu usuario tiene permiso de ver.</p><div class="form-actions"><button class="btn primary" id="exportJsonBtn">Exportar JSON</button><button class="btn dark" id="exportCsvBtn">Exportar movimientos CSV</button></div></article>
      <article class="section-card"><h4>Importar JSON / datos de ejemplo</h4><p class="sub">Importa un respaldo generado por Finanzas 360 o carga datos ficticios para comprobar que las gráficas y cálculos se mueven.</p><div class="form-grid"><input id="importJsonFile" type="file" accept="application/json,.json" /><div class="form-actions"><button class="btn ok" id="importJsonBtn" type="button">Importar JSON</button><button class="btn ghost" id="v6SeedDemoBtnBackup" type="button">Cargar datos demo</button></div></div><p class="hint">La importación no borra tu información actual; agrega los registros al hogar activo.</p></article>
      <article class="section-card"><h4>Zona delicada</h4><p class="sub">Para backups completos o restauraciones grandes usa Supabase Dashboard. Esta importación es práctica para migrar datos de usuario.</p></article></section>`;
  }

  function fillCategoryFormV6(id) {
    const c = state.categories.find(x => x.id === id);
    const form = document.getElementById("categoryFormV6");
    if (!c || !form) return;
    form.id.value = c.id;
    form.name.value = c.name || "";
    form.type.value = c.type || "expense";
    form.budget.value = c.budget ?? "";
    form.color.value = c.color || "#4aa8ff";
    document.getElementById("categoryFormTitle").textContent = `Editando categoría: ${c.name}`;
    document.getElementById("saveCategoryBtn").textContent = "Actualizar categoría";
    document.getElementById("cancelCategoryEdit")?.classList.remove("hidden");
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function resetCategoryFormV6() {
    const form = document.getElementById("categoryFormV6");
    if (!form) return;
    form.reset();
    form.id.value = "";
    document.getElementById("categoryFormTitle").textContent = "Nueva categoría";
    document.getElementById("saveCategoryBtn").textContent = "Guardar categoría";
    document.getElementById("cancelCategoryEdit")?.classList.add("hidden");
  }

  async function handleCategorySubmitV6(event) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const id = String(f.get("id") || "").trim();
    const payload = { household_id: state.currentHouseholdId, name: String(f.get("name") || "").trim(), type: f.get("type"), color: f.get("color") || "#4aa8ff", budget: parseAmount(f.get("budget")) };
    if (id) {
      if (!can("categories", "edit")) return showToast("No tienes permiso para editar categorías.", "danger");
      await updateWithSchemaFallback("categories", payload, { id, household_id: state.currentHouseholdId }, "Categoría actualizada.", ["household_id","name","type","color"]);
    } else {
      if (!can("categories", "create")) return showToast("No tienes permiso para crear categorías.", "danger");
      await insertWithSchemaFallback("categories", payload, "Categoría creada.", ["household_id","name","type","color"]);
    }
    await loadHouseholdData(); renderApp();
  }

  function fillGoalFormV6(id) {
    const g = state.goals.find(x => x.id === id);
    const form = document.getElementById("goalFormV6");
    if (!g || !form) return;
    form.id.value = g.id;
    form.name.value = g.name || "";
    form.target_amount.value = g.target_amount ?? "";
    form.current_amount.value = g.current_amount ?? 0;
    form.deadline.value = dateOnly(g.deadline) || "";
    form.emoji.value = g.emoji || "🎯";
    form.notes.value = g.notes || "";
    document.getElementById("goalFormTitle").textContent = `Editando meta: ${g.name}`;
    document.getElementById("saveGoalBtn").textContent = "Actualizar meta";
    document.getElementById("cancelGoalEdit")?.classList.remove("hidden");
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function resetGoalFormV6() {
    const form = document.getElementById("goalFormV6");
    if (!form) return;
    form.reset();
    form.id.value = "";
    form.current_amount.value = 0;
    document.getElementById("goalFormTitle").textContent = "Nueva meta de ahorro";
    document.getElementById("saveGoalBtn").textContent = "Guardar meta";
    document.getElementById("cancelGoalEdit")?.classList.add("hidden");
  }

  async function handleGoalSubmitV6(event) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const id = String(f.get("id") || "").trim();
    const payload = { household_id: state.currentHouseholdId, user_id: state.user.id, name: String(f.get("name") || "").trim(), target_amount: parseAmount(f.get("target_amount")), current_amount: parseAmount(f.get("current_amount")), deadline: f.get("deadline") || null, emoji: String(f.get("emoji") || "🎯"), notes: String(f.get("notes") || "") };
    if (id) {
      if (!can("goals", "edit")) return showToast("No tienes permiso para editar metas.", "danger");
      await updateWithSchemaFallback("goals", payload, { id, household_id: state.currentHouseholdId }, "Meta actualizada.", ["household_id","user_id","name","target_amount","current_amount","deadline"]);
    } else {
      if (!can("goals", "create")) return showToast("No tienes permiso para crear metas.", "danger");
      await insertWithSchemaFallback("goals", payload, "Meta guardada.", ["household_id","user_id","name","target_amount","current_amount","deadline"]);
    }
    await loadHouseholdData(); renderApp();
  }

  async function editRecurringV6(id) {
    const r = state.recurring.find(x => x.id === id);
    if (!r) return showToast("No encontré ese recurrente.", "danger");
    if (!canManageRecurringRecord(r)) return showToast("No puedes editar recurrentes de otro integrante.", "danger");
    if (!can("recurring", "edit") && !can("register", "edit")) return showToast("No tienes permiso para editar recurrentes.", "danger");
    const description = prompt("Concepto del recurrente", r.description || "");
    if (description === null) return;
    const amount = prompt("Importe", r.amount ?? 0);
    if (amount === null) return;
    const activeAnswer = confirm("¿Dejar este recurrente activo? Aceptar = activo / Cancelar = pausado");
    await updateWithSchemaFallback("recurring_movements", { description: String(description || "").trim(), amount: parseAmount(amount), active: activeAnswer }, { id, household_id: state.currentHouseholdId }, "Recurrente actualizado.", ["description","amount","active"]);
    await loadHouseholdData(); renderApp();
  }

  async function seedDemoDataV6() {
    if (!state.currentHouseholdId || !state.user?.id) return;
    const now = activeMonth();
    const demoDescriptions = ["Demo · Nómina", "Demo · Comida", "Demo · Gasolina", "Demo · Internet", "Demo · Ahorro"];
    const existingDemo = state.movements.some(m => demoDescriptions.includes(m.description));
    if (existingDemo && !confirm("Ya hay datos demo. ¿Quieres cargar otra tanda igualmente?")) return;
    const categoryRows = [
      { household_id: state.currentHouseholdId, name: "Demo ingresos", type: "income", color: "#22c55e" },
      { household_id: state.currentHouseholdId, name: "Comida", type: "expense", color: "#ef4444" },
      { household_id: state.currentHouseholdId, name: "Transporte", type: "expense", color: "#f59e0b" },
      { household_id: state.currentHouseholdId, name: "Servicios", type: "expense", color: "#3b82f6" },
      { household_id: state.currentHouseholdId, name: "Ahorro", type: "expense", color: "#10b981" }
    ];
    await supabase.from("categories").upsert(categoryRows, { onConflict: "household_id,name,type" });
    await loadHouseholdData();
    const cat = name => state.categories.find(c => c.name === name)?.id || null;
    const rows = [
      { household_id: state.currentHouseholdId, user_id: state.user.id, member_id: state.user.id, type: "income", amount: 1600, date: `${now}-01`, category_id: cat("Demo ingresos"), description: "Demo · Nómina", notes: "Datos ficticios para probar dashboard", is_shared: false, kind: "personal", share_method: "none" },
      { household_id: state.currentHouseholdId, user_id: state.user.id, member_id: state.user.id, type: "expense", amount: 410, date: `${now}-03`, category_id: cat("Comida"), description: "Demo · Comida", notes: "Gasto compartido de casa", is_shared: true, kind: "shared", share_method: "equal" },
      { household_id: state.currentHouseholdId, user_id: state.user.id, member_id: state.user.id, type: "expense", amount: 280, date: `${now}-08`, category_id: cat("Transporte"), description: "Demo · Gasolina", notes: "Gasto mensual estimado", is_shared: false, kind: "vehicle", share_method: "none" },
      { household_id: state.currentHouseholdId, user_id: state.user.id, member_id: state.user.id, type: "expense", amount: 170, date: `${now}-12`, category_id: cat("Servicios"), description: "Demo · Internet", notes: "Servicio mensual", is_shared: true, kind: "shared", share_method: "equal" },
      { household_id: state.currentHouseholdId, user_id: state.user.id, member_id: state.user.id, type: "expense", amount: 150, date: `${now}-20`, category_id: cat("Ahorro"), description: "Demo · Ahorro", notes: "Aporte ficticio a meta", is_shared: false, kind: "saving", share_method: "none" }
    ];
    for (const row of rows) {
      await insertWithSchemaFallback("movements", row, "", ["household_id","user_id","member_id","type","amount","date","category_id","description","is_shared"]);
    }
    showToast("Datos demo cargados.", "ok");
    await loadHouseholdData(); renderApp();
  }

  function cleanImportRow(row, table) {
    const copy = { ...row };
    delete copy.id; delete copy.created_at; delete copy.updated_at; delete copy._source; delete copy._recurring_id; delete copy._vehicle_record_id;
    copy.household_id = state.currentHouseholdId;
    if (["movements", "goals", "recurring_movements", "vehicle_records"].includes(table)) copy.user_id = state.user.id;
    if (table === "vehicles") copy.owner_id = safeAssignableMemberId(copy.owner_id);
    if (table === "movements" || table === "recurring_movements") copy.member_id = safeAssignableMemberId(copy.member_id);
    if (table === "vehicle_records") copy.responsible_user_id = safeAssignableMemberId(copy.responsible_user_id);
    return copy;
  }

  async function importJsonV6() {
    const input = document.getElementById("importJsonFile");
    const file = input?.files?.[0];
    if (!file) return showToast("Selecciona primero un archivo JSON.", "danger");
    let data;
    try { data = JSON.parse(await file.text()); }
    catch { return showToast("Ese JSON no se pudo leer.", "danger"); }
    if (!confirm("Se agregarán los datos del JSON al hogar activo. No se borrará nada. ¿Continuamos?")) return;
    const tables = [
      ["categories", data.categories || []],
      ["movements", data.movements || []],
      ["recurring_movements", data.recurring || data.recurring_movements || []],
      ["goals", data.goals || []],
      ["vehicles", data.vehicles || []],
      ["vehicle_records", data.vehicle_records || data.vehicleRecords || []]
    ];
    for (const [table, rows] of tables) {
      if (!Array.isArray(rows) || !rows.length) continue;
      const cleaned = rows.map(row => cleanImportRow(row, table));
      await insertWithSchemaFallback(table, cleaned, "", Object.keys(cleaned[0] || {}).filter(k => !["budget","notes","kind","share_method","emoji","brand","model","km","status","concept","payment_mode","insurance_company","coverage_end","installment_day","installment_count","installment_amount"].includes(k)));
    }
    await loadHouseholdData(); renderApp();
    showToast("Importación terminada. Revisa Inicio, Movimientos y Respaldo.", "ok");
  }


  const SECTION_GUIDES = {
    dashboard: "Inicio junta la foto rápida del mes: ingresos, gastos, balance, gráficas y tips. Cambia el mes o la vista arriba y todo el panel se recalcula.",
    categories: "Categorías sirve para ordenar tus gastos e ingresos. Mientras mejor clasifiques, más útiles serán las gráficas, presupuestos y consejos.",
    members: "Hogar administra integrantes, roles, estado y porcentaje de participación. Aquí no registras gastos; solo configuras quién existe y qué puede hacer.",
    household: "Aportes muestra cómo se reparte la casa: ingresos por persona, gastos compartidos, parte común y lectura rápida del hogar.",
    register: "Registrar es la entrada de datos. Desde aquí cargas ingresos, gastos puntuales, gastos compartidos, recurrentes y servicios variables.",
    vehicles: "Vehículos controla coches y motos: seguros, cuotas, mantenimientos, repuestos y alertas. Los importes se reflejan como gastos cuando tienen fecha.",
    movements: "Movimientos es la tabla operativa: aquí revisas el detalle exacto, filtras, editas o eliminas registros según tus permisos.",
    goals: "Metas es para seguir objetivos de ahorro. Guarda el importe objetivo, avance actual y fecha límite para medir progreso.",
    history: "Historial no repite Movimientos: resume la evolución por mes, balances y categorías principales para ver tendencias sin ruido.",
    backup: "Respaldo permite descargar tus datos visibles, importar un JSON compatible o cargar una demo. No sustituye un backup completo de Supabase.",
    recurring: "Recurrentes lista pagos e ingresos automáticos. Sirve para confirmar qué se está proyectando cada mes y corregirlo si algo cambió.",
    reports: "Reportes prepara una lectura imprimible del periodo filtrado: totales, categorías y distribución por persona.",
    admin: "Admin es la zona de control: invitaciones, permisos y acceso global. Úsala con cuidado porque afecta lo que otros pueden ver o tocar."
  };

  function renderSectionGuide(section) {
    const text = SECTION_GUIDES[section];
    if (!text) return "";
    return `<div class="app-section-guide" title="${escapeHtml(text)}"><span>ℹ️</span><small>${escapeHtml(text)}</small></div>`;
  }

  function withSectionGuide(section, html) {
    const guide = renderSectionGuide(section);
    if (!guide || String(html).includes("app-section-guide")) return html;
    const body = String(html || "");
    const firstSectionEnd = body.indexOf("</section>");
    if (firstSectionEnd === -1) return `${guide}${body}`;
    return `${body.slice(0, firstSectionEnd + 10)}${guide}${body.slice(firstSectionEnd + 10)}`;
  }

  function renderSectionV6() {
    const section = state.activeSection;
    let html;
    if (section === "dashboard") html = renderDashboardV6();
    else if (section === "categories") html = renderCategoriesV6();
    else if (section === "members") html = renderMembersSection();
    else if (section === "household") html = renderHousehold();
    else if (section === "register") html = renderRegister();
    else if (section === "vehicles") html = renderVehicles();
    else if (section === "movements") html = renderMovementsV6();
    else if (section === "goals") html = renderGoalsV6();
    else if (section === "history") html = renderHistory();
    else if (section === "backup") html = renderBackupV6();
    else if (section === "recurring") html = renderRecurringV6();
    else if (section === "reports") html = renderReports();
    else if (section === "admin") html = renderAdmin();
    else html = renderDashboardV6();
    return withSectionGuide(section, html);
  }

  function renderAppV6() {
    app.className = "app app-sidebar app-old-mirror";
    const currentHousehold = getCurrentHousehold();
    const modules = visibleModules();
    app.innerHTML = `
      <aside class="side-nav old-side" aria-label="Menú principal">
        <div class="side-brand old-side-brand">
          <div class="brand-logo">F3</div>
          <div><h1>Finanzas 360</h1><span>Tu gestor financiero personal</span></div>
        </div>
        ${state.households.length > 1 ? `<div class="field side-switch"><label>Hogar activo</label><select id="householdSwitcher">${state.households.map(h => `<option value="${h.id}" ${h.id === state.currentHouseholdId ? "selected" : ""}>${escapeHtml(h.name)}</option>`).join("")}</select></div>` : `<div class="side-household-name">${escapeHtml(currentHousehold?.name || "Familia")}</div>`}
        <div class="side-divider"></div>
        <span class="side-menu-title">Menú principal</span>
        <nav class="nav side-menu old-menu">
          ${modules.map(m => `<button type="button" class="${state.activeSection === m.key ? "active" : ""}" data-section="${m.key}"><span>${m.icon}</span><b>${m.label}</b></button>`).join("")}
        </nav>
        <div class="side-footer">
          <div class="side-user"><strong>${escapeHtml(state.profile?.full_name || state.user.email)}</strong><span>${escapeHtml(state.currentMember?.role || "usuario")}</span></div>
          <button class="btn ghost small" id="exportJsonBtn">💾 Exportar datos</button>
          <button class="btn ok small" id="refreshBtn">Actualizar</button>
          <button class="btn danger small" id="logoutBtn">Salir</button>
        </div>
      </aside>
      <main class="content-area old-content">
        ${renderSectionV6()}
      </main>
    `;
    bindCommonActions();
    bindSectionActionsV6();
  }

  function bindSectionActionsV6() {
    baseBindSectionActions();
    document.getElementById("filterMember")?.addEventListener("change", e => { state.filters.member = e.target.value || "all"; renderApp(); });
    document.getElementById("filterShared")?.addEventListener("change", e => { state.filters.shared = e.target.value || "all"; renderApp(); });
    document.getElementById("filterSortField")?.addEventListener("change", e => { state.filters.sortField = e.target.value || "date"; renderApp(); });
    document.getElementById("filterSortDirection")?.addEventListener("change", e => { state.filters.sortDirection = e.target.value || "desc"; renderApp(); });
    document.getElementById("financeFocus")?.addEventListener("change", e => { state.financeCoach.focus = e.target.value || "balance"; renderApp(); });
    document.getElementById("investmentProfile")?.addEventListener("change", e => { state.financeCoach.investmentProfile = e.target.value || "balanced"; renderApp(); });
    document.getElementById("cutIdeasLimit")?.addEventListener("change", e => { state.financeCoach.cutIdeasLimit = Number(e.target.value || 5); renderApp(); });
    document.getElementById("v6SeedDemoBtn")?.addEventListener("click", seedDemoDataV6);
    document.getElementById("v6SeedDemoBtnBackup")?.addEventListener("click", seedDemoDataV6);
    document.getElementById("importJsonBtn")?.addEventListener("click", importJsonV6);
    document.getElementById("categoryFormV6")?.addEventListener("submit", handleCategorySubmitV6);
    document.getElementById("cancelCategoryEdit")?.addEventListener("click", resetCategoryFormV6);
    document.querySelectorAll("[data-edit-category]").forEach(btn => btn.addEventListener("click", () => fillCategoryFormV6(btn.dataset.editCategory)));
    document.getElementById("goalFormV6")?.addEventListener("submit", handleGoalSubmitV6);
    document.getElementById("cancelGoalEdit")?.addEventListener("click", resetGoalFormV6);
    document.querySelectorAll("[data-edit-goal]").forEach(btn => btn.addEventListener("click", () => fillGoalFormV6(btn.dataset.editGoal)));
    document.querySelectorAll("[data-edit-recurring]").forEach(btn => btn.addEventListener("click", () => editRecurringV6(btn.dataset.editRecurring)));
  }

  return { renderAppV6, renderSectionV6, renderDashboardV6, renderMovementsV6, renderCategoriesV6, renderGoalsV6, renderRecurringV6, renderBackupV6, bindSectionActionsV6, v6FilteredMovements };
})();

renderApp = F360V6.renderAppV6;
renderSection = F360V6.renderSectionV6;
renderDashboard = F360V6.renderDashboardV6;
renderMovements = F360V6.renderMovementsV6;
renderCategories = F360V6.renderCategoriesV6;
renderGoals = F360V6.renderGoalsV6;
renderRecurring = F360V6.renderRecurringV6;
renderBackup = F360V6.renderBackupV6;
bindSectionActions = F360V6.bindSectionActionsV6;
getMovementsFiltered = F360V6.v6FilteredMovements;


init();
