import express from 'express'
import { pool } from '../db/index.js'
import { bot } from './bot.js'
import { verifyResultSignature } from './robokassa.js'

export function startServer() {
  const app = express()
  app.use(express.urlencoded({ extended: false }))

  app.post('/robokassa/result', async (req, res) => {
    const { OutSum, InvId, SignatureValue, IsTest } = req.body

    if (!OutSum || !InvId || !SignatureValue) {
      console.error('Robokassa webhook: missing params', req.body)
      res.status(400).send('bad request')
      return
    }

    const valid = verifyResultSignature({
      outSum: OutSum,
      invId: InvId,
      signatureValue: SignatureValue,
      isTest: IsTest === '1',
    })
    if (!valid) {
      console.error(`Robokassa webhook: invalid signature for InvId=${InvId}`)
      res.status(400).send('bad sign')
      return
    }

    try {
      const { rows } = await pool.query(
        `SELECT s.*, t.duration_days
         FROM subscriptions s
         JOIN tariffs t ON t.code = s.tariff_code
         WHERE s.id = $1`,
        [InvId]
      )
      const subscription = rows[0]

      if (!subscription) {
        console.error(`Robokassa webhook: subscription ${InvId} not found`)
        res.status(400).send('unknown InvId')
        return
      }

      // Robokassa retries the webhook until it gets OK{InvId} — if we've
      // already processed this payment, just re-acknowledge without
      // creating a second invite link or double-paying commission.
      if (subscription.status === 'paid') {
        res.type('text/plain').send(`OK${InvId}`)
        return
      }

      if (Number(OutSum) !== Number(subscription.amount)) {
        console.error(
          `Robokassa webhook: OutSum mismatch for InvId=${InvId}: got ${OutSum}, expected ${subscription.amount}`
        )
      }

      let commissionAmount = 0
      let promo = null
      if (subscription.promo_code) {
        const { rows: promoRows } = await pool.query(
          'SELECT * FROM promo_codes WHERE code = $1',
          [subscription.promo_code]
        )
        promo = promoRows[0] ?? null
        if (promo) {
          commissionAmount = Number(subscription.amount) * Number(promo.commission_rate)
        }
      }

      const inviteLink = await bot.api.createChatInviteLink(process.env.CLOSED_CHANNEL_ID, {
        member_limit: 1,
      })

      await pool.query(
        `UPDATE subscriptions
         SET status = 'paid',
             paid_at = now(),
             expires_at = now() + ($2 * INTERVAL '1 day'),
             commission_amount = $3,
             invite_link = $4
         WHERE id = $1`,
        [InvId, subscription.duration_days, commissionAmount, inviteLink.invite_link]
      )

      await bot.api.sendMessage(
        subscription.telegram_id,
        `Оплата получена! Ссылка для входа в закрытый канал:\n${inviteLink.invite_link}`
      )

      if (promo) {
        await bot.api.sendMessage(
          promo.owner_telegram_id,
          `Ваш промокод ${promo.code} только что принёс вам ₽${commissionAmount.toFixed(2)}.`
        )
      }

      res.type('text/plain').send(`OK${InvId}`)
    } catch (err) {
      console.error('Robokassa webhook processing error:', err)
      res.status(500).send('error')
    }
  })

  const port = process.env.PORT || 3000
  app.listen(port, () => console.log(`Robokassa webhook server listening on port ${port}`))
}
