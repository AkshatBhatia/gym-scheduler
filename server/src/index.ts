import "dotenv/config";
import express from "express";
import cors from "cors";

// Import database to ensure it initializes
import "./db/index.js";

// Import route handlers
import clientRoutes from "./routes/clients.js";
import appointmentRoutes from "./routes/appointments.js";
import availabilityRoutes from "./routes/availability.js";
import messageRoutes from "./routes/messages.js";
import dashboardRoutes from "./routes/dashboard.js";
import smsRoutes from "./routes/sms.js";
import recurringRoutes from "./routes/recurring.js";
import settingsRoutes from "./routes/settings.js";
import authRoutes from "./routes/auth.js";
import { optionalAuth } from "./middleware/auth.js";

// Import cron setup
import { setupCronJobs } from "./cron.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // For Twilio webhook form data

// Request logging
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Auth routes (public)
app.use("/api/auth", authRoutes);

// All other routes use optional auth (doesn't block, but sets instructor info if present)
app.use(optionalAuth);

// Mount routes
app.use("/api/clients", clientRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/availability", availabilityRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/sms", smsRoutes);
app.use("/api/recurring", recurringRoutes);
app.use("/api/settings", settingsRoutes);

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
);

app.listen(PORT, () => {
  console.log(`Gym Scheduler server running on http://localhost:${PORT}`);
  setupCronJobs();
});

export default app;
