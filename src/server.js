import express from 'express'
import { pool } from '../db/index.js'
import { bot } from './bot.js'
import { verifyResultSignature } from './robokassa.js'

export function startServer() {
  const app = express()
  app.use(express.urlencoded({ extended: false }))

  app.post('/robokassa/result', async (req, res) => {
    const { OutSum, InvId, SignatureValue, IsTest } = req.body

    console.log(
      `Robokassa webhook received: InvId=${InvId}, OutSum=${OutSum}, IsTest=${
        IsTest !== undefined ? IsTest : 'not present'
      }`
    )

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
      console.error(`Signature check: FAILED for InvId=${InvId}`)
      res.status(400).send('bad sign')
      return
    }
    console.log(`Signature check: PASSED for InvId=${InvId}`)

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
        console.error(`Subscription not found for InvId=${InvId}`)
        res.status(400).send('unknown InvId')
        return
      }
      console.log(`Subscription found for InvId=${InvId}, status=${subscription.status}`)

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

      let inviteLink
      try {
        inviteLink = await bot.api.createChatInviteLink(process.env.CLOSED_CHANNEL_ID, {
          member_limit: 1,
        })
        console.log(`Invite link created for InvId=${InvId}`)
      } catch (inviteErr) {
        console.error(`Invite link creation FAILED for InvId=${InvId}:`, inviteErr)
        throw inviteErr
      }

      // Renewal: if this telegram_id already has a paid subscription whose
      // access hasn't run out yet, stack the new period on top of it instead
      // of starting a fresh period from today. The current row is still
      // 'pending' at this point, so filtering on status = 'paid' naturally
      // excludes it.
      const { rows: maxExpiryRows } = await pool.query(
        `SELECT MAX(expires_at) AS max_expires_at
         FROM subscriptions
         WHERE telegram_id = $1 AND status = 'paid'`,
        [subscription.telegram_id]
      )
      const now = new Date()
      const existingExpiresAt = maxExpiryRows[0]?.max_expires_at
        ? new Date(maxExpiryRows[0].max_expires_at)
        : null
      const isRenewal = existingExpiresAt != null && existingExpiresAt > now
      const renewalBase = isRenewal ? existingExpiresAt : now
      console.log(
        `InvId=${InvId}: ${isRenewal ? 'renewal, stacking on existing expires_at' : 'fresh period from now'}`
      )

      await pool.query(
        `UPDATE subscriptions
         SET status = 'paid',
             paid_at = now(),
             expires_at = $2::timestamptz + ($3 * INTERVAL '1 day'),
             commission_amount = $4,
             invite_link = $5
         WHERE id = $1`,
        [
          InvId,
          renewalBase.toISOString(),
          subscription.duration_days,
          commissionAmount,
          inviteLink.invite_link,
        ]
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
