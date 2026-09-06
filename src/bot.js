import { Bot, InlineKeyboard, InputFile, Keyboard, session } from 'grammy'
import { pool } from '../db/index.js'
import { buildPaymentUrl } from './robokassa.js'

const token = process.env.BOT_TOKEN
if (!token) {
  throw new Error('Missing BOT_TOKEN in .env')
}

export const bot = new Bot(token)

bot.use(
  session({
    initial: () => ({
      promoCode: null,
      discountRate: 0,
      awaitingPromo: false,
      awaitingPartnerCode: false,
    }),
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

// Persistent reply-keyboard main menu, shown after "Старт" is pressed.
const MENU_BUY = '🎫 ПРИОБРЕСТИ ДОСТУП'
const MENU_ABOUT = '📖 О нас'
const MENU_CHANNEL_INFO = '🔒 Закрытая база'
const MENU_AUDIENCE = '🎓 Для кого курс'
const MENU_SUBSCRIPTION = '📊 Моя подписка'
const MENU_PARTNER = '🤝 Стать партнёром'
const MENU_FREE_CHANNEL = '📚 Бесплатный канал'
const MENU_QUESTION = '💬 Задать вопрос'

const mainMenuKeyboard = new Keyboard()
  .text(MENU_BUY).row()
  .text(MENU_ABOUT).row()
  .text(MENU_CHANNEL_INFO).row()
  .text(MENU_AUDIENCE).row()
  .text(MENU_SUBSCRIPTION).row()
  .text(MENU_PARTNER).row()
  .text(MENU_FREE_CHANNEL).row()
  .text(MENU_QUESTION).row()
  .resized()
  .persistent()

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

// Entry point for the purchase flow, reached from the "🎫 ПРИОБРЕСТИ ДОСТУП"
// menu button. If a valid promo code is already in the session (applied via
// a /start deep-link payload, or entered earlier this session), skip the
// manual-entry prompt and go straight to tariffs — same behavior as before,
// just reached from the menu instead of from /start directly.
async function startPurchaseFlow(ctx) {
  if (ctx.session.promoCode) {
    await showTariffs(ctx)
    return
  }

  ctx.session.awaitingPromo = false
  await ctx.reply('ВВЕДИТЕ УНИКАЛЬНЫЙ ПРОМОКОД', {
    reply_markup: new InlineKeyboard()
      .text('Ввести промокод', 'enter_promo')
      .row()
      .text('Продолжить без промокода', 'skip_promo'),
  })
}

bot.command('start', async (ctx) => {
  const payload = ctx.match?.trim()
  ctx.session.promoCode = null
  ctx.session.discountRate = 0
  ctx.session.awaitingPromo = false
  ctx.session.awaitingPartnerCode = false

  if (payload) {
    const { rows } = await pool.query(
      'SELECT * FROM promo_codes WHERE code = $1 AND active = true',
      [payload]
    )
    if (rows.length) {
      ctx.session.promoCode = rows[0].code
      ctx.session.discountRate = Number(rows[0].discount_rate)
    }
    // invalid/inactive promo code: ignore silently, proceed as normal
  }

  await ctx.reply(
    'Тебя приветствует Борис, ИИ-агент команды BAZAIMPORTA 🤖\n\n' +
      'Я помогу тебе получить доступ в закрытый канал, отвечу на вопросы, а также ты можешь стать партнёром БАЗЫ.\n\n' +
      'Нажимай кнопку "Старт" ниже 👇',
    { reply_markup: new InlineKeyboard().text('Старт', 'show_menu') }
  )
})

bot.callbackQuery('show_menu', async (ctx) => {
  await ctx.answerCallbackQuery()
  try {
    await ctx.editMessageReplyMarkup()
  } catch (err) {
    console.error('show_menu: failed to remove inline "Старт" button:', err.message)
  }
  await ctx.reply('Выбирай, что тебя интересует 👇', { reply_markup: mainMenuKeyboard })
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

bot.hears(MENU_BUY, startPurchaseFlow)

bot.hears(MENU_ABOUT, async (ctx) => {
  const caption =
    'BAZA Import — сообщество автобизнеса.\n\n' +
    'Твой путь в автоимпорт начинается здесь. Пошаговая система от поставщика с 200+ машинами и Lamborghini за плечами.'

  const photoPaths = [
    './assets/about-lamb.jpg',
    './assets/about-bmw.jpg',
    './assets/about-uik.jpg',
  ]

  try {
    if (photoPaths.length === 1) {
      await ctx.replyWithPhoto(new InputFile(photoPaths[0]), { caption })
    } else {
      await ctx.replyWithMediaGroup(
        photoPaths.map((path, i) => ({
          type: 'photo',
          media: new InputFile(path),
          caption: i === 0 ? caption : undefined,
        }))
      )
    }
  } catch (err) {
    console.error('О нас: failed to send photo(s), falling back to text only:', err.message)
    await ctx.reply(caption)
  }
})

bot.hears(MENU_CHANNEL_INFO, async (ctx) => {
  await ctx.reply(
    'Что внутри платного канала:\n\n' +
      '1️⃣ Последовательная система из блоков\n' +
      'Готовый план вместо разрозненных кусков информации — чёткий порядок действий, чтобы привезти машину из любой страны.\n\n' +
      '2️⃣ Контакты проверенных брокеров и логистов\n' +
      'Контакты людей, с которыми я работаю сам. Не ищешь подрядчиков вслепую — работаешь с проверенными по лучшим ценам.\n\n' +
      '3️⃣ Живые эфиры с поставщиками из Кореи, Китая, брокерами и юристами (1 раз в месяц)\n' +
      'Вопросы напрямую профессионалам — информация, которая не публикуется в открытых источниках.\n\n' +
      '4️⃣ Инструменты для автобизнеса\n' +
      'Готовые инструменты для поиска клиентов, автоматизации трафика и создания профессионального бренда — платные и бесплатные.\n\n' +
      '5️⃣ Закрытый чат участников\n' +
      'Разработка стратегии с основателями базы и участниками, вкладывающими деньги в продвижение — инсайдерская информация.'
  )
})

bot.hears(MENU_AUDIENCE, async (ctx) => {
  await ctx.reply(
    'Канал будет полезен, если вы:\n\n' +
      '🚗 Хотите привезти машину себе\n' +
      'Разово выбрать и завезти автомобиль под личное использование без переплат посредникам.\n\n' +
      '💼 Планируете запустить бизнес на перегонах\n' +
      'Разобраться в схемах импорта, чтобы возить машины на заказ и зарабатывать на этом.\n\n' +
      '🔧 Уже перегоняете, но хотите систему\n' +
      'Есть опыт, но нет стабильного процесса — нужны проверенные контакты и алгоритмы.\n\n' +
      '🏢 Автодилер или менеджер автосалона\n' +
      'Хотите расширить ассортимент за счёт прямых поставок из Азии в обход перекупщиков.'
  )
})

bot.hears(MENU_SUBSCRIPTION, async (ctx) => {
  const { rows } = await pool.query(
    `SELECT * FROM subscriptions
     WHERE telegram_id = $1 AND status = 'paid' AND expires_at > now()
     ORDER BY created_at DESC
     LIMIT 1`,
    [ctx.from.id]
  )
  const subscription = rows[0]

  if (subscription) {
    await ctx.reply(
      `Статус: оплачено ✅\nДоступ действителен до ${formatRussianDate(new Date(subscription.expires_at))}`
    )
  } else {
    await ctx.reply('Статус: не оплачено ❌\nЧтобы получить доступ, нажмите "🎫 ПРИОБРЕСТИ ДОСТУП"')
  }
})

bot.hears(MENU_PARTNER, async (ctx) => {
  ctx.session.awaitingPartnerCode = true
  await ctx.reply(
    'Хочешь стать партнёром BAZAIMPORTA?\n\n' +
      'Ты можешь сам создать свой уникальный промокод и получать 25% с каждой продажи, а твои клиенты получат скидку 10%.\n\n' +
      'Напиши, какой промокод хочешь использовать (одно слово латиницей, без пробелов и спецсимволов).\n\n' +
      'Свой Telegram ID (на всякий случай, если понадобится) можно узнать у @userinfobot.'
  )
})

bot.hears(MENU_FREE_CHANNEL, async (ctx) => {
  await ctx.reply('https://t.me/bazaimporta')
})

bot.hears(MENU_QUESTION, async (ctx) => {
  await ctx.reply('Есть вопрос? Напиши напрямую: @visagevvvv')
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

async function handlePartnerCodeSubmission(ctx) {
  const code = ctx.message.text.trim().toUpperCase()

  if (!code || !/^[A-Za-z0-9_-]+$/.test(code)) {
    await ctx.reply(
      'Промокод может содержать только латинские буквы, цифры, - и _.\nПопробуй другой вариант.'
    )
    return
  }

  const { rows: existing } = await pool.query('SELECT code FROM promo_codes WHERE code = $1', [code])
  if (existing.length) {
    await ctx.reply('Этот промокод уже занят, выбери другой')
    return // stay in the awaitingPartnerCode state so they can retry
  }

  await pool.query(
    `INSERT INTO promo_codes (code, owner_telegram_id, commission_rate, discount_rate, active)
     VALUES ($1, $2, 0.25, 0.1, true)`,
    [code, ctx.from.id]
  )

  ctx.session.awaitingPartnerCode = false

  await ctx.reply(
    `Готово! Твой промокод: ${code}\n\n` +
      `Делись этой ссылкой:\n` +
      `https://t.me/bazaimporta_bot?start=${code}\n\n` +
      `За каждую продажу по этому коду ты получишь 25% комиссии, а твой клиент — скидку 10%.`
  )
}

// Must be registered last: catches free-text entry for the manual promo
// code flow and the self-service partner code flow. Commands and hears()
// matches above are matched first, so this never intercepts them.
bot.on('message:text', async (ctx) => {
  if (ctx.session.awaitingPartnerCode) {
    await handlePartnerCodeSubmission(ctx)
    return
  }

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
