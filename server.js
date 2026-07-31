/**
 * TopFlowNG — Production Backend
 *
 * ── Quick start ──────────────────────────────────
 *  1. npm install
 *  2. cp .env.example .env  →  fill in your keys
 *  3. Whitelist your server IP in Clubkonnect dashboard
 *  4. Set Paystack webhook URL to: https://topflowng.com/api/paystack/webhook
 *  5. npm run dev   (development)
 *     npm start     (production)
 * ─────────────────────────────────────────────────
 */

require("dotenv").config();
const express      = require("express");
const axios        = require("axios");
const crypto       = require("crypto");
const { v4: uuidv4 } = require("uuid");
const rateLimit    = require("express-rate-limit");
const helmet       = require("helmet");
const cors         = require("cors");
const path         = require("path");

// ── Internal modules ──
const { stmt, creditWallet, debitWallet, refundWallet } = require("./database");
const { router: authRouter, protect } = require("./auth");

const app  = express();
const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════
const CK = {
  USER_ID: process.env.CLUBKONNECT_USER_ID,
  API_KEY: process.env.CLUBKONNECT_API_KEY,
  BASE:    process.env.CLUBKONNECT_BASE_URL || "https://www.clubkonnect.com",
};

const PS = {
  SECRET: process.env.PAYSTACK_SECRET_KEY,
  BASE:   "https://api.paystack.co",
};

const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// ── Lookup tables ────────────────────────────────
const NETWORK = { mtn: "01", airtel: "02", glo: "03", "9mobile": "04" };
const DISCO   = {
  ekedc: "EKEDC", ikedc: "IKEDC", phed: "PHED",
  bedc:  "BEDC",  aedc:  "AEDC",  jed:  "JED",
  kedco: "KEDCO", eedc:  "EEDC",
};
const CABLETV = { dstv: "DSTV", gotv: "GOTV", startimes: "STARTIMES" };
const BETTING = {
  bet9ja: "BET9JA", sportybet: "SPORTYBET", betking: "BETKING",
  "1xbet": "1XBET", nairabet: "NAIRABET", bangbet: "BANGBET",
};

// ═══════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════

// Webhook needs raw body for HMAC check — register BEFORE express.json()
app.use("/api/paystack/webhook", express.raw({ type: "application/json" }));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.NODE_ENV === "production"
    ? ["https://topflowng.com", "https://www.topflowng.com"]
    : "*",
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// ── Rate limiting ────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  message: { success: false, message: "Too many requests." },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,   // 10 attempts per 15 min for login/register
  message: { success: false, message: "Too many attempts. Please wait." },
});

app.use("/api/", apiLimiter);
app.use("/api/auth/", authLimiter);

// ═══════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════
app.use("/api/auth", authRouter);

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════

async function ckGet(endpoint, params = {}) {
  const res = await axios.get(`${CK.BASE}/${endpoint}`, {
    params: { UserID: CK.USER_ID, APIKey: CK.API_KEY, ...params },
    timeout: 30000,
  });
  return res.data;
}

async function paystackReq(method, endpoint, data = {}) {
  const res = await axios({
    method, url: `${PS.BASE}${endpoint}`,
    headers: { Authorization: `Bearer ${PS.SECRET}` },
    data, timeout: 30000,
  });
  return res.data;
}

const reqID = () => `TFN-${Date.now()}-${uuidv4().split("-")[0].toUpperCase()}`;

function apiErr(res, status, message, details = null) {
  return res.status(status).json({ success: false, message, ...(details && { details }) });
}

// ═══════════════════════════════════════════════
// WALLET ROUTES
// ═══════════════════════════════════════════════

/** GET /api/wallet — current user's balance + last 30 transactions */
app.get("/api/wallet", protect, (req, res) => {
  const user = stmt.userById.get(req.user.id);
  const txns = stmt.txnsByUser.all(req.user.id);
  res.json({
    success: true,
    data: {
      balance:      user.wallet_balance,
      transactions: txns,
    },
  });
});

// ═══════════════════════════════════════════════
// PAYSTACK — WALLET FUNDING
// ═══════════════════════════════════════════════

/**
 * POST /api/paystack/initialize
 * Body: { amount }  (Naira, min 100)
 * Protected — user must be logged in
 */
app.post("/api/paystack/initialize", protect, async (req, res) => {
  const { amount } = req.body;
  const user = req.user;

  if (!amount || amount < 100) {
    return apiErr(res, 400, "Minimum funding amount is ₦100");
  }

  try {
    const reference = `TFN-FUND-${uuidv4()}`;

    // Record the pending Paystack reference
    stmt.insertPsRef.run({
      reference,
      user_id:      user.id,
      amount_naira: Number(amount),
    });

    const data = await paystackReq("POST", "/transaction/initialize", {
      email:        user.email,
      amount:       Math.round(Number(amount) * 100), // kobo
      reference,
      callback_url: `${APP_URL}/api/paystack/callback`,
      metadata: {
        userId: user.id,
        userName: `${user.first_name} ${user.last_name}`,
        cancel_action: APP_URL,
        custom_fields: [
          { display_name: "Platform",  variable_name: "platform",  value: "TopFlowNG" },
          { display_name: "User ID",   variable_name: "user_id",   value: user.id },
        ],
      },
    });

    res.json({
      success:          true,
      authorizationUrl: data.data.authorization_url,
      reference,
    });
  } catch (err) {
    console.error("Paystack init error:", err?.response?.data || err.message);
    apiErr(res, 500, "Could not open payment page. Please try again.", err?.response?.data);
  }
});

/**
 * GET /api/paystack/callback
 * Paystack redirects here after payment. Verify, credit wallet, redirect to dashboard.
 */
app.get("/api/paystack/callback", async (req, res) => {
  const { reference } = req.query;
  if (!reference) return res.redirect("/?error=no_reference");

  try {
    // Check if already processed (idempotency)
    const psRef = stmt.psRefByRef.get(reference);
    if (psRef && psRef.status === "completed") {
      return res.redirect("/?already=true");
    }

    const data = await paystackReq("GET", `/transaction/verify/${reference}`);

    if (data.data.status === "success") {
      const amountNaira = data.data.amount / 100;
      const userId      = data.data.metadata?.userId;

      if (userId) {
        creditWallet(userId, amountNaira, `Wallet funded via card (${reference})`, {
          service: "wallet_funding", reference, providerData: { source: "paystack_callback" },
        });
        stmt.completePsRef.run(reference);
      }
      return res.redirect(`/?funded=true&amount=${amountNaira}`);
    } else {
      return res.redirect("/?error=payment_failed");
    }
  } catch (err) {
    console.error("Paystack callback error:", err?.response?.data || err.message);
    return res.redirect("/?error=verification_failed");
  }
});

/**
 * POST /api/paystack/webhook
 * Server-to-server confirmation (most reliable). HMAC verified.
 */
app.post("/api/paystack/webhook", (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_WEBHOOK_SECRET || PS.SECRET)
    .update(req.body)
    .digest("hex");

  if (hash !== signature) {
    console.warn("Webhook: invalid signature");
    return res.status(401).send("Invalid signature");
  }

  res.sendStatus(200); // Always reply 200 fast

  const event = JSON.parse(req.body.toString());
  if (event.event === "charge.success") {
    const { amount, reference, metadata } = event.data;
    const amountNaira = amount / 100;
    const userId      = metadata?.userId;

    if (!userId) return;

    // Idempotency: skip if already processed via callback
    const psRef = stmt.psRefByRef.get(reference);
    if (psRef?.status === "completed") return;

    try {
      creditWallet(userId, amountNaira, `Wallet funded via bank transfer (${reference})`, {
        service: "wallet_funding", reference, providerData: { source: "paystack_webhook" },
      });
      stmt.completePsRef.run(reference);
      console.log(`✓ Webhook: ₦${amountNaira} credited to ${userId}`);
    } catch (e) {
      console.error("Webhook credit error:", e.message);
    }
  }
});

// ═══════════════════════════════════════════════
// VTU SERVICE ROUTES  (all protected)
// ═══════════════════════════════════════════════

/** POST /api/services/airtime */
app.post("/api/services/airtime", protect, async (req, res) => {
  const { network, phone, amount } = req.body;
  const userId = req.user.id;

  if (!network || !phone || !amount) return apiErr(res, 400, "network, phone, and amount are required");
  const netCode = NETWORK[network.toLowerCase()];
  if (!netCode) return apiErr(res, 400, `Unknown network`);
  if (amount < 50 || amount > 50000) return apiErr(res, 400, "Amount must be ₦50–₦50,000");

  const requestID = reqID();
  try {
    debitWallet(userId, Number(amount), `${network.toUpperCase()} ₦${amount} airtime → ${phone}`, { service: "airtime", reference: requestID });
  } catch (e) {
    return apiErr(res, 402, e.message);
  }

  try {
    const data = await ckGet("APIGetAirTimeV1.asp", {
      MobileNetwork: netCode, Amount: amount, MobileNumber: phone,
      RequestID: requestID, CallbackURL: `${APP_URL}/api/callbacks/ck`,
    });

    if (data.Status && data.Status !== "Order Successful") {
      refundWallet(userId, Number(amount), `Refund: airtime to ${phone} failed`);
      return apiErr(res, 502, data.Status || "Provider error", data);
    }

    res.json({ success: true, message: `₦${amount} airtime sent to ${phone}`, requestId: requestID });
  } catch (err) {
    refundWallet(userId, Number(amount), `Refund: airtime to ${phone} (network error)`);
    console.error("Airtime error:", err?.response?.data || err.message);
    apiErr(res, 500, "Airtime failed. Wallet refunded.", err.message);
  }
});

/** POST /api/services/data */
app.post("/api/services/data", protect, async (req, res) => {
  const { network, plan, phone, amount } = req.body;
  const userId = req.user.id;

  if (!network || !plan || !phone || !amount) return apiErr(res, 400, "network, plan, phone, amount required");
  const netCode = NETWORK[network.toLowerCase()];
  if (!netCode) return apiErr(res, 400, "Unknown network");

  const requestID = reqID();
  try {
    debitWallet(userId, Number(amount), `${network.toUpperCase()} ${plan} data → ${phone}`, { service: "data", reference: requestID });
  } catch (e) {
    return apiErr(res, 402, e.message);
  }

  try {
    const data = await ckGet("APIGetDataBundleV1.asp", {
      MobileNetwork: netCode, DataPlan: plan, MobileNumber: phone,
      RequestID: requestID, CallbackURL: `${APP_URL}/api/callbacks/ck`,
    });

    if (data.Status && data.Status !== "Order Successful") {
      refundWallet(userId, Number(amount), `Refund: data to ${phone} failed`);
      return apiErr(res, 502, data.Status || "Provider error", data);
    }

    res.json({ success: true, message: `${plan} data activated on ${phone}`, requestId: requestID });
  } catch (err) {
    refundWallet(userId, Number(amount), `Refund: data to ${phone} (error)`);
    apiErr(res, 500, "Data purchase failed. Wallet refunded.", err.message);
  }
});

/** POST /api/services/electricity/verify */
app.post("/api/services/electricity/verify", protect, async (req, res) => {
  const { disco, meterNumber, meterType = "Prepaid" } = req.body;
  if (!disco || !meterNumber) return apiErr(res, 400, "disco and meterNumber required");
  const discoCode = DISCO[disco.toLowerCase()];
  if (!discoCode) return apiErr(res, 400, `Unknown DISCO`);

  try {
    const data = await ckGet("APIVerifyMeterV1.asp", {
      MeterNo: meterNumber, DiscoName: discoCode, MeterType: meterType,
    });
    res.json({ success: true, data });
  } catch (err) {
    apiErr(res, 500, "Meter verification failed", err.message);
  }
});

/** POST /api/services/electricity */
app.post("/api/services/electricity", protect, async (req, res) => {
  const { disco, meterNumber, meterType = "Prepaid", amount } = req.body;
  const userId = req.user.id;

  if (!disco || !meterNumber || !amount) return apiErr(res, 400, "disco, meterNumber, amount required");
  if (amount < 1000) return apiErr(res, 400, "Minimum ₦1,000");
  const discoCode = DISCO[disco.toLowerCase()];
  if (!discoCode) return apiErr(res, 400, "Unknown DISCO");

  const requestID = reqID();
  try {
    debitWallet(userId, Number(amount), `${disco.toUpperCase()} token — meter ${meterNumber}`, { service: "electricity", reference: requestID });
  } catch (e) {
    return apiErr(res, 402, e.message);
  }

  try {
    const data = await ckGet("APIGetElectricityV1.asp", {
      MeterNo: meterNumber, DiscoName: discoCode, MeterType: meterType,
      Amount: amount, RequestID: requestID, CallbackURL: `${APP_URL}/api/callbacks/ck`,
    });

    if (data.Status && data.Status !== "Order Successful") {
      refundWallet(userId, Number(amount), `Refund: electricity token failed`);
      return apiErr(res, 502, data.Status || "Provider error", data);
    }

    res.json({
      success: true,
      message: `Token delivered to meter ${meterNumber}`,
      token:   data.Token || data.MainToken || "Check your SMS",
      requestId: requestID,
    });
  } catch (err) {
    refundWallet(userId, Number(amount), `Refund: electricity ${meterNumber} (error)`);
    apiErr(res, 500, "Electricity purchase failed. Wallet refunded.", err.message);
  }
});

/** POST /api/services/cable/verify */
app.post("/api/services/cable/verify", protect, async (req, res) => {
  const { provider, smartCardNo } = req.body;
  if (!provider || !smartCardNo) return apiErr(res, 400, "provider and smartCardNo required");
  const provCode = CABLETV[provider.toLowerCase()];
  if (!provCode) return apiErr(res, 400, "Unknown provider");

  try {
    const data = await ckGet("APIVerifyCableTVV1.asp", { CableTV: provCode, SmartCardNo: smartCardNo });
    res.json({ success: true, data });
  } catch (err) {
    apiErr(res, 500, "Smart card verification failed", err.message);
  }
});

/** POST /api/services/cable */
app.post("/api/services/cable", protect, async (req, res) => {
  const { provider, smartCardNo, package: pkg, amount } = req.body;
  const userId = req.user.id;

  if (!provider || !smartCardNo || !pkg || !amount) return apiErr(res, 400, "All cable fields required");
  const provCode = CABLETV[provider.toLowerCase()];
  if (!provCode) return apiErr(res, 400, "Unknown provider");

  const requestID = reqID();
  try {
    debitWallet(userId, Number(amount), `${provider.toUpperCase()} ${pkg} — card ${smartCardNo}`, { service: "cable", reference: requestID });
  } catch (e) {
    return apiErr(res, 402, e.message);
  }

  try {
    const data = await ckGet("APIGetCableTVV1.asp", {
      CableTV: provCode, Package: pkg, SmartCardNo: smartCardNo,
      RequestID: requestID, CallbackURL: `${APP_URL}/api/callbacks/ck`,
    });

    if (data.Status && data.Status !== "Order Successful") {
      refundWallet(userId, Number(amount), `Refund: cable TV sub failed`);
      return apiErr(res, 502, data.Status || "Provider error", data);
    }

    res.json({ success: true, message: `${pkg} subscription renewed`, requestId: requestID });
  } catch (err) {
    refundWallet(userId, Number(amount), `Refund: cable TV (error)`);
    apiErr(res, 500, "Cable TV failed. Wallet refunded.", err.message);
  }
});

/** POST /api/services/betting */
app.post("/api/services/betting", protect, async (req, res) => {
  const { company, customerId, amount } = req.body;
  const userId = req.user.id;

  if (!company || !customerId || !amount) return apiErr(res, 400, "company, customerId, amount required");
  if (amount < 100) return apiErr(res, 400, "Minimum ₦100");
  const compCode = BETTING[company.toLowerCase()];
  if (!compCode) return apiErr(res, 400, "Unknown betting company");

  const requestID = reqID();
  try {
    debitWallet(userId, Number(amount), `${company.toUpperCase()} wallet → ${customerId}`, { service: "betting", reference: requestID });
  } catch (e) {
    return apiErr(res, 402, e.message);
  }

  try {
    const data = await ckGet("APIGetBettingV1.asp", {
      BettingCompany: compCode, CustomerID: customerId,
      Amount: amount, RequestID: requestID, CallbackURL: `${APP_URL}/api/callbacks/ck`,
    });

    if (data.Status && data.Status !== "Order Successful") {
      refundWallet(userId, Number(amount), `Refund: betting wallet failed`);
      return apiErr(res, 502, data.Status || "Provider error", data);
    }

    res.json({ success: true, message: `₦${amount} funded to ${company} wallet`, requestId: requestID });
  } catch (err) {
    refundWallet(userId, Number(amount), `Refund: betting to ${customerId} (error)`);
    apiErr(res, 500, "Betting funding failed. Wallet refunded.", err.message);
  }
});

/** POST /api/services/waec */
app.post("/api/services/waec", protect, async (req, res) => {
  const { quantity = 1 } = req.body;
  const userId   = req.user.id;
  const PRICE    = 3500;
  const total    = PRICE * Number(quantity);
  const requestID = reqID();

  try {
    debitWallet(userId, total, `WAEC e-PIN × ${quantity}`, { service: "waec", reference: requestID });
  } catch (e) {
    return apiErr(res, 402, e.message);
  }

  try {
    const data = await ckGet("APIGetWAECV1.asp", {
      Quantity: quantity, RequestID: requestID, CallbackURL: `${APP_URL}/api/callbacks/ck`,
    });

    if (data.Status && data.Status !== "Order Successful") {
      refundWallet(userId, total, `Refund: WAEC PIN failed`);
      return apiErr(res, 502, data.Status || "Provider error", data);
    }

    res.json({ success: true, pins: data.Pins || data, requestId: requestID });
  } catch (err) {
    refundWallet(userId, total, `Refund: WAEC (error)`);
    apiErr(res, 500, "WAEC PIN failed. Wallet refunded.", err.message);
  }
});

// ═══════════════════════════════════════════════
// CLUBKONNECT DELIVERY CALLBACK
// ═══════════════════════════════════════════════
app.post("/api/callbacks/ck", (req, res) => {
  console.log("CK Callback:", JSON.stringify(req.body, null, 2));
  // TODO: update DB order status and push notification to user
  res.sendStatus(200);
});

// ═══════════════════════════════════════════════
// SERVE FRONTEND
// ═══════════════════════════════════════════════
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "topflowng.html")));
app.use((req, res) => res.status(404).json({ success: false, message: "Not found" }));
app.use((err, req, res, next) => {
  console.error("Unhandled:", err);
  res.status(500).json({ success: false, message: "Server error" });
});

// ═══════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════
app.listen(PORT, () => {
  const ckReady = CK.USER_ID && CK.API_KEY ? "✓ Configured" : "✗ Set CLUBKONNECT_USER_ID + API_KEY";
  const psReady = PS.SECRET              ? "✓ Configured" : "✗ Set PAYSTACK_SECRET_KEY";
  console.log(`
╔══════════════════════════════════════════════════╗
║           TopFlowNG — Server Ready               ║
╠══════════════════════════════════════════════════╣
║  URL:         http://localhost:${PORT}               ║
║  DB:          topflowng.db (SQLite/WAL)           ║
║  Clubkonnect: ${ckReady.padEnd(36)} ║
║  Paystack:    ${psReady.padEnd(36)} ║
╚══════════════════════════════════════════════════╝
  `);
});

module.exports = app;
