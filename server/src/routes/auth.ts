import { Router, Request, Response } from "express";
import { sendOTP, verifyOTP, getInstructor, updateInstructor } from "../services/auth.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// POST /api/auth/send-otp — Send OTP to phone number
router.post("/send-otp", async (req: Request, res: Response) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      res.status(400).json({ error: "Phone number is required" });
      return;
    }

    const result = await sendOTP(phone);
    res.json(result);
  } catch (error) {
    console.error("Error sending OTP:", error);
    res.status(500).json({ error: "Failed to send OTP" });
  }
});

// POST /api/auth/verify-otp — Verify OTP and get JWT
router.post("/verify-otp", async (req: Request, res: Response) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) {
      res.status(400).json({ error: "Phone and code are required" });
      return;
    }

    const result = await verifyOTP(phone, code);
    if (!result.success) {
      res.status(401).json({ error: result.error });
      return;
    }

    res.json(result);
  } catch (error) {
    console.error("Error verifying OTP:", error);
    res.status(500).json({ error: "Failed to verify OTP" });
  }
});

// GET /api/auth/me — Get current instructor profile
router.get("/me", requireAuth, (req: Request, res: Response) => {
  try {
    const inst = getInstructor(req.instructorId!);
    if (!inst) {
      res.status(404).json({ error: "Instructor not found" });
      return;
    }
    res.json(inst);
  } catch (error) {
    console.error("Error fetching profile:", error);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// PUT /api/auth/me — Update instructor profile
router.put("/me", requireAuth, (req: Request, res: Response) => {
  try {
    const { name, email, businessName, venmoHandle, timezone } = req.body;
    const updated = updateInstructor(req.instructorId!, {
      ...(name !== undefined && { name }),
      ...(email !== undefined && { email }),
      ...(businessName !== undefined && { businessName }),
      ...(venmoHandle !== undefined && { venmoHandle }),
      ...(timezone !== undefined && { timezone }),
    });
    res.json(updated);
  } catch (error) {
    console.error("Error updating profile:", error);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

export default router;
