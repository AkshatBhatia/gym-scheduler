import cron from "node-cron";
import { briefingService } from "./services/briefing.js";
import { confirmationService } from "./services/confirmations.js";
import { generateAllRecurring } from "./services/recurring.js";

export function setupCronJobs(): void {
  // Morning briefing at 7am, Monday through Saturday
  cron.schedule("0 7 * * 1-6", async () => {
    console.log("[Cron] Running daily briefing...");
    try {
      await briefingService.sendDailyBriefing();
    } catch (error) {
      console.error("[Cron] Daily briefing failed:", error);
    }
  });

  // Confirmation texts at 6pm, Monday through Saturday
  cron.schedule("0 18 * * 1-6", async () => {
    console.log("[Cron] Running confirmation texts...");
    try {
      await confirmationService.sendConfirmations();
    } catch (error) {
      console.error("[Cron] Confirmation texts failed:", error);
    }
  });

  // Sunday 6pm: send confirmation texts for next week's recurring appointments
  cron.schedule("0 18 * * 0", async () => {
    console.log("[Cron] Sending weekly confirmations for recurring clients...");
    try {
      await confirmationService.sendConfirmations();
    } catch (error) {
      console.error("[Cron] Weekly confirmations failed:", error);
    }
  });

  // Sunday 8pm: top up any recurring schedules that need more appointments
  // (catches edge cases like newly added sessions)
  cron.schedule("0 20 * * 0", async () => {
    console.log("[Cron] Topping up recurring appointments...");
    try {
      await generateAllRecurring();
    } catch (error) {
      console.error("[Cron] Recurring top-up failed:", error);
    }
  });

  console.log("[Cron] Scheduled jobs:");
  console.log("  - Daily briefing: 7:00 AM Mon-Sat");
  console.log("  - Confirmation texts: 6:00 PM Mon-Sat");
  console.log("  - Weekly confirmations: 6:00 PM Sunday");
  console.log("  - Recurring top-up: 8:00 PM Sunday");
}
