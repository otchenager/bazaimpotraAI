import cron from 'node-cron'
import { pool } from '../db/index.js'
import { bot } from './bot.js'

export function startCronJobs() {
  cron.schedule('0 3 * * *', runExpiryCheck) // daily 03:00
  cron.schedule('0 9 * * 1', runWeeklyPayoutReport) // every Monday, 09:00
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

async function runWeeklyPayoutReport() {
  try {
    const now = new Date()
    // Window is the 7 days that just closed: last Monday 00:00 UTC (inclusive)
    // through this Monday 00:00 UTC (exclusive).
    const periodEndExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    const periodStart = new Date(periodEndExclusive.getTime() - 7 * 24 * 60 * 60 * 1000)
    const periodEnd = new Date(periodEndExclusive.getTime() - 24 * 60 * 60 * 1000)

    const { rows } = await pool.query(
      `SELECT s.promo_code, p.owner_name, p.owner_telegram_id, COUNT(*) AS count, SUM(s.commission_amount) AS total
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
      console.log('Weekly payout report: no commissions to report for the past week.')
      return
    }

    const reportBlocks = []
    for (const row of rows) {
      await pool.query(
        `INSERT INTO payouts (promo_code, period_start, period_end, total_amount, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [row.promo_code, periodStart.toISOString().slice(0, 10), periodEnd.toISOString().slice(0, 10), row.total]
      )

      const total = Number(row.total)
      if (total > 0) {
        reportBlocks.push(
          `Owner telegram_id: ${row.owner_telegram_id}\nPromo code: ${row.promo_code}\nOwed this week: ₽${total.toFixed(2)}`
        )
      }
    }

    if (reportBlocks.length > 0 && process.env.ADMIN_TELEGRAM_ID) {
      await sendChunked(process.env.ADMIN_TELEGRAM_ID, reportBlocks.join('\n\n'))
    }

    for (const row of rows) {
      const total = Number(row.total)
      const count = Number(row.count)
      if (total <= 0) continue

      try {
        await bot.api.sendMessage(
          row.owner_telegram_id,
          `BAZAIMPORTA ставит в известность — «ДЕНЬ ВЫПЛАТ!»\n\n` +
            `Благодаря вашей работе мы получили ${count} подписок на закрытый Telegram-канал, а вы заработали ${total.toFixed(2)} рублей.\n\n` +
            `Спасибо за доверие!`
        )
      } catch (err) {
        console.error(
          `Weekly payout report: failed to notify owner_telegram_id=${row.owner_telegram_id} for promo_code=${row.promo_code}:`,
          err.message
        )
      }
    }
  } catch (err) {
    console.error('Weekly payout cron failed:', err)
  }
}

async function sendChunked(chatId, text, maxLen = 4096) {
  if (text.length <= maxLen) {
    await bot.api.sendMessage(chatId, text)
    return
  }

  const blocks = text.split('\n\n')
  let chunk = ''
  for (const block of blocks) {
    const candidate = chunk ? `${chunk}\n\n${block}` : block
    if (candidate.length > maxLen) {
      if (chunk) await bot.api.sendMessage(chatId, chunk)
      chunk = block
    } else {
      chunk = candidate
    }
  }
  if (chunk) await bot.api.sendMessage(chatId, chunk)
}
