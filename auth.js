/**
 * TopFlowNG — Authentication Middleware & Routes
 *
 * Exports:
 *   router    — Express router with /register and /login
 *   protect   — JWT middleware; attaches req.user on valid token
 */

const express  = require("express");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const { stmt } = require("./database");

const router = express.Router();
const JWT_SECRET  = process.env.JWT_SECRET || "change_this_in_production";
const JWT_EXPIRES = "30d"; // tokens last 30 days

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════

function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function safeUser(user) {
  if (!user) return null;
  const { password_hash, ...safe } = user;
  return safe;
}

// Validate Nigerian phone number (08xxxxxxxxx or +2348xxxxxxxxx)
function isValidPhone(phone) {
  return /^(0|\+?234)[789]\d{9}$/.test(phone.replace(/\s/g, ""));
}

function normalisePhone(phone) {
  const p = phone.replace(/\s/g, "");
  if (p.startsWith("+234")) return "0" + p.slice(4);
  if (p.startsWith("234"))  return "0" + p.slice(3);
  return p;
}

// ═══════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════

/**
 * POST /api/auth/register
 * Body: { first_name, last_name, email, phone, password }
 */
router.post("/register", async (req, res) => {
  try {
    const { first_name, last_name, email, phone, password } = req.body;

    // ── Validation ──
    if (!first_name || !last_name || !email || !phone || !password) {
      return res.status(400).json({ success: false, message: "All fields are required" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: "Invalid email address" });
    }
    if (!isValidPhone(phone)) {
      return res.status(400).json({ success: false, message: "Enter a valid Nigerian phone number" });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
    }

    const normPhone = normalisePhone(phone);

    // ── Duplicate checks ──
    if (stmt.userByEmail.get(email)) {
      return res.status(409).json({ success: false, message: "An account with this email already exists" });
    }
    if (stmt.userByPhone.get(normPhone)) {
      return res.status(409).json({ success: false, message: "An account with this phone number already exists" });
    }

    // ── Create user ──
    const id            = uuidv4();
    const password_hash = await bcrypt.hash(password, 12);

    stmt.createUser.run({ id, first_name, last_name, email: email.toLowerCase(), phone: normPhone, password_hash });

    const user  = stmt.userById.get(id);
    const token = signToken(id);

    return res.status(201).json({
      success: true,
      message: "Account created successfully",
      token,
      user: safeUser(user),
    });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ success: false, message: "Registration failed. Please try again." });
  }
});

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }

    const user = stmt.userByEmail.get(email.toLowerCase());
    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    const token = signToken(user.id);

    return res.json({
      success: true,
      message: "Login successful",
      token,
      user: safeUser(user),
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ success: false, message: "Login failed. Please try again." });
  }
});

/**
 * GET /api/auth/me
 * Returns current user profile + wallet balance
 */
router.get("/me", protect, (req, res) => {
  const user = stmt.userById.get(req.user.id);
  if (!user) return res.status(404).json({ success: false, message: "User not found" });
  res.json({ success: true, user: safeUser(user) });
});

// ═══════════════════════════════════════════════
// PROTECT MIDDLEWARE
// Attach to any route that requires login:
//   router.get('/api/wallet', protect, handler)
// ═══════════════════════════════════════════════
function protect(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "Not authenticated. Please log in." });
  }

  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user    = stmt.userById.get(decoded.sub);
    if (!user) {
      return res.status(401).json({ success: false, message: "Account not found." });
    }
    req.user = user; // full user row available in handlers
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, message: "Session expired. Please log in again." });
    }
    return res.status(401).json({ success: false, message: "Invalid token." });
  }
}

module.exports = { router, protect };
