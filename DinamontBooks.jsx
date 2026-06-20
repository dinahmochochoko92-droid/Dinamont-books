import { useState, useRef, useEffect } from "react";

// ═══════════════════════════════════════════════════════════════════════════
// DESIGN TOKENS
// ═══════════════════════════════════════════════════════════════════════════
const G    = "#16803c";   // primary green
const G2   = "#1ea54f";   // bright green (accents)
const G3   = "#e3f6e9";   // pale green (backgrounds)
const DK   = "#0c1f12";   // near-black green (nav/headers)
const W    = "#ffffff";
const OFF  = "#f6f9f7";   // off-white app background
const GR1  = "#eaf1ec";   // light border
const GR2  = "#c7d9cd";   // medium border
const GR3  = "#7e9888";   // muted text
const TX   = "#13261a";   // body text
const RD   = "#c0392b";
const AM   = "#d97706";
const BL   = "#1d6fa4";

const fmt = n => `R${(+n || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const toDay = () => new Date().toISOString().slice(0, 10);
const uid = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const VAT_RATE = 0.15;

// ═══════════════════════════════════════════════════════════════════════════
// AI — Anthropic API calls
// ═══════════════════════════════════════════════════════════════════════════
async function callClaude(messages, maxTokens = 1000) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, messages }),
  });
  const data = await res.json();
  return data.content?.map(b => b.text || "").join("") || "";
}

const TXN_CATS = ["Materials & Supplies", "Fuel & Transport", "Labour", "Subcontractors",
  "Professional Fees", "Bank Charges", "Airtime & Data", "Food & Entertainment",
  "Office & Stationery", "Insurance", "Equipment", "Utilities", "Rent",
  "Investment / Savings", "VAT Payment", "Tax", "Salary / Wages", "Client Payment",
  "Loan Proceeds", "Interest Income", "Other Income", "Other Expense", "Uncategorised"];

const RECEIPT_CATS = ["Materials & Supplies", "Fuel & Transport", "Labour", "Subcontractors",
  "Professional Fees", "Food & Entertainment", "Office & Stationery", "Equipment",
  "Utilities", "Bank Charges", "Other Expense"];

async function aiCategoriseTransactions(txns) {
  const prompt = `South African construction bookkeeper. Categorise each transaction. Return ONLY a JSON array (no markdown).
Each element: {"category":string,"vatApplicable":boolean,"type":"income"|"expense"|"transfer"|"fee"}
Categories: ${JSON.stringify(TXN_CATS.filter(c => c !== "Uncategorised"))}
Transactions: ${JSON.stringify(txns.map(t => ({ description: t.description, amount: t.debit || t.credit, type: t.debit ? "debit" : "credit" })))}`;
  const txt = await callClaude([{ role: "user", content: prompt }], 1200);
  try { return JSON.parse(txt.replace(/```json|```/g, "").trim()); }
  catch { return txns.map(() => ({ category: "Other Expense", vatApplicable: false, type: "expense" })); }
}

async function extractPDFTransactions(b64) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 4000, messages: [{
      role: "user", content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
        { type: "text", text: `Extract ALL transactions from this SA bank statement. Return ONLY a JSON array.
Each: {"date":"YYYY-MM-DD","description":"string","debit":number,"credit":number,"balance":number}
Only transaction rows. No headers, no totals, no summaries.` }
      ]
    }] })
  });
  const data = await res.json();
  const txt = data.content?.map(b => b.text || "").join("") || "[]";
  try { return JSON.parse(txt.replace(/```json|```/g, "").trim()); }
  catch { return []; }
}

async function scanReceiptImage(b64, mediaType) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 800, messages: [{
      role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
        { type: "text", text: `South African bookkeeper scanning a receipt photo. Extract details. Return ONLY JSON (no markdown):
{"supplier":"name","date":"YYYY-MM-DD or empty","total":number,"vatAmount":number,"category":"${RECEIPT_CATS.join("|")}","description":"what was bought","vatNumber":"VAT no or empty"}` }
      ]
    }] })
  });
  const data = await res.json();
  const txt = data.content?.map(b => b.text || "").join("") || "{}";
  try { return JSON.parse(txt.replace(/```json|```/g, "").trim()); }
  catch { return { supplier: "Unknown", date: "", total: 0, vatAmount: 0, category: "Other Expense", description: "", vatNumber: "" }; }
}

async function scanReceiptPDF(b64) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 800, messages: [{
      role: "user", content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
        { type: "text", text: `Extract receipt/invoice details. Return ONLY JSON:
{"supplier":"name","date":"YYYY-MM-DD","total":number,"vatAmount":number,"category":"${RECEIPT_CATS.join("|")}","description":"what was bought","vatNumber":"VAT no or empty"}` }
      ]
    }] })
  });
  const data = await res.json();
  const txt = data.content?.map(b => b.text || "").join("") || "{}";
  try { return JSON.parse(txt.replace(/```json|```/g, "").trim()); }
  catch { return { supplier: "Unknown", date: "", total: 0, vatAmount: 0, category: "Other Expense", description: "", vatNumber: "" }; }
}

async function askAIAccountant(question, financialContext) {
  const prompt = `You are a helpful, friendly South African accountant assistant inside "Dinamont Books", a bookkeeping app for a construction company called Dinamont (Pty) Ltd.
Answer the user's question clearly and concisely, using South African accounting/tax conventions (VAT at 15%, SARS terminology, ZAR currency).
Where relevant, use the live financial data below to give specific, accurate answers — don't make up numbers.
Keep answers conversational and practical, not overly long. Use Rand formatting (R) for amounts.

LIVE FINANCIAL DATA:
${JSON.stringify(financialContext)}

USER QUESTION: ${question}`;
  return await callClaude([{ role: "user", content: prompt }], 1200);
}

// ═══════════════════════════════════════════════════════════════════════════
// PDF OUTPUT (print-to-PDF)
// ═══════════════════════════════════════════════════════════════════════════
function printDoc(elementId, filename) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const w = window.open("", "_blank", "width=900,height=700");
  w.document.write(`<!DOCTYPE html><html><head><title>${filename}</title>
    <style>*{box-sizing:border-box;}body{margin:0;background:#fff;}
    @media print{@page{size:A4;margin:0;}body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}
    </style></head><body>${el.outerHTML}</body></html>`);
  w.document.close(); w.focus();
  setTimeout(() => w.print(), 600);
}

// ═══════════════════════════════════════════════════════════════════════════
// UI PRIMITIVES
// ═══════════════════════════════════════════════════════════════════════════
const inp = { border: `1px solid ${GR2}`, borderRadius: 8, padding: "10px 12px", fontSize: 14, width: "100%", boxSizing: "border-box", outline: "none", background: W, color: TX, fontFamily: "inherit" };

function Btn({ onClick, children, danger, sm, lg, disabled, full, outline, type = "button" }) {
  return (
    <button type={type} onClick={onClick} disabled={disabled} style={{
      background: disabled ? GR2 : outline ? "transparent" : danger ? RD : G,
      color: outline ? G : W, border: outline ? `2px solid ${G}` : "none",
      borderRadius: 8, padding: lg ? "13px 20px" : sm ? "6px 12px" : "10px 18px",
      fontSize: lg ? 15 : sm ? 12 : 14, cursor: disabled ? "default" : "pointer",
      fontWeight: 600, whiteSpace: "nowrap", width: full ? "100%" : "auto",
      opacity: disabled ? 0.6 : 1, transition: "opacity .15s, transform .1s",
    }}>{children}</button>
  );
}

function Tag({ color, children }) {
  return <span style={{ background: color + "1c", color, border: `1px solid ${color}44`, borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 600, display: "inline-block" }}>{children}</span>;
}

function Field({ label, children, half }) {
  return (
    <div style={{ marginBottom: 12, width: half ? "48%" : "100%" }}>
      <div style={{ fontSize: 11, color: GR3, marginBottom: 4, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      {children}
    </div>
  );
}

function Card({ children, onClick, pad }) {
  return (
    <div onClick={onClick} style={{ background: W, borderRadius: 12, padding: pad || "14px 16px", marginBottom: 10, boxShadow: "0 1px 8px rgba(13,40,24,.06)", cursor: onClick ? "pointer" : "default", border: `1px solid ${GR1}` }}>
      {children}
    </div>
  );
}

function Modal({ title, onClose, onSave, children, wide, saveLabel }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(8,20,12,.6)", zIndex: 1000, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: W, borderRadius: "18px 18px 0 0", width: "100%", maxWidth: wide ? 860 : 520, maxHeight: "92vh", display: "flex", flexDirection: "column" }}>
        <div style={{ background: G, borderRadius: "18px 18px 0 0", padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
          <span style={{ color: W, fontWeight: 700, fontSize: 16 }}>{title}</span>
          <button onClick={onClose} style={{ background: "rgba(255,255,255,.15)", border: "none", color: W, fontSize: 16, cursor: "pointer", lineHeight: 1, width: 30, height: 30, borderRadius: "50%" }}>✕</button>
        </div>
        <div style={{ overflowY: "auto", padding: 20, flex: 1 }}>{children}</div>
        {onSave && <div style={{ padding: "14px 20px", borderTop: `1px solid ${GR1}`, display: "flex", gap: 10, justifyContent: "flex-end", flexShrink: 0 }}>
          <Btn danger onClick={onClose}>Cancel</Btn>
          <Btn onClick={onSave}>{saveLabel || "Save"}</Btn>
        </div>}
      </div>
    </div>
  );
}

function Confirm({ msg, onYes, onNo }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(8,20,12,.6)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: W, borderRadius: 14, padding: 26, maxWidth: 300, width: "100%", textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>⚠️</div>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 18, color: TX }}>{msg}</div>
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <Btn outline onClick={onNo}>Cancel</Btn>
          <Btn danger onClick={onYes}>Delete</Btn>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ icon, title, subtitle }) {
  return (
    <div style={{ textAlign: "center", padding: "48px 20px", color: GR3 }}>
      <div style={{ fontSize: 44, marginBottom: 10 }}>{icon}</div>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6, color: TX }}>{title}</div>
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>{subtitle}</div>
    </div>
  );
}
// ═══════════════════════════════════════════════════════════════════════════
// AUTH STORAGE (simulated — replace with Supabase Auth in production)
// ═══════════════════════════════════════════════════════════════════════════
const seedUsers = () => [{
  id: "u1", email: "dinahmochochoko92@gmail.com", password: "Dinah@1990",
  name: "Dinah Mochochoko", company: "Dinamont (Pty) Ltd", role: "Director",
}];

function AuthShell({ children }) {
  return (
    <div style={{ minHeight: "100vh", background: `linear-gradient(160deg, ${DK} 0%, ${G} 100%)`, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: W, borderRadius: 20, padding: 32, width: "100%", maxWidth: 380, boxShadow: "0 8px 40px rgba(0,0,0,.3)" }}>
        <div style={{ textAlign: "center", marginBottom: 26 }}>
          <div style={{ width: 60, height: 60, background: G, borderRadius: 16, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px", boxShadow: `0 4px 16px ${G}55` }}>
            <span style={{ color: W, fontSize: 26, fontWeight: 900 }}>D</span>
          </div>
          <div style={{ fontSize: 21, fontWeight: 900, color: G, letterSpacing: 1.5 }}>DINAMONT BOOKS</div>
          <div style={{ fontSize: 12, color: GR3, marginTop: 2 }}>Bookkeeping for SA Construction</div>
        </div>
        {children}
      </div>
    </div>
  );
}

function SignIn({ users, onLogin, goRegister, goForgot }) {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [err, setErr] = useState("");

  const login = () => {
    const u = users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === pass);
    if (u) onLogin(u);
    else setErr("Incorrect email or password. Please try again.");
  };

  return (
    <AuthShell>
      {err && <div style={{ background: "#fee", border: `1px solid ${RD}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: RD, marginBottom: 16 }}>{err}</div>}
      <Field label="Email Address">
        <input value={email} onChange={e => { setEmail(e.target.value); setErr(""); }} type="email" placeholder="your@email.com" style={inp} onKeyDown={e => e.key === "Enter" && login()} />
      </Field>
      <Field label="Password">
        <div style={{ position: "relative" }}>
          <input value={pass} onChange={e => { setPass(e.target.value); setErr(""); }} type={showPass ? "text" : "password"} placeholder="••••••••" style={{ ...inp, paddingRight: 44 }} onKeyDown={e => e.key === "Enter" && login()} />
          <button onClick={() => setShowPass(s => !s)} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: GR3, fontSize: 16 }}>{showPass ? "🙈" : "👁"}</button>
        </div>
      </Field>
      <div style={{ textAlign: "right", marginBottom: 18 }}>
        <button onClick={goForgot} style={{ background: "none", border: "none", color: G, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0 }}>Forgot password?</button>
      </div>
      <Btn full lg onClick={login}>Sign In</Btn>
      <div style={{ textAlign: "center", marginTop: 18, fontSize: 13, color: GR3 }}>
        Don't have an account?{" "}
        <button onClick={goRegister} style={{ background: "none", border: "none", color: G, fontWeight: 700, cursor: "pointer", padding: 0, fontSize: 13 }}>Create one</button>
      </div>
      <div style={{ marginTop: 16, padding: "10px 14px", background: G3, borderRadius: 8, fontSize: 11, color: G }}>
        <b>Demo login:</b> dinahmochochoko92@gmail.com / Dinah@1990
      </div>
    </AuthShell>
  );
}

function Register({ users, onRegister, goSignIn }) {
  const [form, setForm] = useState({ name: "", company: "Dinamont (Pty) Ltd", email: "", password: "", confirm: "" });
  const [err, setErr] = useState("");
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = () => {
    if (!form.name || !form.email || !form.password) { setErr("Please fill in all required fields."); return; }
    if (form.password.length < 6) { setErr("Password must be at least 6 characters."); return; }
    if (form.password !== form.confirm) { setErr("Passwords do not match."); return; }
    if (users.some(u => u.email.toLowerCase() === form.email.toLowerCase())) { setErr("An account with this email already exists."); return; }
    const newUser = { id: uid(), email: form.email, password: form.password, name: form.name, company: form.company, role: "Owner" };
    onRegister(newUser);
  };

  return (
    <AuthShell>
      <div style={{ fontWeight: 800, fontSize: 16, color: TX, marginBottom: 14, textAlign: "center" }}>Create Your Account</div>
      {err && <div style={{ background: "#fee", border: `1px solid ${RD}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: RD, marginBottom: 14 }}>{err}</div>}
      <Field label="Full Name *"><input value={form.name} onChange={e => set("name", e.target.value)} style={inp} placeholder="Dinah Mochochoko" /></Field>
      <Field label="Company Name"><input value={form.company} onChange={e => set("company", e.target.value)} style={inp} /></Field>
      <Field label="Email Address *"><input type="email" value={form.email} onChange={e => set("email", e.target.value)} style={inp} placeholder="your@email.com" /></Field>
      <Field label="Password *"><input type="password" value={form.password} onChange={e => set("password", e.target.value)} style={inp} placeholder="At least 6 characters" /></Field>
      <Field label="Confirm Password *"><input type="password" value={form.confirm} onChange={e => set("confirm", e.target.value)} style={inp} onKeyDown={e => e.key === "Enter" && submit()} /></Field>
      <div style={{ marginTop: 6 }}><Btn full lg onClick={submit}>Create Account</Btn></div>
      <div style={{ textAlign: "center", marginTop: 16, fontSize: 13, color: GR3 }}>
        Already have an account?{" "}
        <button onClick={goSignIn} style={{ background: "none", border: "none", color: G, fontWeight: 700, cursor: "pointer", padding: 0, fontSize: 13 }}>Sign in</button>
      </div>
    </AuthShell>
  );
}

function ForgotPassword({ users, goSignIn }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");

  const submit = () => {
    if (!email) { setErr("Please enter your email address."); return; }
    // In production this triggers a real password-reset email via Supabase Auth.
    setSent(true);
  };

  if (sent) {
    return (
      <AuthShell>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 44, marginBottom: 10 }}>📧</div>
          <div style={{ fontWeight: 800, fontSize: 16, color: TX, marginBottom: 8 }}>Check Your Email</div>
          <div style={{ fontSize: 13, color: GR3, lineHeight: 1.6, marginBottom: 22 }}>
            If an account exists for <b>{email}</b>, we've sent password reset instructions to that address.
          </div>
          <Btn full onClick={goSignIn}>Back to Sign In</Btn>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div style={{ fontWeight: 800, fontSize: 16, color: TX, marginBottom: 8, textAlign: "center" }}>Reset Your Password</div>
      <div style={{ fontSize: 13, color: GR3, marginBottom: 18, textAlign: "center", lineHeight: 1.5 }}>Enter your email address and we'll send you instructions to reset your password.</div>
      {err && <div style={{ background: "#fee", border: `1px solid ${RD}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, color: RD, marginBottom: 14 }}>{err}</div>}
      <Field label="Email Address"><input type="email" value={email} onChange={e => { setEmail(e.target.value); setErr(""); }} style={inp} placeholder="your@email.com" onKeyDown={e => e.key === "Enter" && submit()} /></Field>
      <div style={{ marginTop: 8 }}><Btn full lg onClick={submit}>Send Reset Link</Btn></div>
      <div style={{ textAlign: "center", marginTop: 16 }}>
        <button onClick={goSignIn} style={{ background: "none", border: "none", color: G, fontWeight: 700, cursor: "pointer", padding: 0, fontSize: 13 }}>← Back to Sign In</button>
      </div>
    </AuthShell>
  );
}
// ═══════════════════════════════════════════════════════════════════════════
// DEMO SEED DATA
// ═══════════════════════════════════════════════════════════════════════════
const DEMO_CUSTOMERS = [
  { id: "c1", name: "ABC Construction (Pty) Ltd", contact: "Mr. J. Dlamini", email: "info@abcconstruction.co.za", phone: "082 123 4567", address: "12 Industrial Road, Bloemfontein, 9301", type: "Client" },
  { id: "c2", name: "BCB Solutions", contact: "Ms. T. Mokoena", email: "admin@bcbsolutions.co.za", phone: "051 444 5555", address: "45 Brand Street, Bloemfontein, 9300", type: "Client" },
  { id: "c3", name: "Engen Fuel", contact: "Manager", email: "accounts@engen.co.za", phone: "0800 202 202", address: "Nationwide", type: "Supplier" },
];

const DEMO_QUOTES = [{
  id: "q1", number: "QUO-2026-0001", date: "2026-05-26", validUntil: "2026-06-25",
  clientName: "ABC Construction (Pty) Ltd", contactPerson: "Mr. J. Dlamini",
  clientEmail: "info@abcconstruction.co.za", clientPhone: "082 123 4567",
  clientAddress: "12 Industrial Road, Bloemfontein, 9301",
  siteName: "ABC Warehouse Project", siteAddress: "Portion 45, Farm 117, Bloemfontein",
  siteContact: "Mr. J. Dlamini", sitePhone: "082 123 4567",
  description: "Supply and Installation of Roofing", status: "Accepted", notes: "", convertedToInvoice: false,
  lineItems: [
    { description: "IBR Roofing Sheets (0.47mm)", qty: 150, unit: "m²", unitPrice: 185 },
    { description: "Roof Insulation", qty: 150, unit: "m²", unitPrice: 45 },
    { description: "Installation of Roofing Sheets", qty: 150, unit: "m²", unitPrice: 110 },
    { description: "Supply and Installation of Ceiling", qty: 150, unit: "m²", unitPrice: 120 },
    { description: "Miscellaneous (Sundries)", qty: 1, unit: "Lot", unitPrice: 2500 },
  ],
}];

const DEMO_TXN = [
  { id: "t1", date: "2026-05-02", description: "ATM CASH", debit: 4000, credit: 0, balance: 707.98, category: "Cash Withdrawals", type: "expense", vatApplicable: false },
  { id: "t2", date: "2026-05-05", description: "CAP JUSTINVEST", debit: 0, credit: 5000, balance: 5003.23, category: "Investment / Savings", type: "income", vatApplicable: false },
  { id: "t3", date: "2026-05-06", description: "ENGEN LIBRA MO", debit: 1282.90, credit: 0, balance: 1506.58, category: "Fuel & Transport", type: "expense", vatApplicable: true },
  { id: "t4", date: "2026-05-07", description: "SuperSpar Kenw", debit: 209, credit: 0, balance: 2083.36, category: "Food & Entertainment", type: "expense", vatApplicable: true },
  { id: "t5", date: "2026-05-13", description: "ENGEN BLOEM 1", debit: 750.10, credit: 0, balance: 659.09, category: "Fuel & Transport", type: "expense", vatApplicable: true },
  { id: "t6", date: "2026-05-07", description: "CAP JUSTINVEST", debit: 0, credit: 2000, balance: 3276.70, category: "Investment / Savings", type: "income", vatApplicable: false },
  { id: "t7", date: "2026-05-27", description: "Bank charges", debit: 284.25, credit: 0, balance: -22.16, category: "Bank Charges", type: "expense", vatApplicable: true },
  { id: "t8", date: "2026-05-13", description: "INT JUSTINVEST", debit: 0, credit: 10.27, balance: 1225.78, category: "Interest Income", type: "income", vatApplicable: false },
];

// ═══════════════════════════════════════════════════════════════════════════
// PRINTABLE DOCUMENT TEMPLATE (Quotation / Invoice)
// ═══════════════════════════════════════════════════════════════════════════
function DocTemplate({ doc, type }) {
  const sub = doc.lineItems.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  const vat = sub * VAT_RATE, total = sub + vat;
  const cell = (extra) => ({ padding: "7px 8px", fontSize: 11, ...extra });
  return (
    <div id="doc-print" style={{ fontFamily: "Georgia, serif", background: W, color: "#111", maxWidth: 800, margin: "0 auto" }}>
      <div style={{ background: G, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "20px 28px" }}>
        <div>
          <div style={{ color: W, fontSize: 24, fontWeight: 900, letterSpacing: 4, fontFamily: "sans-serif" }}>DINAMONT</div>
          <div style={{ color: G3, fontSize: 10, marginTop: 2 }}>Dinamont (Pty) Ltd — Books</div>
        </div>
        <div style={{ textAlign: "right", color: W, fontSize: 10, lineHeight: 1.8 }}>
          <div>Reg No: 2021/882885/07</div>
          <div>4342 Mtyobile Street, Bochabela</div>
          <div>Bloemfontein, 9323</div>
          <div>dinahmochochoko92@gmail.com</div>
          <div>078 951 2516</div>
        </div>
      </div>
      <div style={{ background: G3, padding: "8px 28px" }}>
        <span style={{ fontSize: 20, fontWeight: 900, color: G, letterSpacing: 2 }}>{type.toUpperCase()}</span>
      </div>
      <div style={{ padding: "14px 28px", fontSize: 11, lineHeight: 2 }}>
        <b>{type} No:</b> {doc.number} &nbsp;&nbsp; <b>Date:</b> {doc.date}
        {doc.validUntil && <span> &nbsp;&nbsp; <b>Valid Until:</b> {doc.validUntil}</span>}
        {doc.dueDate && <span> &nbsp;&nbsp; <b>Due Date:</b> {doc.dueDate}</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, margin: "0 28px 14px" }}>
        {[["CLIENT DETAILS", [["Client", doc.clientName], ["Contact", doc.contactPerson], ["Email", doc.clientEmail], ["Phone", doc.clientPhone], ["Address", doc.clientAddress]]],
          ["SITE / DELIVERY", [["Site", doc.siteName], ["Address", doc.siteAddress], ["Contact", doc.siteContact], ["Phone", doc.sitePhone]]]].map(([title, rows]) => (
          <div key={title} style={{ border: `1px solid ${G}`, borderRadius: 6, padding: "10px 14px", fontSize: 10 }}>
            <div style={{ color: G, fontWeight: 700, marginBottom: 6 }}>{title}</div>
            {rows.map(([k, v]) => <div key={k} style={{ lineHeight: 1.9 }}><b>{k}:</b> {v || "—"}</div>)}
          </div>
        ))}
      </div>
      <table style={{ width: "calc(100% - 56px)", margin: "0 28px", borderCollapse: "collapse", fontSize: 10 }}>
        <thead>
          <tr style={{ background: DK, color: W }}>
            {["#", "Description", "QTY", "Unit", "Unit Price", "Amount"].map(h => (
              <th key={h} style={{ padding: "7px 8px", textAlign: h === "Amount" || h === "Unit Price" ? "right" : "left", fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {doc.lineItems.map((l, i) => (
            <tr key={i} style={{ background: i % 2 === 0 ? W : OFF }}>
              <td style={cell({})}>{i + 1}</td>
              <td style={cell({})}>{l.description}</td>
              <td style={cell({})}>{l.qty}</td>
              <td style={cell({})}>{l.unit}</td>
              <td style={cell({ textAlign: "right" })}>{fmt(l.unitPrice)}</td>
              <td style={cell({ textAlign: "right", fontWeight: 600 })}>{fmt(l.qty * l.unitPrice)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", justifyContent: "flex-end", margin: "0 28px 14px" }}>
        <table style={{ fontSize: 11, borderCollapse: "collapse", minWidth: 260 }}>
          <tbody>
            {[["Subtotal (Excl. VAT)", sub], ["VAT (15%)", vat]].map(([l, v]) => (
              <tr key={l}><td style={{ padding: "5px 14px 5px 28px", fontWeight: 600, textAlign: "right" }}>{l}</td>
              <td style={{ padding: "5px 14px", textAlign: "right", borderLeft: `1px solid ${GR2}` }}>{fmt(v)}</td></tr>
            ))}
            <tr style={{ background: G }}>
              <td style={{ padding: "7px 14px 7px 28px", color: W, fontWeight: 700, textAlign: "right" }}>TOTAL (Incl. VAT)</td>
              <td style={{ padding: "7px 14px", color: W, fontWeight: 700, textAlign: "right" }}>{fmt(total)}</td>
            </tr>
            {type === "Invoice" && doc.amountPaid > 0 && (<>
              <tr><td style={{ padding: "5px 14px 5px 28px", fontWeight: 600, textAlign: "right", color: G2 }}>Amount Paid</td>
              <td style={{ padding: "5px 14px", textAlign: "right", borderLeft: `1px solid ${GR2}`, color: G2 }}>-{fmt(doc.amountPaid)}</td></tr>
              <tr style={{ background: RD }}>
                <td style={{ padding: "7px 14px 7px 28px", color: W, fontWeight: 700, textAlign: "right" }}>BALANCE DUE</td>
                <td style={{ padding: "7px 14px", color: W, fontWeight: 700, textAlign: "right" }}>{fmt(total - doc.amountPaid)}</td>
              </tr>
            </>)}
          </tbody>
        </table>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, margin: "0 28px 20px", fontSize: 10 }}>
        <div>
          <div style={{ color: G, fontWeight: 700, marginBottom: 4 }}>NOTES</div>
          <p style={{ color: "#555", lineHeight: 1.7, margin: 0 }}>{doc.notes || "Thank you for the opportunity. Please do not hesitate to contact us."}</p>
          <div style={{ color: G, fontWeight: 700, margin: "10px 0 4px" }}>BANKING DETAILS</div>
          {[["Bank", "Standard Bank"], ["Account Name", "Dinamont (Pty) Ltd"], ["Acc No", "1023 456 789"], ["Branch", "051 001 – Bloemfontein"]].map(([k, v]) => (
            <div key={k} style={{ lineHeight: 1.9 }}><b>{k}:</b> {v}</div>
          ))}
        </div>
        <div>
          <div style={{ color: G, fontWeight: 700, marginBottom: 4 }}>TERMS &amp; CONDITIONS</div>
          <ul style={{ color: "#555", paddingLeft: 14, lineHeight: 1.9, margin: 0, fontSize: 10 }}>
            <li>{type === "Quotation" ? "Valid 30 days from date above." : "Payment due within 30 days."}</li>
            <li>50% deposit required before commencement.</li>
            <li>Balance payable on completion.</li>
            <li>All workmanship guaranteed 12 months.</li>
          </ul>
          <div style={{ marginTop: 16, textAlign: "right" }}>
            <div style={{ color: G, fontWeight: 700, marginBottom: 6 }}>AUTHORISED SIGNATURE</div>
            <div style={{ height: 40, borderBottom: `1px solid #333`, marginBottom: 6, width: "70%", marginLeft: "auto" }} />
            <div>Dinah Mochochoko – Director</div>
          </div>
        </div>
      </div>
      <div style={{ textAlign: "center", padding: "12px 28px", color: G, fontStyle: "italic", fontSize: 12, borderTop: `1px solid ${GR2}` }}>
        Thank you for your business!
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CUSTOMERS
// ═══════════════════════════════════════════════════════════════════════════
function Customers({ ctx }) {
  const { customers, setCustomers, showToast, askConfirm } = ctx;
  const [form, setForm] = useState(null);
  const [search, setSearch] = useState("");
  const blank = { id: "", name: "", contact: "", email: "", phone: "", address: "", type: "Client" };

  const save = () => {
    if (!form.name) { showToast("Name is required", "error"); return; }
    if (form.id) setCustomers(cs => cs.map(c => c.id === form.id ? form : c));
    else setCustomers(cs => [...cs, { ...form, id: uid() }]);
    setForm(null); showToast("Customer saved ✅");
  };
  const del = (id) => askConfirm("Delete this customer?", () => { setCustomers(cs => cs.filter(c => c.id !== id)); showToast("Deleted"); });

  const filtered = customers.filter(c => c.name.toLowerCase().includes(search.toLowerCase()) || c.contact.toLowerCase().includes(search.toLowerCase()));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: TX }}>{customers.length} Customers</span>
        <Btn sm onClick={() => setForm({ ...blank })}>+ Add Customer</Btn>
      </div>
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search customers…" style={{ ...inp, marginBottom: 14 }} />
      {filtered.length === 0 ? <EmptyState icon="👥" title="No customers yet" subtitle="Add your first client or supplier to get started." /> :
        filtered.map(c => (
          <Card key={c.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: TX }}>{c.name}</div>
                <div style={{ fontSize: 12, color: GR3, marginTop: 2 }}>{c.contact} · {c.phone}</div>
                <div style={{ fontSize: 11, color: GR3 }}>{c.email}</div>
                <div style={{ marginTop: 6 }}><Tag color={c.type === "Client" ? G : c.type === "Supplier" ? AM : BL}>{c.type}</Tag></div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginLeft: 10 }}>
                <Btn sm onClick={() => setForm({ ...c })}>✏ Edit</Btn>
                <Btn sm danger onClick={() => del(c.id)}>🗑 Del</Btn>
              </div>
            </div>
          </Card>
        ))}
      {form && (
        <Modal title={form.id ? "Edit Customer" : "New Customer"} onClose={() => setForm(null)} onSave={save}>
          {[["Full Name *", "name", "text"], ["Contact Person", "contact", "text"], ["Email", "email", "email"], ["Phone", "phone", "tel"], ["Address", "address", "text"]].map(([l, k, t]) => (
            <Field key={k} label={l}><input type={t} value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} style={inp} /></Field>
          ))}
          <Field label="Type">
            <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} style={inp}>
              <option>Client</option><option>Supplier</option><option>Subcontractor</option>
            </select>
          </Field>
        </Modal>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// QUOTATIONS & INVOICES (with quote → invoice conversion, payment tracking)
// ═══════════════════════════════════════════════════════════════════════════
function Documents({ ctx, type }) {
  const { customers, quotations, setQuotations, invoices, setInvoices, showToast, askConfirm, setPage } = ctx;
  const docs = type === "Quotation" ? quotations : invoices;
  const setDocs = type === "Quotation" ? setQuotations : setInvoices;
  const prefix = type === "Quotation" ? "QUO" : "INV";
  const [form, setForm] = useState(null);
  const [preview, setPreview] = useState(null);
  const [payModal, setPayModal] = useState(null);

  const blankDoc = () => ({
    id: "", number: `${prefix}-2026-${String(docs.length + 1).padStart(4, "0")}`,
    date: toDay(), validUntil: "", dueDate: "", description: "", status: "Draft",
    clientName: "", contactPerson: "", clientEmail: "", clientPhone: "", clientAddress: "",
    siteName: "", siteAddress: "", siteContact: "", sitePhone: "", notes: "",
    amountPaid: 0, payments: [], fromQuoteNumber: "",
    lineItems: [{ description: "", qty: 1, unit: "m²", unitPrice: 0 }],
  });

  const save = () => {
    if (!form.clientName) { showToast("Client name required", "error"); return; }
    if (form.id) setDocs(ds => ds.map(d => d.id === form.id ? form : d));
    else setDocs(ds => [...ds, { ...form, id: uid() }]);
    setForm(null); showToast(`${type} saved ✅`);
  };
  const del = (id) => askConfirm(`Delete this ${type}?`, () => { setDocs(ds => ds.filter(d => d.id !== id)); showToast("Deleted"); });
  const sub = (doc) => doc.lineItems.reduce((s, l) => s + l.qty * l.unitPrice, 0);
  const updateLine = (i, k, v) => setForm(f => ({ ...f, lineItems: f.lineItems.map((l, j) => j === i ? { ...l, [k]: v } : l) }));

  // ── Convert quotation to invoice ──
  const convertToInvoice = (quote) => {
    const newInvoice = {
      ...quote, id: uid(), number: `INV-2026-${String(invoices.length + 1).padStart(4, "0")}`,
      date: toDay(), dueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      status: "Sent", amountPaid: 0, payments: [], fromQuoteNumber: quote.number,
      validUntil: undefined,
    };
    setInvoices(inv => [...inv, newInvoice]);
    setQuotations(qs => qs.map(q => q.id === quote.id ? { ...q, convertedToInvoice: true, status: "Accepted" } : q));
    showToast(`✅ Converted to ${newInvoice.number}`);
    setPage("invoices");
  };

  const recordPayment = (amount) => {
    if (!payModal || amount <= 0) return;
    setInvoices(inv => inv.map(i => {
      if (i.id !== payModal.id) return i;
      const newPaid = i.amountPaid + amount;
      const total = sub(i) * 1.15;
      return { ...i, amountPaid: newPaid, payments: [...(i.payments || []), { date: toDay(), amount }], status: newPaid >= total ? "Paid" : "Partially Paid" };
    }));
    setPayModal(null); showToast(`Payment of ${fmt(amount)} recorded ✅`);
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: TX }}>{docs.length} {type}s</span>
        <Btn sm onClick={() => setForm(blankDoc())}>+ New {type}</Btn>
      </div>

      {docs.length === 0 ? <EmptyState icon={type === "Quotation" ? "📄" : "🧾"} title={`No ${type.toLowerCase()}s yet`} subtitle={`Create your first ${type.toLowerCase()} to get started.`} /> :
        docs.slice().reverse().map(d => {
          const total = sub(d) * 1.15;
          const balanceDue = total - (d.amountPaid || 0);
          return (
            <Card key={d.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: TX }}>{d.number}</div>
                  {d.fromQuoteNumber && <div style={{ fontSize: 10, color: BL }}>↳ from {d.fromQuoteNumber}</div>}
                  <div style={{ fontSize: 12, color: GR3, marginTop: 2 }}>{d.clientName} · {d.date}</div>
                  <div style={{ fontSize: 12, color: TX, marginTop: 2 }}>{d.description}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <Tag color={d.status === "Accepted" || d.status === "Paid" ? G : d.status === "Partially Paid" ? AM : d.status === "Sent" ? BL : GR3}>{d.status}</Tag>
                    <span style={{ fontWeight: 700, color: G, fontSize: 13 }}>{fmt(total)}</span>
                  </div>
                  {type === "Invoice" && d.amountPaid > 0 && (
                    <div style={{ fontSize: 11, color: balanceDue > 0 ? AM : G, marginTop: 4 }}>
                      Paid: {fmt(d.amountPaid)} {balanceDue > 0 ? `· Due: ${fmt(balanceDue)}` : "· Fully paid ✓"}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5, marginLeft: 8 }}>
                  <Btn sm onClick={() => setPreview(d)}>👁 View</Btn>
                  <Btn sm onClick={() => setForm({ ...d, lineItems: d.lineItems.map(l => ({ ...l })) })}>✏ Edit</Btn>
                  {type === "Quotation" && !d.convertedToInvoice && (
                    <Btn sm onClick={() => convertToInvoice(d)}>➜ Invoice</Btn>
                  )}
                  {type === "Invoice" && d.status !== "Paid" && (
                    <Btn sm onClick={() => setPayModal(d)}>💵 Pay</Btn>
                  )}
                  <Btn sm danger onClick={() => del(d.id)}>🗑 Del</Btn>
                </div>
              </div>
            </Card>
          );
        })}

      {/* Preview + PDF */}
      {preview && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.8)", zIndex: 1000, display: "flex", flexDirection: "column" }}>
          <div style={{ background: DK, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ color: W, fontWeight: 600, flex: 1, fontSize: 14 }}>{preview.number}</span>
            <Btn sm onClick={() => printDoc("doc-print", `${preview.number}.pdf`)}>🖨 Print</Btn>
            <Btn sm onClick={() => printDoc("doc-print", `${preview.number}.pdf`)}>⬇ PDF</Btn>
            <Btn sm danger onClick={() => setPreview(null)}>✕</Btn>
          </div>
          <div style={{ flex: 1, overflowY: "auto", background: "#f0f0f0", padding: 12 }}>
            <DocTemplate doc={preview} type={type} />
          </div>
        </div>
      )}

      {/* Payment modal */}
      {payModal && <PaymentModal doc={payModal} total={sub(payModal) * 1.15} onClose={() => setPayModal(null)} onRecord={recordPayment} />}

      {/* Edit form */}
      {form && (
        <Modal title={`${form.id ? "Edit" : "New"} ${type}`} onClose={() => setForm(null)} onSave={save} wide>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0 4%" }}>
            {[["Number", "number"], ["Date", "date", "date"], [type === "Quotation" ? "Valid Until" : "Due Date", type === "Quotation" ? "validUntil" : "dueDate", "date"], ["Description", "description"]].map(([l, k, t]) => (
              <Field key={k} label={l} half><input type={t || "text"} value={form[k] || ""} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} style={inp} /></Field>
            ))}
            <Field label="Status" half>
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} style={inp}>
                {type === "Quotation" ? ["Draft", "Sent", "Accepted", "Declined"].map(s => <option key={s}>{s}</option>) : ["Draft", "Sent", "Partially Paid", "Paid", "Overdue"].map(s => <option key={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Autofill Client" half>
              <select onChange={e => { const c = customers.find(x => x.name === e.target.value); if (c) setForm(f => ({ ...f, clientName: c.name, contactPerson: c.contact, clientEmail: c.email, clientPhone: c.phone, clientAddress: c.address })); }} style={inp}>
                <option value="">— select —</option>
                {customers.map(c => <option key={c.id}>{c.name}</option>)}
              </select>
            </Field>
          </div>
          <div style={{ background: GR1, borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 12, color: G, marginBottom: 8 }}>CLIENT DETAILS</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0 4%" }}>
              {[["Client Name *", "clientName"], ["Contact Person", "contactPerson"], ["Email", "clientEmail"], ["Phone", "clientPhone"], ["Address", "clientAddress"]].map(([l, k]) => (
                <Field key={k} label={l} half><input value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} style={inp} /></Field>
              ))}
            </div>
          </div>
          <div style={{ background: GR1, borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ fontWeight: 700, fontSize: 12, color: G, marginBottom: 8 }}>SITE / DELIVERY</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0 4%" }}>
              {[["Site Name", "siteName"], ["Site Address", "siteAddress"], ["Site Contact", "siteContact"], ["Site Phone", "sitePhone"]].map(([l, k]) => (
                <Field key={k} label={l} half><input value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} style={inp} /></Field>
              ))}
            </div>
          </div>
          <div style={{ fontWeight: 700, fontSize: 13, color: TX, marginBottom: 8 }}>Line Items</div>
          {form.lineItems.map((li, i) => (
            <div key={i} style={{ background: GR1, borderRadius: 8, padding: 10, marginBottom: 8, position: "relative" }}>
              <button onClick={() => setForm(f => ({ ...f, lineItems: f.lineItems.filter((_, j) => j !== i) }))} style={{ position: "absolute", right: 8, top: 8, background: RD, color: W, border: "none", borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontSize: 12 }}>✕</button>
              <Field label="Description"><input value={li.description} onChange={e => updateLine(i, "description", e.target.value)} style={inp} /></Field>
              <div style={{ display: "flex", gap: 8 }}>
                <Field label="QTY" half><input type="number" value={li.qty} onChange={e => updateLine(i, "qty", +e.target.value)} style={inp} /></Field>
                <Field label="Unit" half><input value={li.unit} onChange={e => updateLine(i, "unit", e.target.value)} style={inp} /></Field>
              </div>
              <Field label="Unit Price (Excl. VAT)"><input type="number" value={li.unitPrice} onChange={e => updateLine(i, "unitPrice", +e.target.value)} style={inp} /></Field>
              <div style={{ textAlign: "right", fontWeight: 700, color: G, fontSize: 13 }}>= {fmt(li.qty * li.unitPrice)}</div>
            </div>
          ))}
          <button onClick={() => setForm(f => ({ ...f, lineItems: [...f.lineItems, { description: "", qty: 1, unit: "m²", unitPrice: 0 }] }))} style={{ background: G3, border: `1px solid ${GR2}`, borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontSize: 13, color: G, width: "100%", fontWeight: 600, marginBottom: 14 }}>+ Add Line Item</button>
          <div style={{ background: G3, borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}><span>Subtotal (Excl. VAT)</span><b>{fmt(sub(form))}</b></div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}><span>VAT (15%)</span><b>{fmt(sub(form) * 0.15)}</b></div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, color: G, fontWeight: 800, borderTop: `1px solid ${GR2}`, paddingTop: 6 }}><span>TOTAL (Incl. VAT)</span><b>{fmt(sub(form) * 1.15)}</b></div>
          </div>
          <Field label="Notes"><textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3} style={{ ...inp, resize: "vertical" }} /></Field>
        </Modal>
      )}
    </div>
  );
}

function PaymentModal({ doc, total, onClose, onRecord }) {
  const due = total - (doc.amountPaid || 0);
  const [amount, setAmount] = useState(due);
  return (
    <Modal title={`Record Payment — ${doc.number}`} onClose={onClose} onSave={() => onRecord(amount)} saveLabel="Record Payment">
      <div style={{ background: G3, borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 13 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}><span>Invoice Total</span><b>{fmt(total)}</b></div>
        <div style={{ display: "flex", justifyContent: "space-between" }}><span>Already Paid</span><b>{fmt(doc.amountPaid || 0)}</b></div>
        <div style={{ display: "flex", justifyContent: "space-between", color: RD, fontWeight: 800, borderTop: `1px solid ${GR2}`, paddingTop: 4, marginTop: 4 }}><span>Balance Due</span><b>{fmt(due)}</b></div>
      </div>
      <Field label="Payment Amount"><input type="number" value={amount} onChange={e => setAmount(+e.target.value)} style={inp} /></Field>
      {(doc.payments || []).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: GR3, marginBottom: 6 }}>PAYMENT HISTORY</div>
          {doc.payments.map((p, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "4px 0", borderBottom: `1px solid ${GR1}` }}>
              <span>{p.date}</span><b style={{ color: G }}>{fmt(p.amount)}</b>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
// ═══════════════════════════════════════════════════════════════════════════
// PROGRESS PAYMENT CERTIFICATES
// ═══════════════════════════════════════════════════════════════════════════
function ProgressCerts({ ctx }) {
  const { customers, progress, setProgress, showToast, askConfirm } = ctx;
  const [form, setForm] = useState(null);
  const blank = () => ({ id: "", number: `PPC-2026-${String(progress.length + 1).padStart(4, "0")}`, date: toDay(), project: "", clientName: "", contractValue: 0, previousClaimed: 0, thisClaim: 0, retention: 5, status: "Draft" });
  const save = () => { if (!form.clientName) { showToast("Client required", "error"); return; } if (form.id) setProgress(ps => ps.map(p => p.id === form.id ? form : p)); else setProgress(ps => [...ps, { ...form, id: uid() }]); setForm(null); showToast("Certificate saved ✅"); };
  const del = (id) => askConfirm("Delete certificate?", () => { setProgress(ps => ps.filter(p => p.id !== id)); showToast("Deleted"); });
  const net = (p) => { const g = p.thisClaim - p.previousClaimed; return g - (g * p.retention / 100); };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: TX }}>{progress.length} Certificates</span>
        <Btn sm onClick={() => setForm(blank())}>+ New</Btn>
      </div>
      {progress.length === 0 ? <EmptyState icon="📋" title="No certificates yet" subtitle="Create progress payment certificates for ongoing contracts." /> :
        progress.map(p => (
          <Card key={p.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: TX }}>{p.number}</div>
                <div style={{ fontSize: 12, color: GR3 }}>{p.project} · {p.clientName}</div>
                <div style={{ fontSize: 12, color: TX, marginTop: 4 }}>Net Payable: <b style={{ color: G }}>{fmt(net(p) * 1.15)}</b> (incl. VAT)</div>
                <div style={{ marginTop: 6 }}><Tag color={p.status === "Approved" || p.status === "Paid" ? G : AM}>{p.status}</Tag></div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginLeft: 8 }}>
                <Btn sm onClick={() => setForm({ ...p })}>✏ Edit</Btn>
                <Btn sm danger onClick={() => del(p.id)}>🗑 Del</Btn>
              </div>
            </div>
          </Card>
        ))}
      {form && (
        <Modal title="Progress Certificate" onClose={() => setForm(null)} onSave={save}>
          {[["Cert No.", "number"], ["Date", "date", "date"], ["Project Name", "project"], ["Contract Value", "contractValue", "number"], ["Previously Claimed", "previousClaimed", "number"], ["This Claim (cumulative)", "thisClaim", "number"], ["Retention %", "retention", "number"]].map(([l, k, t]) => (
            <Field key={k} label={l}><input type={t || "text"} value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: t === "number" ? +e.target.value : e.target.value }))} style={inp} /></Field>
          ))}
          <Field label="Client"><select value={form.clientName} onChange={e => setForm(f => ({ ...f, clientName: e.target.value }))} style={inp}><option value="">Select</option>{customers.map(c => <option key={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Status"><select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} style={inp}>{["Draft", "Submitted", "Approved", "Paid"].map(s => <option key={s}>{s}</option>)}</select></Field>
          {form.thisClaim > 0 && (
            <div style={{ background: G3, borderRadius: 8, padding: 12, marginTop: 8, fontSize: 13 }}>
              <div>Gross this claim: <b>{fmt(form.thisClaim - form.previousClaimed)}</b></div>
              <div>Retention ({form.retention}%): <b style={{ color: RD }}>-{fmt((form.thisClaim - form.previousClaimed) * form.retention / 100)}</b></div>
              <div style={{ fontWeight: 800, color: G, marginTop: 4 }}>Net + VAT: <b>{fmt(net(form) * 1.15)}</b></div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// BANK STATEMENTS
// ═══════════════════════════════════════════════════════════════════════════
function BankStatements({ ctx }) {
  const { transactions, setTransactions, uploadedPDFs, setUploadedPDFs, showToast, askConfirm } = ctx;
  const [aiRunning, setAiRunning] = useState(false);
  const [editTxn, setEditTxn] = useState(null);
  const [viewPDF, setViewPDF] = useState(null);
  const [filter, setFilter] = useState("all");
  const fileRef = useRef();

  const parseCSV = (text) => {
    const lines = text.trim().split("\n").filter(l => l.trim());
    return lines.slice(1).map(line => {
      const cols = line.split(",").map(c => c.replace(/"/g, "").trim());
      return { id: uid(), date: cols[0] || toDay(), description: cols[1] || "Unknown", debit: parseFloat(cols[2]) || 0, credit: parseFloat(cols[3]) || 0, balance: parseFloat(cols[4]) || 0, category: "Uncategorised", type: "expense", vatApplicable: false };
    }).filter(t => t.description && t.description !== "Unknown");
  };

  const handleFile = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (file.name.toLowerCase().endsWith(".pdf")) {
      setAiRunning(true);
      showToast("📄 AI reading PDF — please wait…");
      try {
        const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = () => rej(new Error("Read failed")); r.readAsDataURL(file); });
        const extracted = await extractPDFTransactions(b64);
        if (!extracted || extracted.length === 0) { showToast("AI could not find transactions in PDF", "error"); setAiRunning(false); e.target.value = ""; return; }
        const newTxns = extracted.map(t => ({ id: uid(), date: t.date || toDay(), description: t.description || "Unknown", debit: parseFloat(t.debit) || 0, credit: parseFloat(t.credit) || 0, balance: parseFloat(t.balance) || 0, category: "Uncategorised", type: (parseFloat(t.credit) || 0) > 0 ? "income" : "expense", vatApplicable: false }));
        setTransactions(ts => [...ts, ...newTxns]);
        const url = URL.createObjectURL(file);
        setUploadedPDFs(prev => [...prev, { name: file.name, url, date: toDay(), count: newTxns.length }]);
        showToast(`✅ Extracted ${newTxns.length} transactions from PDF`);
      } catch (err) { showToast("PDF error: " + err.message, "error"); }
      setAiRunning(false);
    } else if (file.name.toLowerCase().endsWith(".csv")) {
      const text = await file.text();
      const newTxns = parseCSV(text);
      if (!newTxns.length) { showToast("No transactions found in CSV", "error"); e.target.value = ""; return; }
      setTransactions(ts => [...ts, ...newTxns]);
      showToast(`✅ Imported ${newTxns.length} transactions from CSV`);
    } else { showToast("Upload PDF or CSV only", "error"); }
    e.target.value = "";
  };

  const runAI = async () => {
    const unc = transactions.filter(t => t.category === "Uncategorised" || !t.category);
    if (!unc.length) { showToast("All transactions categorised"); return; }
    setAiRunning(true);
    try {
      const cats = await aiCategoriseTransactions(unc);
      setTransactions(ts => ts.map(t => { const idx = unc.findIndex(u => u.id === t.id); return idx === -1 ? t : { ...t, ...cats[idx] }; }));
      showToast(`✅ AI categorised ${cats.length} transactions`);
    } catch (err) { showToast("AI error: " + err.message, "error"); }
    setAiRunning(false);
  };

  const saveTxn = () => { if (!editTxn) return; setTransactions(ts => ts.map(t => t.id === editTxn.id ? editTxn : t)); setEditTxn(null); showToast("Transaction updated ✅"); };
  const delTxn = (id) => askConfirm("Delete this transaction?", () => { setTransactions(ts => ts.filter(t => t.id !== id)); showToast("Deleted"); });

  const filtered = filter === "all" ? transactions : transactions.filter(t => t.type === filter);
  const totalIn = transactions.reduce((s, t) => s + t.credit, 0);
  const totalOut = transactions.reduce((s, t) => s + t.debit, 0);

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
        {[[fmt(totalIn), "Credits", G], [fmt(totalOut), "Debits", RD], [fmt(totalIn - totalOut), "Net", totalIn - totalOut >= 0 ? G : RD]].map(([v, l, c]) => (
          <div key={l} style={{ background: W, borderRadius: 8, padding: "10px 12px", borderLeft: `3px solid ${c}`, textAlign: "center" }}>
            <div style={{ fontSize: 10, color: GR3 }}>{l}</div>
            <div style={{ fontWeight: 800, color: c, fontSize: 14 }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <input ref={fileRef} type="file" accept=".csv,.pdf" style={{ display: "none" }} onChange={handleFile} />
        <Btn sm onClick={() => fileRef.current.click()}>📁 Upload PDF/CSV</Btn>
        <Btn sm onClick={runAI} disabled={aiRunning}>{aiRunning ? "⏳ AI…" : "🤖 AI Categorise"}</Btn>
        <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
          {["all", "income", "expense"].map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{ padding: "6px 12px", borderRadius: 20, border: "none", background: filter === f ? G : GR1, color: filter === f ? W : TX, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{f}</button>
          ))}
        </div>
      </div>

      {uploadedPDFs.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: TX, marginBottom: 8 }}>📂 Uploaded Statements</div>
          {uploadedPDFs.map((pdf, i) => (
            <Card key={i}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 24 }}>📄</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: TX }}>{pdf.name}</div>
                  <div style={{ fontSize: 11, color: GR3 }}>{pdf.date} · {pdf.count} transactions</div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn sm onClick={() => setViewPDF(pdf)}>👁 View</Btn>
                  <a href={pdf.url} download={pdf.name} style={{ textDecoration: "none" }}><Btn sm>⬇</Btn></a>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {filtered.length === 0 ? <EmptyState icon="🏦" title="No transactions yet" subtitle="Upload a bank statement (PDF or CSV) to get started." /> :
        filtered.map(t => (
          <Card key={t.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: TX }}>{t.description}</span>
                  <span style={{ fontWeight: 800, fontSize: 14, color: t.credit > 0 ? G : RD }}>{t.credit > 0 ? `+${fmt(t.credit)}` : `-${fmt(t.debit)}`}</span>
                </div>
                <div style={{ fontSize: 11, color: GR3, marginTop: 2 }}>{t.date} · Bal: {fmt(t.balance)}</div>
                <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <select value={t.category} onChange={e => setTransactions(ts => ts.map(x => x.id === t.id ? { ...x, category: e.target.value } : x))} style={{ border: `1px solid ${GR2}`, borderRadius: 6, padding: "4px 8px", fontSize: 11, background: W, color: TX }}>
                    {TXN_CATS.map(c => <option key={c}>{c}</option>)}
                  </select>
                  <Tag color={t.type === "income" ? G : t.type === "transfer" ? BL : AM}>{t.type}</Tag>
                  <label style={{ fontSize: 11, color: GR3, display: "flex", alignItems: "center", gap: 4 }}>
                    <input type="checkbox" checked={t.vatApplicable} onChange={e => setTransactions(ts => ts.map(x => x.id === t.id ? { ...x, vatApplicable: e.target.checked } : x))} /> VAT
                  </label>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, marginLeft: 8 }}>
                <Btn sm onClick={() => setEditTxn({ ...t })}>✏</Btn>
                <Btn sm danger onClick={() => delTxn(t.id)}>🗑</Btn>
              </div>
            </div>
          </Card>
        ))}

      {editTxn && (
        <Modal title="Edit Transaction" onClose={() => setEditTxn(null)} onSave={saveTxn}>
          {[["Date", "date", "date"], ["Description", "description", "text"], ["Debit", "debit", "number"], ["Credit", "credit", "number"], ["Balance", "balance", "number"]].map(([l, k, t]) => (
            <Field key={k} label={l}><input type={t} value={editTxn[k]} onChange={e => setEditTxn(f => ({ ...f, [k]: t === "number" ? +e.target.value : e.target.value }))} style={inp} /></Field>
          ))}
          <Field label="Category"><select value={editTxn.category} onChange={e => setEditTxn(f => ({ ...f, category: e.target.value }))} style={inp}>{TXN_CATS.map(c => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Type"><select value={editTxn.type} onChange={e => setEditTxn(f => ({ ...f, type: e.target.value }))} style={inp}>{["income", "expense", "transfer", "fee"].map(t => <option key={t}>{t}</option>)}</select></Field>
          <Field label="VAT Applicable"><label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}><input type="checkbox" checked={editTxn.vatApplicable} onChange={e => setEditTxn(f => ({ ...f, vatApplicable: e.target.checked }))} /> Yes, this includes VAT</label></Field>
        </Modal>
      )}

      {viewPDF && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.85)", zIndex: 2000, display: "flex", flexDirection: "column" }}>
          <div style={{ background: DK, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <span style={{ color: W, flex: 1, fontSize: 13, fontWeight: 600 }}>{viewPDF.name}</span>
            <a href={viewPDF.url} download={viewPDF.name} style={{ textDecoration: "none" }}><Btn sm>⬇ Download</Btn></a>
            <Btn sm danger onClick={() => setViewPDF(null)}>✕ Close</Btn>
          </div>
          <iframe src={viewPDF.url} style={{ flex: 1, border: "none" }} title={viewPDF.name} />
        </div>
      )}
      <div style={{ marginTop: 10, fontSize: 11, color: GR3, textAlign: "center" }}>Upload PDF or CSV · AI extracts & categorises · Edit/delete any transaction</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// RECEIPTS (camera + upload + OCR via AI vision)
// ═══════════════════════════════════════════════════════════════════════════
function Receipts({ ctx }) {
  const { receipts, setReceipts, showToast, askConfirm } = ctx;
  const [scanning, setScanning] = useState(false);
  const [viewReceipt, setViewReceipt] = useState(null);
  const [editReceipt, setEditReceipt] = useState(null);
  const [filterCat, setFilterCat] = useState("all");
  const photoRef = useRef();
  const uploadRef = useRef();

  const processFile = async (file) => {
    if (!file) return;
    const isImage = file.type.startsWith("image/");
    const isPDF = file.type === "application/pdf";
    if (!isImage && !isPDF) { showToast("Use a photo (JPG/PNG) or PDF", "error"); return; }
    setScanning(true);
    showToast("🤖 AI scanning receipt…");
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = () => rej(new Error("Read failed")); r.readAsDataURL(file); });
    const previewUrl = URL.createObjectURL(file);
    try {
      const extracted = isPDF ? await scanReceiptPDF(b64) : await scanReceiptImage(b64, file.type || "image/jpeg");
      const newReceipt = { id: uid(), supplier: extracted.supplier || "Unknown", date: extracted.date || toDay(), total: parseFloat(extracted.total) || 0, vatAmount: parseFloat(extracted.vatAmount) || 0, category: extracted.category || "Other Expense", description: extracted.description || "", vatNumber: extracted.vatNumber || "", previewUrl, fileName: file.name, fileType: isImage ? "image" : "pdf", uploadedAt: toDay(), notes: "" };
      setReceipts(rs => [newReceipt, ...rs]);
      showToast(`✅ Receipt scanned: ${newReceipt.supplier} — ${fmt(newReceipt.total)}`);
    } catch (err) {
      setReceipts(rs => [{ id: uid(), supplier: "Unknown", date: toDay(), total: 0, vatAmount: 0, category: "Other Expense", description: "", vatNumber: "", previewUrl, fileName: file.name, fileType: isImage ? "image" : "pdf", uploadedAt: toDay(), notes: "" }, ...rs]);
      showToast("Receipt saved. AI scan failed — please fill in manually.", "error");
    }
    setScanning(false);
  };

  const handleUpload = async (e) => { await processFile(e.target.files[0]); e.target.value = ""; };
  const handlePhoto = async (e) => { await processFile(e.target.files[0]); e.target.value = ""; };
  const saveEdit = () => { setReceipts(rs => rs.map(r => r.id === editReceipt.id ? editReceipt : r)); setEditReceipt(null); showToast("Receipt updated ✅"); };
  const del = (id) => askConfirm("Delete this receipt?", () => { setReceipts(rs => rs.filter(r => r.id !== id)); showToast("Deleted"); });

  const filtered = filterCat === "all" ? receipts : receipts.filter(r => r.category === filterCat);
  const totalSpend = receipts.reduce((s, r) => s + r.total, 0);
  const totalVAT = receipts.reduce((s, r) => s + r.vatAmount, 0);
  const catTotals = {};
  receipts.forEach(r => { catTotals[r.category] = (catTotals[r.category] || 0) + r.total; });
  const topCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
        {[[receipts.length, "Receipts", G], [fmt(totalSpend), "Total Spend", RD], [fmt(totalVAT), "VAT Claimable", AM]].map(([v, l, c]) => (
          <div key={l} style={{ background: W, borderRadius: 8, padding: "10px 12px", borderLeft: `3px solid ${c}`, textAlign: "center" }}>
            <div style={{ fontSize: 10, color: GR3 }}>{l}</div>
            <div style={{ fontWeight: 800, color: c, fontSize: l === "Receipts" ? 20 : 13 }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
        <input ref={photoRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={handlePhoto} />
        <input ref={uploadRef} type="file" accept="image/*,.pdf" style={{ display: "none" }} onChange={handleUpload} />
        <button onClick={() => photoRef.current.click()} disabled={scanning} style={{ background: scanning ? "#ccc" : G, color: W, border: "none", borderRadius: 12, padding: "18px 12px", fontSize: 15, fontWeight: 700, cursor: scanning ? "default" : "pointer", boxShadow: "0 4px 12px rgba(22,128,60,.3)", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 28 }}>📷</span><span>{scanning ? "Scanning…" : "Take Photo"}</span><span style={{ fontSize: 11, opacity: .8 }}>Use camera</span>
        </button>
        <button onClick={() => uploadRef.current.click()} disabled={scanning} style={{ background: scanning ? "#ccc" : BL, color: W, border: "none", borderRadius: 12, padding: "18px 12px", fontSize: 15, fontWeight: 700, cursor: scanning ? "default" : "pointer", boxShadow: "0 4px 12px rgba(29,111,164,.3)", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 28 }}>📁</span><span>{scanning ? "Scanning…" : "Upload"}</span><span style={{ fontSize: 11, opacity: .8 }}>Photo or PDF</span>
        </button>
      </div>
      {scanning && <div style={{ background: G3, border: `1px solid ${G}`, borderRadius: 10, padding: "14px 16px", marginBottom: 14, textAlign: "center", fontSize: 13, color: G, fontWeight: 600 }}>🤖 AI is reading your receipt — extracting supplier, amount, VAT & category…</div>}
      {topCats.length > 0 && (
        <div style={{ background: W, borderRadius: 10, padding: 14, marginBottom: 14, boxShadow: "0 1px 6px rgba(0,0,0,.06)" }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: TX, marginBottom: 10 }}>Spend by Category</div>
          {topCats.map(([cat, amt]) => (
            <div key={cat} style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}><span style={{ color: TX }}>{cat}</span><span style={{ fontWeight: 700, color: RD }}>{fmt(amt)}</span></div>
              <div style={{ height: 5, background: GR1, borderRadius: 3 }}><div style={{ height: 5, background: RD, borderRadius: 3, width: `${(amt / totalSpend) * 100}%` }} /></div>
            </div>
          ))}
        </div>
      )}
      {receipts.length > 0 && (
        <div style={{ marginBottom: 12, overflowX: "auto", display: "flex", gap: 6, paddingBottom: 4 }}>
          <button onClick={() => setFilterCat("all")} style={{ flexShrink: 0, padding: "6px 14px", borderRadius: 20, border: "none", background: filterCat === "all" ? G : GR1, color: filterCat === "all" ? W : TX, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>All ({receipts.length})</button>
          {Object.entries(catTotals).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => (
            <button key={cat} onClick={() => setFilterCat(cat)} style={{ flexShrink: 0, padding: "6px 14px", borderRadius: 20, border: "none", background: filterCat === cat ? G : GR1, color: filterCat === cat ? W : TX, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>{cat.split(" ")[0]} ({receipts.filter(r => r.category === cat).length})</button>
          ))}
        </div>
      )}
      {filtered.length === 0 ? <EmptyState icon="🧾" title="No receipts yet" subtitle="Take a photo or upload a receipt above. AI will extract all details automatically." /> : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {filtered.map(r => (
            <div key={r.id} style={{ background: W, borderRadius: 12, overflow: "hidden", boxShadow: "0 2px 10px rgba(0,0,0,.08)" }}>
              <div onClick={() => setViewReceipt(r)} style={{ height: 110, background: GR1, cursor: "pointer", overflow: "hidden", position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
                {r.fileType === "image" ? <img src={r.previewUrl} alt="receipt" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <div style={{ textAlign: "center", color: GR3 }}><div style={{ fontSize: 36 }}>📄</div><div style={{ fontSize: 11 }}>PDF</div></div>}
                <div style={{ position: "absolute", top: 6, right: 6, background: G, color: W, borderRadius: 12, padding: "2px 8px", fontSize: 10, fontWeight: 700 }}>{r.category.split(" ")[0]}</div>
              </div>
              <div style={{ padding: "10px 10px 8px" }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: TX, marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.supplier}</div>
                <div style={{ fontSize: 11, color: GR3, marginBottom: 4 }}>{r.date}</div>
                <div style={{ fontWeight: 800, color: RD, fontSize: 15, marginBottom: 6 }}>{fmt(r.total)}</div>
                {r.vatAmount > 0 && <div style={{ fontSize: 11, color: AM, marginBottom: 6 }}>VAT: {fmt(r.vatAmount)}</div>}
                <div style={{ display: "flex", gap: 5 }}>
                  <button onClick={() => setViewReceipt(r)} style={{ flex: 1, background: G3, border: "none", borderRadius: 6, padding: "5px 4px", fontSize: 11, color: G, cursor: "pointer", fontWeight: 600 }}>👁 View</button>
                  <button onClick={() => setEditReceipt({ ...r })} style={{ flex: 1, background: GR1, border: "none", borderRadius: 6, padding: "5px 4px", fontSize: 11, color: TX, cursor: "pointer", fontWeight: 600 }}>✏ Edit</button>
                  <button onClick={() => del(r.id)} style={{ background: "#fee", border: "none", borderRadius: 6, padding: "5px 8px", fontSize: 11, color: RD, cursor: "pointer", fontWeight: 600 }}>🗑</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {viewReceipt && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.9)", zIndex: 2000, display: "flex", flexDirection: "column" }}>
          <div style={{ background: DK, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <div style={{ flex: 1 }}><div style={{ color: W, fontWeight: 700, fontSize: 14 }}>{viewReceipt.supplier}</div><div style={{ color: GR3, fontSize: 11 }}>{viewReceipt.date} · {fmt(viewReceipt.total)}</div></div>
            <a href={viewReceipt.previewUrl} download={viewReceipt.fileName || "receipt"} style={{ textDecoration: "none" }}><button style={{ background: G, color: W, border: "none", borderRadius: 8, padding: "7px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>⬇ Download</button></a>
            <button onClick={() => setViewReceipt(null)} style={{ background: RD, color: W, border: "none", borderRadius: 8, padding: "7px 12px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>✕</button>
          </div>
          <div style={{ flex: 1, overflow: "auto", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
            {viewReceipt.fileType === "image" ? <img src={viewReceipt.previewUrl} alt="receipt" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 8, boxShadow: "0 4px 20px rgba(0,0,0,.5)" }} /> : <iframe src={viewReceipt.previewUrl} style={{ width: "100%", height: "100%", border: "none", borderRadius: 8 }} title="receipt-pdf" />}
          </div>
          <div style={{ background: DK, padding: "10px 14px", borderTop: "1px solid rgba(255,255,255,.1)", display: "flex", gap: 16, overflowX: "auto" }}>
            {[["Category", viewReceipt.category], ["Description", viewReceipt.description || "—"], ["VAT", fmt(viewReceipt.vatAmount)], ["VAT No", viewReceipt.vatNumber || "—"]].map(([k, v]) => (
              <div key={k} style={{ flexShrink: 0 }}><div style={{ color: GR3, fontSize: 10 }}>{k}</div><div style={{ color: W, fontSize: 12, fontWeight: 600 }}>{v}</div></div>
            ))}
          </div>
        </div>
      )}
      {editReceipt && (
        <Modal title="Edit Receipt" onClose={() => setEditReceipt(null)} onSave={saveEdit}>
          {editReceipt.previewUrl && (
            <div style={{ marginBottom: 14, textAlign: "center" }}>
              {editReceipt.fileType === "image" ? <img src={editReceipt.previewUrl} alt="receipt" style={{ maxHeight: 140, maxWidth: "100%", borderRadius: 8, boxShadow: "0 2px 8px rgba(0,0,0,.15)" }} /> : <div style={{ background: GR1, borderRadius: 8, padding: 20, color: GR3, fontSize: 13 }}>📄 PDF Receipt</div>}
            </div>
          )}
          <Field label="Supplier / Store"><input value={editReceipt.supplier} onChange={e => setEditReceipt(r => ({ ...r, supplier: e.target.value }))} style={inp} /></Field>
          <Field label="Date"><input type="date" value={editReceipt.date} onChange={e => setEditReceipt(r => ({ ...r, date: e.target.value }))} style={inp} /></Field>
          <Field label="Total Amount (Incl. VAT)"><input type="number" value={editReceipt.total} onChange={e => setEditReceipt(r => ({ ...r, total: +e.target.value }))} style={inp} /></Field>
          <Field label="VAT Amount"><input type="number" value={editReceipt.vatAmount} onChange={e => setEditReceipt(r => ({ ...r, vatAmount: +e.target.value }))} style={inp} /></Field>
          <Field label="Category"><select value={editReceipt.category} onChange={e => setEditReceipt(r => ({ ...r, category: e.target.value }))} style={inp}>{RECEIPT_CATS.map(c => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Description"><input value={editReceipt.description} onChange={e => setEditReceipt(r => ({ ...r, description: e.target.value }))} style={inp} /></Field>
          <Field label="Supplier VAT Number"><input value={editReceipt.vatNumber} onChange={e => setEditReceipt(r => ({ ...r, vatNumber: e.target.value }))} style={inp} /></Field>
        </Modal>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PROJECT COSTING
// ═══════════════════════════════════════════════════════════════════════════
function ProjectCosting({ ctx }) {
  const { customers, projects, setProjects, showToast, askConfirm } = ctx;
  const [form, setForm] = useState(null);
  const blank = () => ({ id: "", name: "", clientName: "", startDate: toDay(), endDate: "", contractValue: 0, budgetMaterials: 0, budgetLabour: 0, budgetOther: 0, actualMaterials: 0, actualLabour: 0, actualOther: 0, status: "Active" });
  const save = () => { if (!form.name) { showToast("Name required", "error"); return; } if (form.id) setProjects(ps => ps.map(p => p.id === form.id ? form : p)); else setProjects(ps => [...ps, { ...form, id: uid() }]); setForm(null); showToast("Project saved ✅"); };
  const del = (id) => askConfirm("Delete project?", () => { setProjects(ps => ps.filter(p => p.id !== id)); showToast("Deleted"); });
  const profit = p => p.contractValue - p.actualMaterials - p.actualLabour - p.actualOther;
  const margin = p => p.contractValue > 0 ? ((profit(p) / p.contractValue) * 100).toFixed(1) : 0;
  const budgetUsed = p => { const b = p.budgetMaterials + p.budgetLabour + p.budgetOther; const a = p.actualMaterials + p.actualLabour + p.actualOther; return b > 0 ? ((a / b) * 100).toFixed(0) : 0; };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: TX }}>{projects.length} Projects</span>
        <Btn sm onClick={() => setForm(blank())}>+ New</Btn>
      </div>
      {projects.length === 0 ? <EmptyState icon="🏗" title="No projects yet" subtitle="Track project costing, budgets and profitability here." /> :
        projects.map(p => {
          const used = budgetUsed(p);
          return (
            <Card key={p.id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: TX }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: GR3 }}>{p.clientName} · {p.startDate}</div>
                  <div style={{ fontSize: 13, marginTop: 6, display: "flex", gap: 12, flexWrap: "wrap" }}>
                    <span>Contract: <b style={{ color: G }}>{fmt(p.contractValue)}</b></span>
                    <span>Profit: <b style={{ color: profit(p) >= 0 ? G : RD }}>{fmt(profit(p))}</b></span>
                    <span>Margin: <b style={{ color: +margin(p) >= 20 ? G : +margin(p) >= 10 ? AM : RD }}>{margin(p)}%</b></span>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: GR3, marginBottom: 3 }}><span>Budget used</span><span>{used}%</span></div>
                    <div style={{ height: 5, background: GR1, borderRadius: 3 }}><div style={{ height: 5, background: used > 100 ? RD : used > 80 ? AM : G, borderRadius: 3, width: `${Math.min(used, 100)}%` }} /></div>
                  </div>
                  <div style={{ marginTop: 6 }}><Tag color={p.status === "Active" ? G : p.status === "Complete" ? BL : AM}>{p.status}</Tag></div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5, marginLeft: 8 }}>
                  <Btn sm onClick={() => setForm({ ...p })}>✏ Edit</Btn>
                  <Btn sm danger onClick={() => del(p.id)}>🗑 Del</Btn>
                </div>
              </div>
            </Card>
          );
        })}
      {form && (
        <Modal title="Project Costing" onClose={() => setForm(null)} onSave={save}>
          <Field label="Project Name *"><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inp} /></Field>
          <Field label="Client"><select value={form.clientName} onChange={e => setForm(f => ({ ...f, clientName: e.target.value }))} style={inp}><option value="">Select</option>{customers.map(c => <option key={c.id}>{c.name}</option>)}</select></Field>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0 4%" }}>
            {[["Start Date", "startDate", "date"], ["End Date", "endDate", "date"], ["Contract Value", "contractValue", "number"], ["Budget: Materials", "budgetMaterials", "number"], ["Budget: Labour", "budgetLabour", "number"], ["Budget: Other", "budgetOther", "number"], ["Actual: Materials", "actualMaterials", "number"], ["Actual: Labour", "actualLabour", "number"], ["Actual: Other", "actualOther", "number"]].map(([l, k, t]) => (
              <Field key={k} label={l} half><input type={t} value={form[k]} onChange={e => setForm(f => ({ ...f, [k]: t === "number" ? +e.target.value : e.target.value }))} style={inp} /></Field>
            ))}
          </div>
          <Field label="Status"><select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))} style={inp}>{["Active", "On Hold", "Complete", "Cancelled"].map(s => <option key={s}>{s}</option>)}</select></Field>
          {form.contractValue > 0 && <div style={{ background: G3, borderRadius: 8, padding: 12, marginTop: 8, fontSize: 13 }}>
            <div>Budget: {fmt(form.budgetMaterials + form.budgetLabour + form.budgetOther)}</div>
            <div>Actual: {fmt(form.actualMaterials + form.actualLabour + form.actualOther)}</div>
            <div style={{ fontWeight: 800, color: profit(form) >= 0 ? G : RD, marginTop: 4 }}>Profit: {fmt(profit(form))} ({margin(form)}%)</div>
          </div>}
        </Modal>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DEBTORS / CREDITORS
// ═══════════════════════════════════════════════════════════════════════════
function DebtorsCreditors({ ctx }) {
  const { customers, invoices, transactions } = ctx;
  const debtors = customers.filter(c => c.type === "Client").map(c => {
    const custInvoices = invoices.filter(i => i.clientName === c.name && i.status !== "Paid");
    const outstanding = custInvoices.reduce((s, i) => s + (i.lineItems.reduce((ss, l) => ss + l.qty * l.unitPrice, 0) * 1.15 - (i.amountPaid || 0)), 0);
    return { ...c, outstanding, count: custInvoices.length };
  }).filter(c => c.outstanding > 0);
  const creditors = customers.filter(c => c.type !== "Client").map(c => ({ ...c, spent: transactions.filter(t => t.description.toLowerCase().includes(c.name.slice(0, 5).toLowerCase())).reduce((s, t) => s + t.debit, 0) }));

  return (
    <div>
      <div style={{ fontWeight: 700, fontSize: 14, color: RD, marginBottom: 10 }}>📥 Debtors (Owed to You)</div>
      {debtors.length === 0 ? <Card><div style={{ color: GR3, textAlign: "center", padding: 8 }}>No outstanding debtors 🎉</div></Card> :
        debtors.map(d => <Card key={d.id}><div style={{ display: "flex", justifyContent: "space-between" }}><div><div style={{ fontWeight: 700, color: TX }}>{d.name}</div><div style={{ fontSize: 12, color: GR3 }}>{d.contact} · {d.count} invoice(s)</div></div><div style={{ fontWeight: 800, color: RD, fontSize: 15 }}>{fmt(d.outstanding)}</div></div></Card>)}
      <div style={{ textAlign: "right", fontWeight: 700, color: RD, marginBottom: 16, fontSize: 14 }}>Total: {fmt(debtors.reduce((s, d) => s + d.outstanding, 0))}</div>
      <div style={{ fontWeight: 700, fontSize: 14, color: AM, marginBottom: 10 }}>📤 Creditors (You Owe)</div>
      {creditors.length === 0 ? <Card><div style={{ color: GR3, textAlign: "center", padding: 8 }}>No suppliers added yet</div></Card> :
        creditors.map(c => <Card key={c.id}><div style={{ display: "flex", justifyContent: "space-between" }}><div><div style={{ fontWeight: 700, color: TX }}>{c.name}</div><Tag color={AM}>{c.type}</Tag></div><div style={{ fontWeight: 700, color: AM, fontSize: 14 }}>{fmt(c.spent)}</div></div></Card>)}
    </div>
  );
}
// ═══════════════════════════════════════════════════════════════════════════
// VAT REPORT
// ═══════════════════════════════════════════════════════════════════════════
function VATReport({ ctx }) {
  const { transactions } = ctx;
  const outVAT = transactions.filter(t => t.credit > 0 && t.vatApplicable).reduce((s, t) => s + t.credit * VAT_RATE / (1 + VAT_RATE), 0);
  const inVAT = transactions.filter(t => t.debit > 0 && t.vatApplicable).reduce((s, t) => s + t.debit * VAT_RATE / (1 + VAT_RATE), 0);
  const payable = outVAT - inVAT;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        {[[fmt(outVAT), "Output VAT", G], [fmt(inVAT), "Input VAT", BL], [fmt(Math.abs(payable)), payable >= 0 ? "Payable to SARS" : "Refund Due", payable >= 0 ? RD : G]].map(([v, l, c]) => (
          <div key={l} style={{ background: W, borderRadius: 10, padding: "14px 16px", borderLeft: `4px solid ${c}`, gridColumn: l.includes("Payable") || l.includes("Refund") ? "1 / -1" : "auto" }}>
            <div style={{ fontSize: 11, color: GR3 }}>{l}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: c }}>{v}</div>
          </div>
        ))}
      </div>
      <Card>
        <div style={{ fontWeight: 700, marginBottom: 10, color: TX }}>VAT Transactions</div>
        {transactions.filter(t => t.vatApplicable).length === 0 ? <div style={{ color: GR3, fontSize: 13, textAlign: "center", padding: 12 }}>No VAT transactions yet</div> :
          transactions.filter(t => t.vatApplicable).map(t => {
            const net = t.debit > 0 ? t.debit / 1.15 : t.credit / 1.15;
            const vat = t.debit > 0 ? t.debit - net : t.credit - net;
            return <div key={t.id} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: `1px solid ${GR1}`, fontSize: 12 }}>
              <div><div style={{ fontWeight: 600 }}>{t.description}</div><div style={{ color: GR3 }}>{t.date}</div></div>
              <div style={{ textAlign: "right" }}><div style={{ color: GR3 }}>Excl: {fmt(net)}</div><div style={{ fontWeight: 700, color: G }}>VAT: {fmt(vat)}</div></div>
            </div>;
          })}
      </Card>
      <div style={{ marginTop: 12, background: payable >= 0 ? "#fff5f5" : "#f0fff5", border: `2px solid ${payable >= 0 ? RD : G}`, borderRadius: 10, padding: 14, textAlign: "center" }}>
        <div style={{ fontWeight: 800, color: payable >= 0 ? RD : G, fontSize: 15 }}>{payable >= 0 ? `⚠️ Pay SARS: ${fmt(payable)}` : `✅ SARS Refund: ${fmt(Math.abs(payable))}`}</div>
        <div style={{ fontSize: 11, color: GR3, marginTop: 4 }}>South African VAT at 15% · Tick "VAT" on transactions to include</div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PROFIT & LOSS
// ═══════════════════════════════════════════════════════════════════════════
function ProfitLoss({ ctx }) {
  const { transactions } = ctx;
  const income = transactions.reduce((s, t) => s + t.credit, 0);
  const expenses = transactions.reduce((s, t) => s + t.debit, 0);
  const net = income - expenses;
  const expCats = {}, incCats = {};
  transactions.filter(t => t.debit > 0).forEach(t => { expCats[t.category] = (expCats[t.category] || 0) + t.debit; });
  transactions.filter(t => t.credit > 0).forEach(t => { incCats[t.category] = (incCats[t.category] || 0) + t.credit; });

  return (
    <div>
      <div style={{ background: net >= 0 ? G3 : "#ffe5e5", border: `2px solid ${net >= 0 ? G : RD}`, borderRadius: 12, padding: "16px 20px", marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div><div style={{ fontSize: 11, color: GR3 }}>Net Profit / Loss</div><div style={{ fontSize: 28, fontWeight: 900, color: net >= 0 ? G : RD }}>{fmt(net)}</div></div>
        <div style={{ textAlign: "right", fontSize: 11, color: GR3 }}><div>Margin: {income > 0 ? ((net / income) * 100).toFixed(1) : 0}%</div></div>
      </div>
      <Card>
        <div style={{ fontWeight: 700, color: G, marginBottom: 10 }}>Income</div>
        {Object.entries(incCats).length === 0 ? <div style={{ color: GR3, fontSize: 13 }}>No income recorded</div> :
          Object.entries(incCats).map(([c, v]) => <div key={c} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "5px 0", borderBottom: `1px solid ${GR1}` }}><span>{c}</span><b style={{ color: G }}>{fmt(v)}</b></div>)}
        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800, color: G, fontSize: 14, borderTop: `2px solid ${G}`, paddingTop: 6, marginTop: 6 }}><span>Total Income</span><span>{fmt(income)}</span></div>
      </Card>
      <Card>
        <div style={{ fontWeight: 700, color: RD, marginBottom: 10 }}>Expenses</div>
        {Object.entries(expCats).length === 0 ? <div style={{ color: GR3, fontSize: 13 }}>No expenses recorded</div> :
          Object.entries(expCats).map(([c, v]) => <div key={c} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "5px 0", borderBottom: `1px solid ${GR1}` }}><span>{c}</span><b style={{ color: RD }}>{fmt(v)}</b></div>)}
        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 800, color: RD, fontSize: 14, borderTop: `2px solid ${RD}`, paddingTop: 6, marginTop: 6 }}><span>Total Expenses</span><span>{fmt(expenses)}</span></div>
      </Card>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CASH FLOW
// ═══════════════════════════════════════════════════════════════════════════
function CashFlow({ ctx }) {
  const { transactions } = ctx;
  const byMonth = {};
  transactions.forEach(t => { const m = t.date.slice(0, 7); if (!byMonth[m]) byMonth[m] = { in: 0, out: 0 }; byMonth[m].in += t.credit; byMonth[m].out += t.debit; });
  const periods = Object.entries(byMonth).sort();
  let running = 0;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
        {[[fmt(transactions.reduce((s, t) => s + t.credit, 0)), "Inflows", G], [fmt(transactions.reduce((s, t) => s + t.debit, 0)), "Outflows", RD], [fmt(transactions.reduce((s, t) => s + t.credit - t.debit, 0)), "Balance", BL]].map(([v, l, c]) => (
          <div key={l} style={{ background: W, borderRadius: 8, padding: "10px 12px", borderLeft: `3px solid ${c}`, textAlign: "center" }}>
            <div style={{ fontSize: 10, color: GR3 }}>{l}</div>
            <div style={{ fontWeight: 800, color: c, fontSize: 14 }}>{v}</div>
          </div>
        ))}
      </div>
      {periods.length === 0 ? <EmptyState icon="💰" title="No cash flow data" subtitle="Upload bank statements to see your cash flow by period." /> :
        periods.map(([period, d]) => {
          const net = d.in - d.out; running += net;
          return <Card key={period}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 700, color: TX }}>{period}</span>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12 }}><span style={{ color: G }}>+{fmt(d.in)}</span> / <span style={{ color: RD }}>-{fmt(d.out)}</span></div>
                <div style={{ fontWeight: 800, color: net >= 0 ? G : RD, fontSize: 14 }}>Net: {fmt(net)}</div>
                <div style={{ fontSize: 11, color: GR3 }}>Balance: {fmt(running)}</div>
              </div>
            </div>
          </Card>;
        })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// AI ACCOUNTANT — chat assistant
// ═══════════════════════════════════════════════════════════════════════════
function AIAccountant({ ctx }) {
  const { transactions, invoices, quotations, customers, receipts, projects } = ctx;
  const [messages, setMessages] = useState([
    { role: "assistant", text: "Hi! I'm your AI Accountant. Ask me anything about your finances — VAT calculations, profit & loss, outstanding invoices, or general SA accounting questions." }
  ]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef();

  useEffect(() => { scrollRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, thinking]);

  const buildContext = () => {
    const income = transactions.reduce((s, t) => s + t.credit, 0);
    const expenses = transactions.reduce((s, t) => s + t.debit, 0);
    const outVAT = transactions.filter(t => t.credit > 0 && t.vatApplicable).reduce((s, t) => s + t.credit * VAT_RATE / (1 + VAT_RATE), 0);
    const inVAT = transactions.filter(t => t.debit > 0 && t.vatApplicable).reduce((s, t) => s + t.debit * VAT_RATE / (1 + VAT_RATE), 0);
    const outstandingInvoices = invoices.filter(i => i.status !== "Paid").map(i => ({ number: i.number, client: i.clientName, total: i.lineItems.reduce((s, l) => s + l.qty * l.unitPrice, 0) * 1.15, paid: i.amountPaid || 0 }));
    return {
      totalIncome: income, totalExpenses: expenses, netProfit: income - expenses,
      outputVAT: outVAT, inputVAT: inVAT, vatPayable: outVAT - inVAT,
      numCustomers: customers.length, numQuotations: quotations.length, numInvoices: invoices.length,
      outstandingInvoices, numReceipts: receipts.length, totalReceiptSpend: receipts.reduce((s, r) => s + r.total, 0),
      activeProjects: projects.filter(p => p.status === "Active").map(p => ({ name: p.name, contractValue: p.contractValue, profit: p.contractValue - p.actualMaterials - p.actualLabour - p.actualOther })),
      currentDate: toDay(),
    };
  };

  const send = async () => {
    if (!input.trim() || thinking) return;
    const q = input.trim();
    setMessages(m => [...m, { role: "user", text: q }]);
    setInput("");
    setThinking(true);
    try {
      const answer = await askAIAccountant(q, buildContext());
      setMessages(m => [...m, { role: "assistant", text: answer || "Sorry, I couldn't process that. Please try again." }]);
    } catch (err) {
      setMessages(m => [...m, { role: "assistant", text: "Sorry, something went wrong reaching the AI service. Please try again." }]);
    }
    setThinking(false);
  };

  const quickQuestions = ["What's my VAT position?", "How is my profit margin?", "Which invoices are overdue?", "Explain VAT on imports"];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 200px)" }}>
      <div style={{ flex: 1, overflowY: "auto", marginBottom: 10 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 10 }}>
            <div style={{
              maxWidth: "82%", padding: "10px 14px", borderRadius: m.role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
              background: m.role === "user" ? G : W, color: m.role === "user" ? W : TX,
              fontSize: 13.5, lineHeight: 1.55, boxShadow: m.role === "assistant" ? "0 1px 6px rgba(0,0,0,.06)" : "none",
              border: m.role === "assistant" ? `1px solid ${GR1}` : "none", whiteSpace: "pre-wrap",
            }}>
              {m.role === "assistant" && <div style={{ fontSize: 10, fontWeight: 700, color: G, marginBottom: 4 }}>🤖 AI ACCOUNTANT</div>}
              {m.text}
            </div>
          </div>
        ))}
        {thinking && (
          <div style={{ display: "flex", justifyContent: "flex-start", marginBottom: 10 }}>
            <div style={{ padding: "10px 14px", borderRadius: "14px 14px 14px 4px", background: W, border: `1px solid ${GR1}`, fontSize: 13, color: GR3 }}>🤖 Thinking…</div>
          </div>
        )}
        <div ref={scrollRef} />
      </div>
      {messages.length === 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {quickQuestions.map(q => (
            <button key={q} onClick={() => { setInput(q); }} style={{ background: G3, border: `1px solid ${GR2}`, borderRadius: 16, padding: "6px 12px", fontSize: 11.5, color: G, cursor: "pointer", fontWeight: 600 }}>{q}</button>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && send()} placeholder="Ask about VAT, profit, invoices…" style={{ ...inp, flex: 1 }} disabled={thinking} />
        <Btn onClick={send} disabled={thinking || !input.trim()}>➤</Btn>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════
function Dashboard({ ctx, setPage }) {
  const { transactions, invoices, customers } = ctx;
  const income = transactions.reduce((s, t) => s + t.credit, 0);
  const expenses = transactions.reduce((s, t) => s + t.debit, 0);
  const outVAT = transactions.filter(t => t.credit > 0 && t.vatApplicable).reduce((s, t) => s + t.credit * VAT_RATE / (1 + VAT_RATE), 0);
  const inVAT = transactions.filter(t => t.debit > 0 && t.vatApplicable).reduce((s, t) => s + t.debit * VAT_RATE / (1 + VAT_RATE), 0);
  const vatPosition = outVAT - inVAT;
  const outstanding = invoices.filter(i => i.status !== "Paid").reduce((s, i) => s + (i.lineItems.reduce((ss, l) => ss + l.qty * l.unitPrice, 0) * 1.15 - (i.amountPaid || 0)), 0);

  const cats = {};
  transactions.filter(t => t.debit > 0).forEach(t => { cats[t.category] = (cats[t.category] || 0) + t.debit; });
  const top = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxC = top[0]?.[1] || 1;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        {[[fmt(income), "Income", G, "↑"], [fmt(expenses), "Expenses", RD, "↓"],
          [fmt(income - expenses), "Net Profit", income - expenses >= 0 ? G : RD, "="],
          [fmt(Math.abs(vatPosition)), vatPosition >= 0 ? "VAT Owed" : "VAT Refund", AM, "%"],
          [fmt(outstanding), "Outstanding", BL, "📄"],
          [customers.length, "Customers", DK, "👥"]].map(([v, l, c]) => (
          <div key={l} style={{ background: W, borderRadius: 10, padding: "12px 14px", borderLeft: `4px solid ${c}`, boxShadow: "0 1px 6px rgba(0,0,0,.06)" }}>
            <div style={{ fontSize: 10, color: GR3, marginBottom: 4 }}>{l}</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: c }}>{v}</div>
          </div>
        ))}
      </div>
      {top.length > 0 && (
        <Card>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12, color: TX }}>Top Expense Categories</div>
          {top.map(([cat, amt]) => (
            <div key={cat} style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}><span style={{ color: TX }}>{cat}</span><span style={{ fontWeight: 600, color: G }}>{fmt(amt)}</span></div>
              <div style={{ height: 5, background: GR1, borderRadius: 3 }}><div style={{ height: 5, background: G, borderRadius: 3, width: `${(amt / maxC) * 100}%` }} /></div>
            </div>
          ))}
        </Card>
      )}
      <Card>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, color: TX }}>Recent Transactions</div>
        {transactions.length === 0 ? <div style={{ color: GR3, fontSize: 13 }}>No transactions yet</div> :
          transactions.slice(-5).reverse().map(t => (
            <div key={t.id} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: `1px solid ${GR1}` }}>
              <div><div style={{ fontSize: 13, fontWeight: 600, color: TX }}>{t.description}</div><div style={{ fontSize: 11, color: GR3 }}>{t.date} · {t.category}</div></div>
              <div style={{ fontWeight: 700, color: t.credit > 0 ? G : RD, fontSize: 13 }}>{t.credit > 0 ? `+${fmt(t.credit)}` : `-${fmt(t.debit)}`}</div>
            </div>
          ))}
      </Card>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 4 }}>
        {[["📄 New Quote", "quotations"], ["🧾 New Invoice", "invoices"], ["🏦 Bank", "bank"], ["🤖 Ask AI", "ai"]].map(([l, p]) => (
          <button key={p} onClick={() => setPage(p)} style={{ background: W, border: `1px solid ${GR2}`, borderRadius: 10, padding: "14px 10px", fontSize: 13, fontWeight: 600, color: G, cursor: "pointer" }}>{l}</button>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════
const NAV = [
  { id: "dashboard", label: "Dashboard", icon: "⊞" },
  { id: "customers", label: "Customers", icon: "👥" },
  { id: "quotations", label: "Quotations", icon: "📄" },
  { id: "invoices", label: "Invoices", icon: "🧾" },
  { id: "progress", label: "Prog. Certs", icon: "📋" },
  { id: "bank", label: "Bank", icon: "🏦" },
  { id: "receipts", label: "Receipts", icon: "🧾📷" },
  { id: "projects", label: "Projects", icon: "🏗" },
  { id: "debtors", label: "Debtors", icon: "⚖" },
  { id: "vat", label: "VAT", icon: "🔢" },
  { id: "pl", label: "P&L", icon: "📈" },
  { id: "cashflow", label: "Cash Flow", icon: "💰" },
  { id: "ai", label: "AI Accountant", icon: "🤖" },
];

// ═══════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════
export default function App() {
  const [authScreen, setAuthScreen] = useState("signin"); // signin | register | forgot
  const [users, setUsers] = useState(seedUsers);
  const [user, setUser] = useState(null);
  const [page, setPage] = useState("dashboard");
  const [navOpen, setNavOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const [customers, setCustomers] = useState(DEMO_CUSTOMERS);
  const [quotations, setQuotations] = useState(DEMO_QUOTES);
  const [invoices, setInvoices] = useState([]);
  const [progress, setProgress] = useState([]);
  const [transactions, setTransactions] = useState(DEMO_TXN);
  const [projects, setProjects] = useState([]);
  const [uploadedPDFs, setUploadedPDFs] = useState([]);
  const [receipts, setReceipts] = useState([]);

  const showToast = (msg, type = "success") => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };
  const askConfirm = (msg, onYes) => setConfirm({ msg, onYes });

  if (!user) {
    if (authScreen === "register") return <Register users={users} onRegister={(u) => { setUsers(us => [...us, u]); setUser(u); }} goSignIn={() => setAuthScreen("signin")} />;
    if (authScreen === "forgot") return <ForgotPassword users={users} goSignIn={() => setAuthScreen("signin")} />;
    return <SignIn users={users} onLogin={setUser} goRegister={() => setAuthScreen("register")} goForgot={() => setAuthScreen("forgot")} />;
  }

  const ctx = {
    customers, setCustomers, quotations, setQuotations, invoices, setInvoices,
    progress, setProgress, transactions, setTransactions, projects, setProjects,
    uploadedPDFs, setUploadedPDFs, receipts, setReceipts, showToast, askConfirm, setPage,
  };

  const currentNav = NAV.find(n => n.id === page);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: OFF, fontFamily: "'Segoe UI', system-ui, sans-serif", overflow: "hidden" }}>
      <div style={{ background: G, padding: "0 14px", height: 54, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, boxShadow: "0 2px 8px rgba(0,0,0,.2)" }}>
        <button onClick={() => setNavOpen(o => !o)} style={{ background: "none", border: "none", color: W, fontSize: 22, cursor: "pointer", padding: 4 }}>☰</button>
        <div style={{ color: W, fontWeight: 800, fontSize: 15, letterSpacing: 1 }}>DINAMONT BOOKS</div>
        <button onClick={() => setUser(null)} style={{ background: "rgba(255,255,255,.15)", border: "none", color: W, borderRadius: 8, padding: "5px 10px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>Sign Out</button>
      </div>

      <div style={{ background: W, borderBottom: `1px solid ${GR1}`, padding: "10px 16px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <span style={{ fontSize: 18 }}>{currentNav?.icon}</span>
        <span style={{ fontWeight: 700, fontSize: 15, color: TX }}>{currentNav?.label}</span>
        <div style={{ marginLeft: "auto", fontSize: 11, color: GR3 }}>👤 {user.name}</div>
      </div>

      {navOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 900 }} onClick={() => setNavOpen(false)}>
          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 250, background: DK, boxShadow: "4px 0 20px rgba(0,0,0,.4)", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: "16px 18px", borderBottom: "1px solid rgba(255,255,255,.1)" }}>
              <div style={{ color: W, fontWeight: 800, fontSize: 16, letterSpacing: 1 }}>DINAMONT BOOKS</div>
              <div style={{ color: GR3, fontSize: 11, marginTop: 2 }}>{user.name} · {user.role}</div>
              <div style={{ color: GR3, fontSize: 10 }}>{user.company}</div>
            </div>
            {NAV.map(n => (
              <button key={n.id} onClick={() => { setPage(n.id); setNavOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "13px 18px", background: page === n.id ? G : "none", border: "none", cursor: "pointer", color: page === n.id ? W : GR3, textAlign: "left", fontSize: 14 }}>
                <span style={{ fontSize: 18 }}>{n.icon}</span>{n.label}
              </button>
            ))}
            <div style={{ padding: "12px 18px", borderTop: "1px solid rgba(255,255,255,.1)" }}>
              <button onClick={() => { setUser(null); setNavOpen(false); }} style={{ background: RD, border: "none", color: W, borderRadius: 8, padding: "8px 16px", width: "100%", cursor: "pointer", fontWeight: 600, fontSize: 13 }}>🚪 Sign Out</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: "14px 12px" }}>
        {page === "dashboard" && <Dashboard ctx={ctx} setPage={setPage} />}
        {page === "customers" && <Customers ctx={ctx} />}
        {page === "quotations" && <Documents ctx={ctx} type="Quotation" />}
        {page === "invoices" && <Documents ctx={ctx} type="Invoice" />}
        {page === "progress" && <ProgressCerts ctx={ctx} />}
        {page === "bank" && <BankStatements ctx={ctx} />}
        {page === "receipts" && <Receipts ctx={ctx} />}
        {page === "projects" && <ProjectCosting ctx={ctx} />}
        {page === "debtors" && <DebtorsCreditors ctx={ctx} />}
        {page === "vat" && <VATReport ctx={ctx} />}
        {page === "pl" && <ProfitLoss ctx={ctx} />}
        {page === "cashflow" && <CashFlow ctx={ctx} />}
        {page === "ai" && <AIAccountant ctx={ctx} />}
      </div>

      {toast && <div style={{ position: "fixed", bottom: 20, left: 12, right: 12, background: toast.type === "success" ? G : RD, color: W, padding: "12px 16px", borderRadius: 10, fontSize: 14, fontWeight: 600, zIndex: 9999, textAlign: "center", boxShadow: "0 4px 20px rgba(0,0,0,.3)" }}>{toast.msg}</div>}
      {confirm && <Confirm msg={confirm.msg} onYes={() => { confirm.onYes(); setConfirm(null); }} onNo={() => setConfirm(null)} />}
    </div>
  );
}
