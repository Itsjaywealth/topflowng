/**
 * TopFlowNG — Request validation schemas (Zod).
 *
 * Every public API route validates its input against one of these schemas.
 * The `validate(schema)` middleware returns 400 with a clear message on
 * the first validation error, never exposing internal schema details.
 */

'use strict';

const { z } = require('zod');
const { isValidPhone, normalizeEmail } = require('./validate');

const phoneSchema = z.string().refine(isValidPhone, { message: 'Enter a valid phone number' });
const emailSchema = z.string().trim().min(1, 'Email is required').email('Enter a valid email address').transform(normalizeEmail);
const passwordSchema = z.string().min(6, 'Password must be at least 6 characters');
const pinSchema = z.string().regex(/^\d{4,6}$/, 'PIN must be 4-6 digits.');
const amountSchema = z.number().positive('Amount must be positive').finite();

const registerSchema = z.object({
  fullName: z.string().trim().min(1, 'Full name is required'),
  email: emailSchema,
  phone: phoneSchema,
  password: passwordSchema,
  referralCode: z.string().trim().optional(),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string({ message: 'Email and password required' }).min(1, 'Email and password required'),
});

const forgotPasswordSchema = z.object({
  email: emailSchema,
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  password: passwordSchema,
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: passwordSchema,
});

const setPinSchema = z.object({
  pin: pinSchema,
});

const resetPinSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPin: pinSchema,
});

const verifyPinSchema = z.object({
  pin: pinSchema,
});

const paystackInitSchema = z.object({
  amount: z.number().min(100, 'Minimum top-up is ₦100').finite(),
});

const beneficiaryAddSchema = z.object({
  type: z.enum(['airtime', 'data', 'electricity', 'cable']),
  label: z.string().trim().min(1, 'Label is required'),
  network: z.string().optional(),
  identifier: z.string().trim().min(1, 'Identifier is required'),
});

const vtuPurchaseSchema = z.object({
  pin: z.union([pinSchema, z.null()]).optional(),
});

const airtimeSchema = vtuPurchaseSchema.extend({
  network: z.string().trim().min(1, 'Network is required'),
  phone: phoneSchema,
  amount: z.number().positive('Amount must be positive').finite(),
});

const dataSchema = vtuPurchaseSchema.extend({
  network: z.string().trim().min(1, 'Network is required'),
  phone: phoneSchema,
  planCode: z.string().trim().min(1, 'Plan code is required'),
  amount: z.number().positive('Amount must be positive').finite(),
});

const cableSchema = vtuPurchaseSchema.extend({
  provider: z.string().trim().min(1, 'Provider is required'),
  smartCardNumber: z.string().trim().min(1, 'Smart card number is required'),
  planCode: z.string().trim().min(1, 'Plan code is required'),
  amount: z.number().positive().finite(),
});

const electricitySchema = vtuPurchaseSchema.extend({
  disco: z.string().trim().min(1, 'Disco is required'),
  meterNumber: z.string().trim().min(1, 'Meter number is required'),
  meterType: z.enum(['prepaid', 'postpaid']),
  amount: z.number().positive().finite(),
});

const examPinSchema = vtuPurchaseSchema.extend({
  examBody: z.string().trim().min(1, 'Exam body is required'),
  // JAMB variations: 'utme-mock' (with mock, ₦7,700) | 'utme-no-mock' (without mock, ₦6,200)
  examVariation: z.string().trim().optional(),
  quantity: z.number({ message: 'Quantity is required' }).int().positive().max(10, 'Max 10 pins at a time').optional().default(1),
});

const rechargePinSchema = vtuPurchaseSchema.extend({
  network: z.string().trim().min(1, 'Network is required'),
  amount: z.number().positive().finite(),
  quantity: z.number({ message: 'Quantity is required' }).int().positive().max(5, 'Max 5 pins at a time').optional().default(1),
});

const autoRechargeSchema = z.object({
  threshold: z.coerce.number().min(100, 'Threshold must be at least ₦100').max(1_000_000).finite(),
  amount: z.coerce.number().min(100, 'Amount must be at least ₦100').max(1_000_000, 'Amount cannot exceed ₦1,000,000').finite(),
});

const scheduledPurchaseSchema = z.object({
  serviceType: z.enum(['airtime', 'data', 'cable', 'electricity'], {
    message: 'serviceType must be airtime, data, cable or electricity',
  }),
  planCode: z.string().trim().min(1).max(64).optional().nullable(),
  phone: z.string().trim().max(20).optional().nullable(),
  identifier: z.string().trim().max(64).optional().nullable(),
  network: z.string().trim().max(32).optional().nullable(),
  amount: z.coerce.number().positive('Amount must be positive').max(1_000_000).finite(),
  frequency: z.enum(['once', 'daily', 'weekly', 'monthly'], {
    message: 'frequency must be once, daily, weekly or monthly',
  }),
  nextRunAt: z.coerce.date({ message: 'nextRunAt must be a valid date' }),
}).superRefine((value, ctx) => {
  if (value.serviceType === 'airtime' && value.amount < 50) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['amount'],
      message: 'Airtime amount must be at least ₦50',
    });
  }
  if (value.serviceType === 'electricity' && value.amount < 500) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['amount'],
      message: 'Electricity amount must be at least ₦500',
    });
  }
});

const adminTxnQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  type: z.enum(['credit', 'debit']).optional(),
  status: z.string().optional(),
  q: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const adminUserQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  q: z.string().optional(),
});

const adminOrderQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: z.enum(['pending', 'completed', 'failed', 'submitted']).optional(),
  q: z.string().optional(),
});

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body || {});
    if (!result.success) {
      const first = result.error.issues[0];
      return res.status(400).json({ error: first.message });
    }
    req.validated = result.data;
    next();
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query || {});
    if (!result.success) {
      const first = result.error.issues[0];
      return res.status(400).json({ error: first.message });
    }
    req.validatedQuery = result.data;
    next();
  };
}

module.exports = {
  validate, validateQuery,
  registerSchema, loginSchema, forgotPasswordSchema,
  resetPasswordSchema, changePasswordSchema,
  setPinSchema, resetPinSchema, verifyPinSchema,
  paystackInitSchema,
  beneficiaryAddSchema,
  airtimeSchema, dataSchema, cableSchema, electricitySchema,
  examPinSchema, rechargePinSchema,
  autoRechargeSchema, scheduledPurchaseSchema,
  adminTxnQuerySchema, adminUserQuerySchema, adminOrderQuerySchema,
};
