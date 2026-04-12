import jwt from "jsonwebtoken";
import crypto from "crypto";
import { eq, and, gte } from "drizzle-orm";
import db from "../db/index.js";
import { instructor, otpCodes } from "../db/schema.js";
import { smsProvider } from "./sms.js";

const JWT_SECRET = process.env.JWT_SECRET || (() => {
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET environment variable is required in production");
  }
  return "gym-scheduler-dev-secret-not-for-production";
})();
const OTP_EXPIRY_MINUTES = 5;

/**
 * Generate a 6-digit OTP and store it in the database.
 */
export async function sendOTP(phone: string): Promise<{ success: boolean; error?: string }> {
  // Generate 6-digit code
  const code = crypto.randomInt(100000, 999999).toString();
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();

  // Invalidate any existing unused OTPs for this phone
  db.update(otpCodes)
    .set({ used: 1 })
    .where(and(eq(otpCodes.phone, phone), eq(otpCodes.used, 0)))
    .run();

  // Store the OTP
  db.insert(otpCodes)
    .values({ phone, code, expiresAt })
    .run();

  // Send via SMS
  try {
    await smsProvider.sendMessage(phone, `Your GymFlow login code is: ${code}\n\nExpires in ${OTP_EXPIRY_MINUTES} minutes.`);
  } catch (err) {
    console.error("[Auth] Failed to send OTP SMS:", err);
  }

  // Only log OTP in development for testing
  if (process.env.NODE_ENV !== "production") {
    console.log(`[Auth] OTP for ${phone}: ${code}`);
  }

  return { success: true };
}

/**
 * Verify an OTP code and return a JWT if valid.
 */
export async function verifyOTP(
  phone: string,
  code: string
): Promise<{ success: boolean; token?: string; instructor?: any; isNewUser?: boolean; error?: string }> {
  const now = new Date().toISOString();

  // Find a valid, unused OTP for this phone
  const otp = db
    .select()
    .from(otpCodes)
    .where(
      and(
        eq(otpCodes.phone, phone),
        eq(otpCodes.code, code),
        eq(otpCodes.used, 0),
        gte(otpCodes.expiresAt, now)
      )
    )
    .get();

  if (!otp) {
    return { success: false, error: "Invalid or expired code" };
  }

  // Mark OTP as used
  db.update(otpCodes)
    .set({ used: 1 })
    .where(eq(otpCodes.id, otp.id))
    .run();

  // Find or create instructor
  let inst = db
    .select()
    .from(instructor)
    .where(eq(instructor.phone, phone))
    .get();

  let isNewUser = false;
  if (!inst) {
    // First-time login — create instructor profile
    const result = db
      .insert(instructor)
      .values({
        name: "",
        phone,
        timezone: "America/Los_Angeles",
      })
      .returning()
      .get();
    inst = result;
    isNewUser = true;
  }

  // Generate JWT
  const token = jwt.sign(
    { instructorId: inst.id, phone: inst.phone },
    JWT_SECRET,
    { expiresIn: "30d" }
  );

  return { success: true, token, instructor: inst, isNewUser };
}

/**
 * Verify a JWT token and return the instructor.
 */
export function verifyToken(token: string): { instructorId: number; phone: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { instructorId: number; phone: string };
  } catch {
    return null;
  }
}

/**
 * Get instructor profile by ID.
 */
export function getInstructor(id: number) {
  return db.select().from(instructor).where(eq(instructor.id, id)).get();
}

/**
 * Update instructor profile.
 */
export function updateInstructor(id: number, data: Partial<{
  name: string;
  email: string;
  businessName: string;
  venmoHandle: string;
  timezone: string;
  avatarUrl: string;
}>) {
  return db
    .update(instructor)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(instructor.id, id))
    .returning()
    .get();
}
