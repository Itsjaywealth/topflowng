/**
 * TopFlowNG — Production Backend
 *
 * Stack: Express · PostgreSQL · JWT · Paystack · Clubkonnect VTU
 * Security: Helmet · express-rate-limit · CORS · Sentry
 */

'use strict';

// ── Sentry (must be first) ──────────────────────────────────────────────────
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.2,
  });
}

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const crypto       = require('crypto');
const jwt          = require('jsonwebtoken');
const axios        = require('axios');
require('dotenv').config();

const db = require('./database');

const app  = express();
app.set('trust proxy', 1); // Trust Railway's load balancer for accurate rate limiting
const PORT = process.env.PORT || 3000;

// ── Security Middleware ──────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // disabled so inline scripts in HTML still work
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: process.env.APP_URL || '*',
  credentials: true,
}));

// ── Rate Limiters ────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many attempts, please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  message: { error: 'Too many requests, slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Raw body for Paystack webhook signature verification
app.use('/api/paystack/webhook', express.raw({ type: 'application/json' }));

// JSON body for everything else
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// ── JWT Auth Middleware ──────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Health Check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { fullName, email, phone, password } = req.body;
    if (!fullName || !email || !phone || !password)
      return res.status(400).json({ error: 'All fields are required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = await db.findUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const existingPhone = await db.findUserByPhone(phone);
    if (existingPhone) return res.status(409).json({ error: 'Phone already registered' });

    const user  = await db.createUser({ fullName, email, phone, password });
    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id: user.id, fullName: user.full_name, email: user.email, phone: user.phone, wallet: parseFloat(user.wallet) } });
  } catch (err) {
    console.error('Register error:', err.message);
    if (err.code === '23505') return res.status(409).json({ error: 'Email or phone already registered' });
    Sentry.captureException(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });

    const user = await db.findUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await db.verifyPassword(user, password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, fullName: user.full_name, email: user.email, phone: user.phone, wallet: parseFloat(user.wallet) } });
  } catch (err) {
    console.error('Login error:', err.message);
    Sentry.captureException(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── User Profile & Wallet ────────────────────────────────────────────────────
app.get('/api/user/profile', authMiddleware, async (req, res) => {
  try {
    const user = await db.findUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, fullName: user.full_name, email: user.email, phone: user.phone, wallet: parseFloat(user.wallet) });
  } catch (err) {
    Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

app.get('/api/wallet/balance', authMiddleware, async (req, res) => {
  try {
    const balance = await db.getWalletBalance(req.user.id);
    res.json({ balance });
  } catch (err) {
    Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

app.get('/api/wallet/transactions', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const txns  = await db.getTransactions(req.user.id, limit);
    res.json({ transactions: txns });
  } catch (err) {
    Sentry.captureException(err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// ── Paystack Payment Initialisation ─────────────────────────────────────────
app.post('/api/paystack/initialize', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { amount } = req.body; // amount in Naira
    if (!amount || amount < 100) return res.status(400).json({ error: 'Minimum top-up is ₦100' });

    const user     = await db.findUserById(req.user.id);
    const amountKobo = Math.round(parseFloat(amount) * 100);
    const reference  = `TF-${Date.now()}-${req.user.id}`;

    const response = await axios.post('https://api.paystack.co/transaction/initialize', {
      email:     user.email,
      amount:    amountKobo,
      reference,
      callback_url: `${process.env.APP_URL}/dashboard`,
      metadata: { user_id: req.user.id, user_email: user.email },
    }, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    });

    res.json({ authorization_url: response.data.data.authorization_url, reference });
  } catch (err) {
    console.error('Paystack init error:', err.response?.data || err.message);
    Sentry.captureException(err);
    res.status(500).json({ error: 'Payment initialization failed' });
  }
});

// ── Paystack Webhook ─────────────────────────────────────────────────────────
app.post('/api/paystack/webhook', async (req, res) => {
  try {
    const secret    = process.env.PAYSTACK_WEBHOOK_SECRET || process.env.PAYSTACK_SECRET_KEY;
    const signature = req.headers['x-paystack-signature'];
    const hash      = crypto.createHmac('sha512', secret).update(req.body).digest('hex');

    if (hash !== signature) {
      console.warn('Invalid Paystack webhook signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(req.body.toString());

    if (event.event === 'charge.success') {
      const { reference, amount, metadata } = event.data;
      const userId  = metadata?.user_id;
      const naira   = amount / 100;

      if (!userId) return res.sendStatus(200);

      const alreadyProcessed = await db.paystackRefExists(reference);
      if (alreadyProcessed) return res.sendStatus(200);

      await db.savePaystackRef(reference, userId, naira);
      await db.creditWallet(userId, naira, `Wallet top-up via Paystack`, reference);
      console.log(`Wallet credited: user ${userId} +₦${naira} [${reference}]`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err.message);
    Sentry.captureException(err);
    res.sendStatus(500);
  }
});

// ── VTU — Airtime ────────────────────────────────────────────────────────────
app.post('/api/vtu/airtime', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { network, phone, amount } = req.body;
    if (!network || !phone || !amount) return res.status(400).json({ error: 'network, phone, amount required' });

    const cost    = parseFloat(amount);
    const balance = await db.getWalletBalance(req.user.id);
    if (balance < cost) return res.status(402).json({ error: 'Insufficient wallet balance' });

    const networkMap = { MTN: 'MTN', GLO: 'GLO', AIRTEL: 'AIRTEL', '9MOBILE': '9MOBILE', ETISALAT: '9MOBILE' };
    const ckNetwork  = networkMap[network.toUpperCase()] || network.toUpperCase();

    const params = {
      UserID:  process.env.CLUBKONNECT_USER_ID,
      APIKey:  process.env.CLUBKONNECT_API_KEY,
      MobileNetwork: ckNetwork,
      Amount:  cost,
      MobileNumber: phone,
      RequestID: `AIR-${Date.now()}`,
      CallBackURL: '',
    };

    const ckRes = await axios.get(`${process.env.CLUBKONNECT_BASE_URL}/API/Airtime/`, { params });
    const data  = ckRes.data;

    if (data.status === '200' || data.Status === 'Successful') {
      await db.debitWallet(req.user.id, cost, `Airtime recharge — ${network} ${phone}`, params.RequestID);
      res.json({ success: true, message: `₦${cost} ${network} airtime sent to ${phone}` });
    } else {
      await db.logFailedTransaction(req.user.id, `Failed airtime — ${network} ${phone}`, cost);
      res.status(400).json({ error: data.message || data.Message || 'Airtime purchase failed' });
    }
  } catch (err) {
    console.error('Airtime error:', err.message);
    Sentry.captureException(err);
    res.status(500).json({ error: 'Airtime service unavailable' });
  }
});

// ── VTU — Data Bundle ────────────────────────────────────────────────────────
app.post('/api/vtu/data', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { network, phone, planCode, amount } = req.body;
    if (!network || !phone || !planCode || !amount) return res.status(400).json({ error: 'network, phone, planCode, amount required' });

    const cost    = parseFloat(amount);
    const balance = await db.getWalletBalance(req.user.id);
    if (balance < cost) return res.status(402).json({ error: 'Insufficient wallet balance' });

    const params = {
      UserID:  process.env.CLUBKONNECT_USER_ID,
      APIKey:  process.env.CLUBKONNECT_API_KEY,
      MobileNetwork: network.toUpperCase(),
      DataPlan: planCode,
      MobileNumber: phone,
      RequestID: `DATA-${Date.now()}`,
      CallBackURL: '',
    };

    const ckRes = await axios.get(`${process.env.CLUBKONNECT_BASE_URL}/API/Databundle/`, { params });
    const data  = ckRes.data;

    if (data.status === '200' || data.Status === 'Successful') {
      await db.debitWallet(req.user.id, cost, `Data bundle — ${network} ${planCode}`, params.RequestID);
      res.json({ success: true, message: `Data bundle activated for ${phone}` });
    } else {
      await db.logFailedTransaction(req.user.id, `Failed data — ${network} ${phone}`, cost);
      res.status(400).json({ error: data.message || data.Message || 'Data purchase failed' });
    }
  } catch (err) {
    console.error('Data error:', err.message);
    Sentry.captureException(err);
    res.status(500).json({ error: 'Data service unavailable' });
  }
});

// ── VTU — Cable TV ───────────────────────────────────────────────────────────
app.post('/api/vtu/cable', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { provider, smartCardNumber, planCode, amount } = req.body;
    if (!provider || !smartCardNumber || !planCode || !amount) return res.status(400).json({ error: 'provider, smartCardNumber, planCode, amount required' });

    const cost    = parseFloat(amount);
    const balance = await db.getWalletBalance(req.user.id);
    if (balance < cost) return res.status(402).json({ error: 'Insufficient wallet balance' });

    const params = {
      UserID:  process.env.CLUBKONNECT_USER_ID,
      APIKey:  process.env.CLUBKONNECT_API_KEY,
      CableTV: provider.toUpperCase(),
      Package: planCode,
      SmartCardNo: smartCardNumber,
      RequestID: `CABLE-${Date.now()}`,
      CallBackURL: '',
    };

    const ckRes = await axios.get(`${process.env.CLUBKONNECT_BASE_URL}/API/CableTV/`, { params });
    const data  = ckRes.data;

    if (data.status === '200' || data.Status === 'Successful') {
      await db.debitWallet(req.user.id, cost, `${provider} subscription — ${smartCardNumber}`, params.RequestID);
      res.json({ success: true, message: `${provider} subscription activated` });
    } else {
      await db.logFailedTransaction(req.user.id, `Failed cable — ${provider}`, cost);
      res.status(400).json({ error: data.message || data.Message || 'Cable TV subscription failed' });
    }
  } catch (err) {
    console.error('Cable TV error:', err.message);
    Sentry.captureException(err);
    res.status(500).json({ error: 'Cable TV service unavailable' });
  }
});

// ── VTU — Electricity ────────────────────────────────────────────────────────
app.post('/api/vtu/electricity', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { disco, meterNumber, meterType, amount } = req.body;
    if (!disco || !meterNumber || !meterType || !amount) return res.status(400).json({ error: 'disco, meterNumber, meterType, amount required' });

    const cost    = parseFloat(amount);
    const balance = await db.getWalletBalance(req.user.id);
    if (balance < cost) return res.status(402).json({ error: 'Insufficient wallet balance' });

    const params = {
      UserID:  process.env.CLUBKONNECT_USER_ID,
      APIKey:  process.env.CLUBKONNECT_API_KEY,
      ElectricCompany: disco.toUpperCase(),
      MeterType: meterType.toUpperCase(),
      MeterNumber: meterNumber,
      Amount: cost,
      RequestID: `ELEC-${Date.now()}`,
      CallBackURL: '',
    };

    const ckRes = await axios.get(`${process.env.CLUBKONNECT_BASE_URL}/API/Electricity/`, { params });
    const data  = ckRes.data;

    if (data.status === '200' || data.Status === 'Successful') {
      await db.debitWallet(req.user.id, cost, `Electricity — ${disco} ${meterNumber}`, params.RequestID);
      res.json({ success: true, message: `Electricity token sent`, token: data.token || data.Token || '' });
    } else {
      await db.logFailedTransaction(req.user.id, `Failed electricity — ${disco}`, cost);
      res.status(400).json({ error: data.message || data.Message || 'Electricity payment failed' });
    }
  } catch (err) {
    console.error('Electricity error:', err.message);
    Sentry.captureException(err);
    res.status(500).json({ error: 'Electricity service unavailable' });
  }
});

// ── SPA Fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'topflowng.html'));
});

// ── Sentry Error Handler ─────────────────────────────────────────────────────
if (process.env.SENTRY_DSN) {
  app.use(Sentry.Handlers.errorHandler());
}

// ── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start Server ─────────────────────────────────────────────────────────────
async function start() {
  await db.initDB();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TopFlowNG running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
