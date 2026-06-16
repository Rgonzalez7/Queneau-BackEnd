import { Router } from "express";
import fs from "fs";
import path from "path";
import Stripe from "stripe";

/* ============================================================
   Métodos de pago con Stripe.
   La tarjeta se captura en el frontend con Stripe Elements y va
   DIRECTO a Stripe; aquí solo creamos el SetupIntent, listamos los
   métodos guardados y marcamos el predeterminado. Nunca recibimos
   ni guardamos el número de tarjeta.

   Requiere la variable de entorno STRIPE_SECRET_KEY (sk_test_… / sk_live_…).

   NOTA: como aún no hay autenticación de usuarios, usamos un único
   "customer" de Stripe de demostración, persistido en un archivo.
   Cuando exista login real, reemplaza getCustomerId() por el
   customer del usuario en sesión.
   ============================================================ */

// Stripe perezoso: se crea en el primer uso (no al importar el módulo), así
// un STRIPE_SECRET_KEY ausente no tumba el servidor al arrancar, y la env se
// lee en el momento de la llamada (ya cargada).
let _stripe: InstanceType<typeof Stripe> | null = null;
function getStripe(): InstanceType<typeof Stripe> {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Falta STRIPE_SECRET_KEY en el entorno del backend.");
  _stripe = new Stripe(key);
  return _stripe;
}

const router = Router();


// ---- customer de demostración (se reemplaza con auth real) ----
const CUSTOMER_FILE = path.join(process.cwd(), "stripe-customer.json");

async function getCustomerId(): Promise<string> {
  // 1) variable de entorno explícita
  if (process.env.STRIPE_CUSTOMER_ID) return process.env.STRIPE_CUSTOMER_ID;
  // 2) archivo persistido
  try {
    const raw = fs.readFileSync(CUSTOMER_FILE, "utf8");
    const { id } = JSON.parse(raw) as { id: string };
    if (id) return id;
  } catch {}
  // 3) crear uno nuevo y guardarlo
  const customer = await getStripe().customers.create({ description: "Queneau demo customer" });
  try { fs.writeFileSync(CUSTOMER_FILE, JSON.stringify({ id: customer.id })); } catch {}
  return customer.id;
}

function brandLabel(b?: string) {
  if (!b) return "Tarjeta";
  const map: Record<string, string> = {
    visa: "Visa",
    mastercard: "Mastercard",
    amex: "Amex",
    discover: "Discover",
    diners: "Diners",
    jcb: "JCB",
    unionpay: "UnionPay",
  };
  return map[b] || b.charAt(0).toUpperCase() + b.slice(1);
}

// ---- crear SetupIntent para guardar una tarjeta ----
router.post("/api/account/setup-intent", async (_req, res) => {
  try {
    const customer = await getCustomerId();
    const si = await getStripe().setupIntents.create({
      customer,
      payment_method_types: ["card"],
      usage: "off_session",
    });
    res.json({ clientSecret: si.client_secret });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---- listar métodos guardados ----
router.get("/api/account/payment-methods", async (_req, res) => {
  try {
    const customer = await getCustomerId();
    const cust = (await getStripe().customers.retrieve(customer)) as unknown as {
      invoice_settings?: { default_payment_method?: string | { id: string } | null };
    };
    const defaultRef = cust.invoice_settings?.default_payment_method ?? null;
    const defaultId = typeof defaultRef === "string" ? defaultRef : defaultRef?.id;

    const pms = await getStripe().paymentMethods.list({ customer, type: "card" });
    const out = pms.data.map((pm) => ({
      id: pm.id,
      brand: brandLabel(pm.card?.brand),
      last4: pm.card?.last4 ?? "····",
      exp:
        pm.card
          ? `${String(pm.card.exp_month).padStart(2, "0")}/${String(pm.card.exp_year).slice(-2)}`
          : "",
      def: pm.id === defaultId,
    }));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---- marcar predeterminado ----
router.post("/api/account/payment-methods/default", async (req, res) => {
  try {
    const { id } = req.body as { id?: string };
    if (!id) {
      res.status(400).json({ error: "Falta el id del método." });
      return;
    }
    const customer = await getCustomerId();
    await getStripe().customers.update(customer, {
      invoice_settings: { default_payment_method: id },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---- eliminar (detach) un método ----
router.delete("/api/account/payment-methods/:id", async (req, res) => {
  try {
    await getStripe().paymentMethods.detach(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export default router;
