/**
 * PayPal day-1 gate (CLAUDE.md section 9). Sandbox only.
 *
 * Proves three money flows against the PayPal sandbox before any feature work:
 *   void     authorize -> void            (expect authorization VOIDED)
 *   capture  authorize -> capture         (expect capture COMPLETED)
 *   reauth   authorize -> reauthorize -> capture against the NEW authorization id
 *
 * Usage:
 *   pnpm gate:paypal                          run all three flows
 *   pnpm gate:paypal --only capture           run one flow (void | capture | reauth)
 *   pnpm gate:paypal --auth-check             check credentials + payee account, no approval needed
 *   pnpm gate:paypal --reauth <authId>        retry reauthorize + capture on a held authorization
 *   --currency USD --amount-minor 500         defaults: USD, 500 (= 5.00)
 *
 * Each flow prints an approval link. Open it, log in as a sandbox *personal*
 * account (see sandbox-accounts.local.md) and approve. The script polls until
 * the order is APPROVED, then continues. Results are written to SETUP_STATUS.md.
 *
 * The client secret and access token are never printed or written anywhere.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

const ROOT = resolve(import.meta.dirname, "..");
const STATUS_FILE = resolve(ROOT, "SETUP_STATUS.md");
// Hard-coded on purpose: this script must never be able to reach the live API.
const PAYPAL_BASE = "https://api-m.sandbox.paypal.com";
const HONOR_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;
const APPROVAL_POLL_MS = 4_000;
const APPROVAL_TIMEOUT_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// Env + output safety
// ---------------------------------------------------------------------------

const EnvSchema = z.object({
  PAYPAL_ENV: z.literal("sandbox"),
  PAYPAL_CLIENT_ID: z.string().min(1),
  PAYPAL_CLIENT_SECRET: z.string().min(1),
  PUBLIC_BASE_URL: z.union([z.url(), z.literal("")]).optional(),
});
type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const envPath = resolve(ROOT, ".env");
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Only print which keys are wrong, never their values.
    const keys = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))];
    console.error(`Invalid or missing env keys: ${keys.join(", ")}`);
    console.error('PAYPAL_ENV must be "sandbox"; PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in .env.');
    process.exit(1);
  }
  return parsed.data;
}

const env = loadEnv();
const SENSITIVE = [env.PAYPAL_CLIENT_SECRET, env.PAYPAL_CLIENT_ID];

/** Belt and braces: strip credentials from anything we print or write. */
function redact(text: string): string {
  let out = text;
  for (const s of SENSITIVE) out = out.split(s).join("[redacted]");
  return out;
}
const log = (msg = ""): void => console.log(redact(msg));
const logErr = (msg: string): void => console.error(redact(msg));

// ---------------------------------------------------------------------------
// Money: integer minor units inside, PayPal string only at the API boundary
// ---------------------------------------------------------------------------

function currencyExponent(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

function toPayPalValue(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error(`amountMinor must be a positive integer, got ${amountMinor}`);
  }
  const exp = currencyExponent(currency);
  if (exp === 0) return String(amountMinor);
  const digits = String(amountMinor).padStart(exp + 1, "0");
  return `${digits.slice(0, -exp)}.${digits.slice(-exp)}`;
}

// ---------------------------------------------------------------------------
// Minimal typed PayPal client (sandbox)
// ---------------------------------------------------------------------------

class PayPalError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly errorName: string,
    readonly issue: string | undefined,
    readonly debugId: string | undefined,
    description: string,
  ) {
    super(description);
  }
  summary(): string {
    return [`HTTP ${this.httpStatus}`, this.errorName, this.issue, this.message, this.debugId && `debug_id ${this.debugId}`]
      .filter(Boolean)
      .join(" | ");
  }
}

const PayPalErrorBody = z
  .object({
    name: z.string().optional(),
    error: z.string().optional(), // OAuth endpoint uses this shape
    message: z.string().optional(),
    error_description: z.string().optional(),
    debug_id: z.string().optional(),
    details: z.array(z.object({ issue: z.string().optional(), description: z.string().optional() })).optional(),
  })
  .loose();

let cachedToken: { value: string; expiresAt: number } | undefined;

async function accessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  const basic = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw toPayPalError(res, json);
  const body = z.object({ access_token: z.string(), expires_in: z.number() }).parse(json);
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return cachedToken.value;
}

function toPayPalError(res: Response, json: unknown): PayPalError {
  const body = PayPalErrorBody.safeParse(json);
  const b = body.success ? body.data : {};
  return new PayPalError(
    res.status,
    b.name ?? b.error ?? "UNKNOWN_ERROR",
    b.details?.[0]?.issue,
    b.debug_id ?? res.headers.get("paypal-debug-id") ?? undefined,
    b.details?.[0]?.description ?? b.message ?? b.error_description ?? res.statusText,
  );
}

async function paypal<S extends z.ZodType>(
  method: "GET" | "POST",
  path: string,
  schema: S,
  opts: { body?: unknown; requestId?: string } = {},
): Promise<z.infer<S>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await accessToken()}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  if (method === "POST") {
    // Idempotency: retries with the same id never repeat a money action.
    headers["PayPal-Request-Id"] = opts.requestId ?? randomUUID();
  }
  const init: RequestInit = { method, headers };
  if (method === "POST") init.body = JSON.stringify(opts.body ?? {});
  const res = await fetch(`${PAYPAL_BASE}${path}`, init);
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : {};
  if (!res.ok) throw toPayPalError(res, json);
  return schema.parse(json);
}

const Link = z.object({ href: z.string(), rel: z.string() });
const Order = z
  .object({
    id: z.string(),
    status: z.string(),
    links: z.array(Link).optional(),
    payer: z.object({ payer_id: z.string().optional(), address: z.object({ country_code: z.string().optional() }).loose().optional() }).loose().optional(),
    purchase_units: z
      .array(
        z
          .object({
            payee: z.object({ email_address: z.string().optional(), merchant_id: z.string().optional() }).loose().optional(),
            payments: z
              .object({ authorizations: z.array(z.object({ id: z.string(), status: z.string() }).loose()).optional() })
              .loose()
              .optional(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();
const Authorization = z
  .object({ id: z.string(), status: z.string(), create_time: z.string().optional(), expiration_time: z.string().optional() })
  .loose();
const Capture = z
  .object({ id: z.string(), status: z.string(), status_details: z.object({ reason: z.string() }).loose().optional() })
  .loose();
const Empty = z.unknown();

const api = {
  createOrder: (label: string, amountMinor: number, currency: string, requestId: string) => {
    const returnBase = env.PUBLIC_BASE_URL || "https://example.com";
    return paypal("POST", "/v2/checkout/orders", Order, {
      requestId,
      body: {
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: `gate-${label}`,
            description: `CommitSpot day-1 gate: ${label}`,
            amount: { currency_code: currency, value: toPayPalValue(amountMinor, currency) },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: "CommitSpot",
              shipping_preference: "NO_SHIPPING",
              return_url: `${returnBase}/gate/return`,
              cancel_url: `${returnBase}/gate/cancel`,
            },
          },
        },
      },
    });
  },
  getOrder: (id: string) => paypal("GET", `/v2/checkout/orders/${id}`, Order),
  authorizeOrder: (id: string, requestId: string) => paypal("POST", `/v2/checkout/orders/${id}/authorize`, Order, { requestId }),
  getAuthorization: (id: string) => paypal("GET", `/v2/payments/authorizations/${id}`, Authorization),
  voidAuthorization: (id: string, requestId: string) => paypal("POST", `/v2/payments/authorizations/${id}/void`, Empty, { requestId }),
  reauthorize: (id: string, requestId: string) =>
    paypal("POST", `/v2/payments/authorizations/${id}/reauthorize`, Authorization, { requestId }),
  capture: (id: string, requestId: string) =>
    paypal("POST", `/v2/payments/authorizations/${id}/capture`, Capture, { requestId, body: { final_capture: true } }),
  getCapture: (id: string) => paypal("GET", `/v2/payments/captures/${id}`, Capture),
};

// ---------------------------------------------------------------------------
// Flow helpers
// ---------------------------------------------------------------------------

type FlowName = "void" | "capture" | "reauth";
type Outcome = "PASS" | "FAIL" | "WAITING";
interface FlowResult {
  flow: FlowName;
  outcome: Outcome;
  lines: string[];
}

const FLOW_TITLES: Record<FlowName, string> = {
  void: "Authorize → void",
  capture: "Authorize → capture",
  reauth: "Authorize → reauthorize → capture",
};
const SUGGESTED_PAYER: Record<FlowName, string> = {
  void: "Player 1 (US)",
  capture: "Player 2 (GB)",
  reauth: "Player 3 (CA)",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForApproval(orderId: string): Promise<z.infer<typeof Order>> {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const order = await api.getOrder(orderId);
    if (order.status === "APPROVED") return order;
    if (order.status === "VOIDED" || order.status === "COMPLETED") {
      throw new Error(`Order ${orderId} is ${order.status}, cannot authorize`);
    }
    await sleep(APPROVAL_POLL_MS);
  }
  throw new Error(`Timed out after ${APPROVAL_TIMEOUT_MS / 60_000} min waiting for approval of order ${orderId}`);
}

/** Create order, wait for buyer approval, authorize. Returns the authorization. */
async function createAndAuthorize(flow: FlowName, amountMinor: number, currency: string, lines: string[]) {
  const order = await api.createOrder(flow, amountMinor, currency, `gate-${flow}-order-${randomUUID()}`);
  const approve = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve");
  if (!approve) throw new Error(`Order ${order.id} has no approval link`);
  lines.push(`Order \`${order.id}\` created (${toPayPalValue(amountMinor, currency)} ${currency}, intent AUTHORIZE)`);

  log(`  Approve as a sandbox personal account, e.g. ${SUGGESTED_PAYER[flow]}:`);
  log(`  ${approve.href}`);
  log("  Waiting for approval (Ctrl+C to stop)...");

  const approved = await waitForApproval(order.id);
  const country = approved.payer?.address?.country_code;
  lines.push(`Approved by sandbox payer${country ? ` in ${country}` : ""}`);
  log(`  Approved${country ? ` by a payer in ${country}` : ""}.`);

  const authorized = await api.authorizeOrder(order.id, `gate-${flow}-authorize-${randomUUID()}`);
  const auth = authorized.purchase_units?.[0]?.payments?.authorizations?.[0];
  if (!auth) throw new Error(`Authorize on order ${order.id} returned no authorization`);
  const details = await api.getAuthorization(auth.id);
  lines.push(`Authorization \`${auth.id}\` status ${details.status}, expires ${details.expiration_time ?? "?"}`);
  log(`  Authorized: ${auth.id} (${details.status})`);
  return details;
}

async function captureAndConfirm(authId: string, flow: FlowName, lines: string[]): Promise<boolean> {
  const capture = await api.capture(authId, `gate-${flow}-capture-${randomUUID()}`);
  const confirmed = await api.getCapture(capture.id);
  const reason = confirmed.status_details?.reason ? ` (${confirmed.status_details.reason})` : "";
  lines.push(`Captured against \`${authId}\` → capture \`${confirmed.id}\` status ${confirmed.status}${reason}`);
  log(`  Capture ${confirmed.id}: ${confirmed.status}${reason}`);
  return confirmed.status === "COMPLETED";
}

function describeError(err: unknown): string {
  if (err instanceof PayPalError) return err.summary();
  if (err instanceof z.ZodError) return `Unexpected PayPal response shape: ${err.issues.map((i) => i.path.join(".")).join(", ")}`;
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// The three flows
// ---------------------------------------------------------------------------

async function flowVoid(amountMinor: number, currency: string): Promise<FlowResult> {
  const lines: string[] = [];
  const auth = await createAndAuthorize("void", amountMinor, currency, lines);
  await api.voidAuthorization(auth.id, `gate-void-void-${randomUUID()}`);
  const after = await api.getAuthorization(auth.id);
  lines.push(`Voided \`${auth.id}\` → status ${after.status}`);
  log(`  Void: ${after.status}`);
  return { flow: "void", outcome: after.status === "VOIDED" ? "PASS" : "FAIL", lines };
}

async function flowCapture(amountMinor: number, currency: string): Promise<FlowResult> {
  const lines: string[] = [];
  const auth = await createAndAuthorize("capture", amountMinor, currency, lines);
  const ok = await captureAndConfirm(auth.id, "capture", lines);
  return { flow: "capture", outcome: ok ? "PASS" : "FAIL", lines };
}

/**
 * Reauthorize, then capture against the new id. PayPal only allows reauthorization
 * after the 3-day honor period, so inside it we expect an error. In that case the
 * authorization is left held (not captured) so it can be retried with --reauth later.
 */
async function reauthAndCapture(authId: string, lines: string[]): Promise<Outcome> {
  try {
    const fresh = await api.reauthorize(authId, `gate-reauth-reauthorize-${randomUUID()}`);
    lines.push(`Reauthorized \`${authId}\` → new authorization \`${fresh.id}\` status ${fresh.status}`);
    log(`  Reauthorized: new id ${fresh.id} (${fresh.status})`);
    return (await captureAndConfirm(fresh.id, "reauth", lines)) ? "PASS" : "FAIL";
  } catch (err) {
    if (!(err instanceof PayPalError)) throw err;
    const auth = await api.getAuthorization(authId);
    const created = auth.create_time ? new Date(auth.create_time) : undefined;
    const insideHonor = created ? Date.now() - created.getTime() < HONOR_PERIOD_MS : undefined;
    lines.push(`Reauthorize rejected: ${err.summary()}`);
    if (insideHonor && created) {
      const retryAt = new Date(created.getTime() + HONOR_PERIOD_MS).toISOString();
      lines.push(`Still inside the 3-day honor period. Authorization \`${authId}\` is left held (status ${auth.status}).`);
      lines.push(`Retry after ${retryAt}: \`pnpm gate:paypal --reauth ${authId}\``);
      log(`  Reauthorize rejected inside honor period: ${err.summary()}`);
      log(`  Left ${authId} held. Retry after ${retryAt} with: pnpm gate:paypal --reauth ${authId}`);
      return "WAITING";
    }
    lines.push(`Authorization status ${auth.status}; outside the honor period, so this is a real failure.`);
    log(`  Reauthorize failed: ${err.summary()}`);
    return "FAIL";
  }
}

async function flowReauth(amountMinor: number, currency: string): Promise<FlowResult> {
  const lines: string[] = [];
  const auth = await createAndAuthorize("reauth", amountMinor, currency, lines);
  const outcome = await reauthAndCapture(auth.id, lines);
  return { flow: "reauth", outcome, lines };
}

async function flowReauthExisting(authId: string): Promise<FlowResult> {
  const lines: string[] = [];
  const auth = await api.getAuthorization(authId);
  lines.push(`Retrying held authorization \`${authId}\` (status ${auth.status}, created ${auth.create_time ?? "?"})`);
  log(`  Authorization ${authId}: ${auth.status}`);
  if (auth.status !== "CREATED" && auth.status !== "PENDING") {
    lines.push("Authorization is no longer open, so it cannot be reauthorized.");
    return { flow: "reauth", outcome: "FAIL", lines };
  }
  const outcome = await reauthAndCapture(authId, lines);
  return { flow: "reauth", outcome, lines };
}

// ---------------------------------------------------------------------------
// SETUP_STATUS.md writer: each flow owns one marked block, replaced on rerun
// ---------------------------------------------------------------------------

const GATE_START = "<!-- paypal-gate:start -->";
const GATE_END = "<!-- paypal-gate:end -->";

function writeResult(r: FlowResult, currency: string): void {
  const icon = { PASS: "✅", FAIL: "❌", WAITING: "⏳" }[r.outcome];
  const block = [
    `<!-- gate:${r.flow}:start -->`,
    `#### ${icon} ${FLOW_TITLES[r.flow]}: ${r.outcome}`,
    "",
    `- Run at ${new Date().toISOString()} (UTC), sandbox, ${currency}`,
    ...r.lines.map((l) => `- ${l}`),
    `<!-- gate:${r.flow}:end -->`,
  ].join("\n");

  let doc = existsSync(STATUS_FILE) ? readFileSync(STATUS_FILE, "utf8") : "# Setup status\n";
  if (!doc.includes(GATE_START)) {
    doc = `${doc.trimEnd()}\n\n## PayPal day-1 gate results\n\n${GATE_START}\n${GATE_END}\n`;
  }
  const blockRe = new RegExp(`<!-- gate:${r.flow}:start -->[\\s\\S]*?<!-- gate:${r.flow}:end -->`);
  if (blockRe.test(doc)) {
    doc = doc.replace(blockRe, () => block);
  } else {
    doc = doc.replace(GATE_END, () => `${block}\n\n${GATE_END}`);
  }
  writeFileSync(STATUS_FILE, redact(doc));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function authCheck(currency: string): Promise<void> {
  await accessToken();
  log("OAuth token: OK (sandbox)");
  // An unapproved order moves no money; it expires on its own. Used to read the payee account.
  const order = await api.createOrder("auth-check", 100, currency, `gate-authcheck-${randomUUID()}`);
  const payee = order.purchase_units?.[0]?.payee;
  log(`Test order ${order.id}: ${order.status}`);
  log(`Payee (organizer) account: ${payee?.email_address ?? "?"} (merchant id ${payee?.merchant_id ?? "?"})`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      only: { type: "string" },
      reauth: { type: "string" },
      currency: { type: "string", default: "USD" },
      "amount-minor": { type: "string", default: "500" },
      "auth-check": { type: "boolean", default: false },
    },
  });
  const currency = z.string().regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO code").parse(values.currency);
  const amountMinor = z.coerce.number().int().positive().parse(values["amount-minor"]);

  log(`PayPal day-1 gate, sandbox (${PAYPAL_BASE})`);
  if (values["auth-check"]) return authCheck(currency);

  const flows: { name: FlowName; run: () => Promise<FlowResult> }[] = values.reauth
    ? [{ name: "reauth", run: () => flowReauthExisting(values.reauth as string) }]
    : (
        [
          { name: "void", run: () => flowVoid(amountMinor, currency) },
          { name: "capture", run: () => flowCapture(amountMinor, currency) },
          { name: "reauth", run: () => flowReauth(amountMinor, currency) },
        ] as const
      ).filter((f) => !values.only || f.name === values.only);
  if (flows.length === 0) throw new Error(`--only must be one of: void, capture, reauth`);

  const results: FlowResult[] = [];
  for (const f of flows) {
    log(`\n▶ ${FLOW_TITLES[f.name]}`);
    let result: FlowResult;
    try {
      result = await f.run();
    } catch (err) {
      const msg = describeError(err);
      logErr(`  Failed: ${msg}`);
      result = { flow: f.name, outcome: "FAIL", lines: [`Error: ${msg}`] };
    }
    writeResult(result, currency);
    results.push(result);
  }

  log("\nSummary");
  for (const r of results) log(`  ${r.outcome.padEnd(7)} ${FLOW_TITLES[r.flow]}`);
  log(`Results written to ${STATUS_FILE}`);
  if (results.some((r) => r.outcome === "FAIL")) process.exitCode = 1;
}

main().catch((err: unknown) => {
  logErr(`Gate aborted: ${describeError(err)}`);
  process.exitCode = 1;
});
