import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });

const MODULES = [
  "dashboard",
  "categories",
  "members",
  "household",
  "register",
  "vehicles",
  "movements",
  "goals",
  "history",
  "backup",
  "recurring",
  "reports",
  "admin"
];

function permissionsForRole(role: string) {
  if (role === "admin") {
    return MODULES.map(module => ({ module, can_view: true, can_create: true, can_edit: true, can_delete: true }));
  }

  const editable = role !== "viewer";
  return [
    { module: "dashboard", can_view: true, can_create: false, can_edit: false, can_delete: false },
    { module: "categories", can_view: true, can_create: editable, can_edit: editable, can_delete: false },
    { module: "members", can_view: true, can_create: false, can_edit: false, can_delete: false },
    { module: "household", can_view: true, can_create: false, can_edit: false, can_delete: false },
    { module: "register", can_view: editable, can_create: editable, can_edit: editable, can_delete: false },
    { module: "vehicles", can_view: false, can_create: false, can_edit: false, can_delete: false },
    { module: "movements", can_view: true, can_create: editable, can_edit: editable, can_delete: false },
    { module: "goals", can_view: true, can_create: editable, can_edit: editable, can_delete: editable },
    { module: "history", can_view: true, can_create: false, can_edit: false, can_delete: false },
    { module: "backup", can_view: true, can_create: false, can_edit: false, can_delete: false },
    { module: "recurring", can_view: editable, can_create: editable, can_edit: editable, can_delete: false },
    { module: "reports", can_view: role !== "viewer", can_create: false, can_edit: false, can_delete: false },
    { module: "admin", can_view: false, can_create: false, can_edit: false, can_delete: false }
  ];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_ANON_PUBLIC_KEY") || serviceRoleKey;

  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    return json({ error: "Faltan variables SUPABASE_URL, SUPABASE_ANON_KEY o SUPABASE_SERVICE_ROLE_KEY en la Edge Function." }, 500);
  }

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "Sesión no encontrada." }, 401);

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data: userData, error: userError } = await authClient.auth.getUser();
  const caller = userData?.user;
  if (userError || !caller) return json({ error: "Sesión inválida o caducada." }, 401);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  try {
    const body = await req.json();
    const householdId = String(body.household_id || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const fullName = String(body.full_name || "").trim();
    const role = ["admin", "member", "viewer"].includes(String(body.role)) ? String(body.role) : "member";
    const status = String(body.status) === "disabled" ? "disabled" : "active";
    const householdType = String(body.household_type || "family");
    const participationPercent = body.participation_percent === null || body.participation_percent === "" || Number.isNaN(Number(body.participation_percent))
      ? null
      : Number(body.participation_percent);
    const dependent = Boolean(body.dependent);

    if (!householdId) return json({ error: "Falta el hogar." }, 400);
    if (!email || !email.includes("@")) return json({ error: "Email inválido." }, 400);
    if (!fullName) return json({ error: "Falta el nombre visible." }, 400);
    if (!password || password.length < 6) return json({ error: "La contraseña debe tener mínimo 6 caracteres." }, 400);

    const { data: household, error: householdError } = await admin
      .from("households")
      .select("id, owner_id")
      .eq("id", householdId)
      .maybeSingle();

    if (householdError || !household) return json({ error: "Hogar no encontrado." }, 404);

    const { data: callerMember } = await admin
      .from("household_members")
      .select("role,status")
      .eq("household_id", householdId)
      .eq("user_id", caller.id)
      .maybeSingle();

    const callerIsAdmin = household.owner_id === caller.id || (callerMember?.role === "admin" && callerMember?.status === "active");
    if (!callerIsAdmin) return json({ error: "Solo el administrador puede crear usuarios." }, 403);

    let createdUserId = "";
    let updatedExisting = false;

    const { data: existingProfile } = await admin
      .from("profiles")
      .select("user_id")
      .eq("email", email)
      .maybeSingle();

    if (existingProfile?.user_id) {
      createdUserId = existingProfile.user_id;
      updatedExisting = true;
      const { error: updateUserError } = await admin.auth.admin.updateUserById(createdUserId, {
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName }
      });
      if (updateUserError) return json({ error: updateUserError.message }, 400);
    } else {
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName }
      });
      if (createError || !created?.user) return json({ error: createError?.message || "No se pudo crear el usuario." }, 400);
      createdUserId = created.user.id;
    }

    const { error: profileError } = await admin.from("profiles").upsert({
      user_id: createdUserId,
      email,
      full_name: fullName,
      updated_at: new Date().toISOString()
    }, { onConflict: "user_id" });
    if (profileError) return json({ error: profileError.message }, 400);

    const { error: memberError } = await admin.from("household_members").upsert({
      household_id: householdId,
      user_id: createdUserId,
      role,
      status,
      display_name: fullName,
      household_type: householdType,
      participation_percent: participationPercent,
      works: !dependent,
      contributes_income: !dependent,
      dependent
    }, { onConflict: "household_id,user_id" });
    if (memberError) return json({ error: memberError.message }, 400);

    const permissions = permissionsForRole(role).map(p => ({
      household_id: householdId,
      user_id: createdUserId,
      module: p.module,
      can_view: p.can_view,
      can_create: p.can_create,
      can_edit: p.can_edit,
      can_delete: p.can_delete,
      updated_at: new Date().toISOString()
    }));

    const { error: permissionsError } = await admin
      .from("permissions")
      .upsert(permissions, { onConflict: "household_id,user_id,module" });
    if (permissionsError) return json({ error: permissionsError.message }, 400);

    await admin.from("invitations")
      .update({ status: "accepted", accepted_at: new Date().toISOString() })
      .eq("household_id", householdId)
      .eq("invited_email", email);

    return json({
      ok: true,
      user_id: createdUserId,
      email,
      role,
      status,
      updated_existing: updatedExisting
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Error inesperado." }, 500);
  }
});
