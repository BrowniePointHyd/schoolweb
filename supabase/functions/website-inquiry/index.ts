// ============================================================
// Supabase Edge Function: website-inquiry
// Receives the public website's inquiry form and creates an
// enquiry in SchoolOS.
//
// This is a PUBLIC function — no login required — so it does its
// own validation, honeypot check and rate limiting before it
// touches the database. The service_role key NEVER leaves the
// server; the website only ever talks to this function.
//
// Deploy:
//   supabase functions deploy website-inquiry --no-verify-jwt
// Secrets needed (SUPABASE_URL is auto-provided):
//   supabase secrets set SERVICE_ROLE_KEY=eyJ...
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY")!;

// branch dropdown value -> SchoolOS branch UUID
const BRANCH_IDS: Record<string,string> = {
  chandanagar: "f2b791e4-9024-4b36-b8b3-e1316b0b59a3",
  kondapur:    "65ded354-361e-4a9c-bcfd-d8dcb35d56a3",
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// simple in-memory rate limit: max 5 submissions per IP per 10 minutes.
// (resets if the function instance recycles — fine for light abuse control.)
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const list = (hits.get(ip) || []).filter(t => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  return list.length > 5;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => null);
    if (!body) return json({ error: "Invalid request" }, 400);

    // ---- 1. honeypot — bots fill this hidden field ----
    if (typeof body.hp_field === "string" && body.hp_field.trim() !== "") {
      // pretend success so the bot moves on
      return json({ ok: true });
    }

    // ---- 2. math challenge — must add up correctly ----
    const qa = Number(body.quiz_a);
    const qb = Number(body.quiz_b);
    const qans = Number(body.quiz_answer);
    if (!Number.isInteger(qa) || !Number.isInteger(qb) ||
        !Number.isInteger(qans) || qa + qb !== qans) {
      return json({ error: "The quick check answer isn't right. Please try again." }, 400);
    }

    // ---- 3. rate limit by IP ----
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
             || req.headers.get("cf-connecting-ip") || "unknown";
    if (rateLimited(ip)) {
      return json({ error: "Too many submissions. Please try again later." }, 429);
    }

    // ---- 4. validate input ----
    const name   = String(body.parent_name || "").trim();
    const phone  = String(body.phone || "").trim();
    const child  = String(body.child || "").trim();
    const branch = String(body.branch || "").trim();
    const prog   = String(body.programme || "").trim();
    const msg    = String(body.message || "").trim();

    if (name.length < 2)  return json({ error: "Please enter your name." }, 400);
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 12) {
      return json({ error: "Please enter a valid mobile number." }, 400);
    }
    const branchId = BRANCH_IDS[branch];
    if (!branchId) return json({ error: "Please choose a branch." }, 400);

    // length guards — stop abuse / overflow
    if (name.length > 120 || child.length > 120 || msg.length > 1000) {
      return json({ error: "Input too long." }, 400);
    }

    // ---- 5. insert the enquiry (service role) ----
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const ref = "WEB-" + Date.now();
    const notes = [
      child ? `Child: ${child}` : "",
      prog  ? `Programme of interest: ${prog}` : "",
      msg   ? `Message: ${msg}` : "",
    ].filter(Boolean).join("\n");

    const { error } = await admin.from("enquiries").insert({
      branch_id:    branchId,
      reference_no: ref,
      student_name: child || `${name}'s child`,
      father_name:  name,
      phone:        phone,
      source:       "website",
      status:       "new",
      notes:        notes,
    });

    if (error) {
      console.error("insert failed:", error);
      return json({ error: "Could not save your enquiry. Please call us." }, 500);
    }

    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong." }, 500);
  }
});
