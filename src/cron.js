import cron from 'node-cron'
import { pool } from '../db/index.js'
import { bot } from './bot.js'

export function startCronJobs() {
  cron.schedule('0 3 * * *', runExpiryCheck) // daily 03:00
  cron.schedule('0 9 1 * *', runMonthlyPayoutReport) // 1st of month, 09:00
}

async function runExpiryCheck() {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM subscriptions WHERE status = 'paid' AND expires_at < now()`
    )

    for (const subscription of rows) {
      try {
        await bot.api.banChatMember(process.env.CLOSED_CHANNEL_ID, subscription.telegram_id)
        await bot.api.unbanChatMember(process.env.CLOSED_CHANNEL_ID, subscription.telegram_id)
      } catch (err) {
        console.error(
          `Expiry check: failed to remove telegram_id=${subscription.telegram_id} from closed channel:`,
          err.message
        )
      }
      await pool.query(`UPDATE subscriptions SET status = 'expired' WHERE id = $1`, [subscription.id])
    }

    if (rows.length) {
      console.log(`Expiry check: processed ${rows.length} expired subscription(s).`)
    }
  } catch (err) {
    console.error('Expiry cron failed:', err)
  }
}

async function runMonthlyPayoutReport() {
  try {
    const now = new Date()
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    const periodEndExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const periodEnd = new Date(periodEndExclusive.getTime() - 24 * 60 * 60 * 1000)

    const { rows } = await pool.query(
      `SELECT s.promo_code, p.owner_name, p.owner_telegram_id, SUM(s.commission_amount) AS total
       FROM subscriptions s
       JOIN promo_codes p ON p.code = s.promo_code
       WHERE s.status = 'paid'
         AND s.promo_code IS NOT NULL
         AND s.paid_at >= $1
         AND s.paid_at < $2
       GROUP BY s.promo_code, p.owner_name, p.owner_telegram_id`,
      [periodStart.toISOString(), periodEndExclusive.toISOString()]
    )

    if (rows.length === 0) {
      console.log('Monthly payout report: no commissions to report for previous month.')
      return
    }

    const lines = ['Отчёт по выплатам за прошлый месяц:']
    for (const row of rows) {
      await pool.query(
        `INSERT INTO payouts (promo_code, period_start, period_end, total_amount, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [row.promo_code, periodStart.toISOString().slice(0, 10), periodEnd.toISOString().slice(0, 10), row.total]
      )
      lines.push(`${row.promo_code} (${row.owner_name ?? row.owner_telegram_id}) — ₽${Number(row.total).toFixed(2)}`)
    }

    if (process.env.ADMIN_TELEGRAM_ID) {
      await bot.api.sendMessage(process.env.ADMIN_TELEGRAM_ID, lines.join('\n'))
    }
  } catch (err) {
    console.error('Monthly payout cron failed:', err)
  }
}
