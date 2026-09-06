import { Bot, InlineKeyboard, session } from 'grammy'
import { pool } from '../db/index.js'
import { buildPaymentUrl } from './robokassa.js'

const token = process.env.BOT_TOKEN
if (!token) {
  throw new Error('Missing BOT_TOKEN in .env')
}

export const bot = new Bot(token)

bot.use(
  session({
    initial: () => ({ promoCode: null, discountRate: 0, awaitingPromo: false }),
  })
)

function isAdmin(ctx) {
  return (
    process.env.ADMIN_TELEGRAM_ID != null &&
    String(ctx.from?.id) === String(process.env.ADMIN_TELEGRAM_ID)
  )
}

const RU_MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

function formatRussianDate(date) {
  return `${date.getDate()} ${RU_MONTHS_GENITIVE[date.getMonth()]} ${date.getFullYear()}`
}

async function showTariffs(ctx) {
  const { rows: tariffs } = await pool.query(
    'SELECT * FROM tariffs WHERE active = true ORDER BY duration_days ASC'
  )
  if (tariffs.length === 0) {
    await ctx.reply('Тарифы временно недоступны.')
    return
  }

  const discountRate = Number(ctx.session.discountRate) || 0
  const keyboard = new InlineKeyboard()
  const lines = []

  for (const tariff of tariffs) {
    const base = Number(tariff.amount)
    const finalPrice = discountRate > 0 ? base * (1 - discountRate) : base
    const priceLine =
      discountRate > 0
        ? `${finalPrice.toFixed(0)}₽ (было ${base.toFixed(0)}₽)`
        : `${finalPrice.toFixed(0)}₽`
    const displayName = tariff.display_name ?? tariff.code
    const accessUntil = new Date()
    accessUntil.setDate(accessUntil.getDate() + tariff.duration_days)

    lines.push(
      `${displayName}: ${priceLine} — ${tariff.duration_days} дней\n` +
        `Доступ будет предоставлен до ${formatRussianDate(accessUntil)}`
    )
    keyboard.text('ПРИОБРЕСТИ ДОСТУП', `pay:${tariff.code}`).row()
  }

  await ctx.reply(lines.join('\n\n'), { reply_markup: keyboard })
}

bot.command('start', async (ctx) => {
  const payload = ctx.match?.trim()
  ctx.session.promoCode = null
  ctx.session.discountRate = 0
  ctx.session.awaitingPromo = false

  await ctx.reply('Привет!\n\nМеня зовут Борис, я путеводитель до закрытой базы импорта!')

  let hasValidPayloadPromo = false
  if (payload) {
    const { rows } = await pool.query(
      'SELECT * FROM promo_codes WHERE code = $1 AND active = true',
      [payload]
    )
    if (rows.length) {
      ctx.session.promoCode = rows[0].code
      ctx.session.discountRate = Number(rows[0].discount_rate)
      hasValidPayloadPromo = true
    }
    // invalid/inactive promo code: ignore silently, fall through to the
    // manual promo prompt below, same as a plain /start with no payload.
  }

  if (hasValidPayloadPromo) {
    await showTariffs(ctx)
    return
  }

  await ctx.reply('ВВЕДИТЕ УНИКАЛЬНЫЙ ПРОМОКОД', {
    reply_markup: new InlineKeyboard()
      .text('Ввести промокод', 'enter_promo')
      .row()
      .text('Продолжить без промокода', 'skip_promo'),
  })
})

bot.callbackQuery('enter_promo', async (ctx) => {
  await ctx.answerCallbackQuery()
  ctx.session.awaitingPromo = true
  await ctx.reply('Введите промокод:')
})

bot.callbackQuery('skip_promo', async (ctx) => {
  await ctx.answerCallbackQuery()
  await showTariffs(ctx)
})

bot.callbackQuery(/^pay:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery()
  const tariffCode = ctx.match[1]

  const { rows } = await pool.query(
    'SELECT * FROM tariffs WHERE code = $1 AND active = true',
    [tariffCode]
  )
  const tariff = rows[0]
  if (!tariff) {
    await ctx.reply('Тариф недоступен.')
    return
  }

  const discountRate = Number(ctx.session.discountRate) || 0
  const amount = (Number(tariff.amount) * (1 - discountRate)).toFixed(2)
  const promoCode = ctx.session.promoCode || null

  const { rows: subRows } = await pool.query(
    `INSERT INTO subscriptions (telegram_id, tariff_code, promo_code, amount, status)
     VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
    [ctx.from.id, tariff.code, promoCode, amount]
  )
  const invId = subRows[0].id

  const paymentUrl = buildPaymentUrl({
    outSum: amount,
    invId,
    description: `Подписка ${tariff.code}`,
  })

  await ctx.reply(`Сумма к оплате: ${amount}₽`, {
    reply_markup: new InlineKeyboard().url('Оплатить', paymentUrl),
  })
})

// Admin commands — silently ignored for non-admins.
bot.command('newpromo', async (ctx) => {
  if (!isAdmin(ctx)) return

  const parts = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length < 3) {
    await ctx.reply('Usage: /newpromo <code> <owner_telegram_id> <commission_rate> [discount_rate]')
    return
  }
  const [code, ownerTelegramId, commissionRate, discountRate] = parts

  await pool.query(
    `INSERT INTO promo_codes (code, owner_telegram_id, commission_rate, discount_rate)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (code) DO UPDATE
       SET owner_telegram_id = EXCLUDED.owner_telegram_id,
           commission_rate = EXCLUDED.commission_rate,
           discount_rate = EXCLUDED.discount_rate,
           active = true`,
    [code, ownerTelegramId, commissionRate, discountRate ?? 0]
  )

  await ctx.reply(`Promo code ${code} created/updated.`)
})

bot.command('payouts', async (ctx) => {
  if (!isAdmin(ctx)) return

  const { rows } = await pool.query(
    `SELECT po.id, po.promo_code, pc.owner_name, po.total_amount, po.period_start, po.period_end
     FROM payouts po
     LEFT JOIN promo_codes pc ON pc.code = po.promo_code
     WHERE po.status = 'pending'
     ORDER BY po.created_at ASC`
  )

  if (rows.length === 0) {
    await ctx.reply('No pending payouts.')
    return
  }

  const lines = rows.map((row) => {
    const start = row.period_start.toISOString().slice(0, 10)
    const end = row.period_end.toISOString().slice(0, 10)
    return `#${row.id} ${row.promo_code} (${row.owner_name ?? 'unknown'}) — ₽${row.total_amount} [${start} – ${end}]`
  })
  await ctx.reply(lines.join('\n'))
})

bot.command('markpaid', async (ctx) => {
  if (!isAdmin(ctx)) return

  const payoutId = (ctx.match ?? '').trim()
  if (!payoutId) {
    await ctx.reply('Usage: /markpaid <payout_id>')
    return
  }

  const { rowCount } = await pool.query(
    `UPDATE payouts SET status = 'paid', paid_at = now() WHERE id = $1 AND status = 'pending'`,
    [payoutId]
  )

  await ctx.reply(
    rowCount ? `Payout #${payoutId} marked paid.` : `Payout #${payoutId} not found or already paid.`
  )
})

// Must be registered last: catches free-text promo code entry after
// "Ввести промокод" is pressed. Commands above are matched first and
// call next() automatically when they don't match, so this never
// intercepts a command.
bot.on('message:text', async (ctx) => {
  if (!ctx.session.awaitingPromo) return

  ctx.session.awaitingPromo = false
  const code = ctx.message.text.trim()

  const { rows } = await pool.query(
    'SELECT * FROM promo_codes WHERE code = $1 AND active = true',
    [code]
  )

  if (rows.length) {
    ctx.session.promoCode = rows[0].code
    ctx.session.discountRate = Number(rows[0].discount_rate)
    await ctx.reply(`Промокод ${code} применён.`)
  } else {
    await ctx.reply('Промокод не найден, продолжаем без скидки.')
  }

  await showTariffs(ctx)
})

bot.catch((err) => {
  console.error('Bot error:', err)
})
