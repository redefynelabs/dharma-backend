import cron from 'node-cron';
import { sendDailyVerseNotification } from './notification.service';
import { logger } from '../../config/logger';

/**
 * Starts four daily cron jobs for push notifications.
 * All times are UTC — adjust the cron expressions to match
 * your primary user timezone if needed.
 *
 *   Morning   — 07:00 UTC
 *   Afternoon — 12:00 UTC
 *   Evening   — 18:00 UTC
 *   Night     — 21:00 UTC
 */
export function startNotificationScheduler(): void {
  // Morning: 7:00 AM UTC
  cron.schedule('0 7 * * *', async () => {
    await sendDailyVerseNotification('morning').catch((err) =>
      logger.error('Morning verse notification failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    );
  });
  

  // Afternoon: 12:00 PM UTC
  cron.schedule('0 12 * * *', async () => {
    await sendDailyVerseNotification('afternoon').catch((err) =>
      logger.error('Afternoon verse notification failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    );
  });

  // Evening: 6:00 PM UTC
  cron.schedule('0 18 * * *', async () => {
    await sendDailyVerseNotification('evening').catch((err) =>
      logger.error('Evening verse notification failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    );
  });

  // Night: 9:00 PM UTC
  cron.schedule('0 21 * * *', async () => {
    await sendDailyVerseNotification('night').catch((err) =>
      logger.error('Night verse notification failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    );
  });

  logger.info('Notification scheduler started', {
    morning:   '07:00 UTC',
    afternoon: '12:00 UTC',
    evening:   '18:00 UTC',
    night:     '21:00 UTC',
  });
}
