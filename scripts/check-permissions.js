// Diagnostic script: verify the bot has the right admin permissions on both
// channels before wiring up the payment flow or the pin-message script.
//
// Usage:
//   cp .env.example .env   (fill in BOT_TOKEN, FREE_CHANNEL_ID, CLOSED_CHANNEL_ID)
//   npm install
//   npm run check-permissions

import 'dotenv/config'
import { Bot } from 'grammy'

const token = process.env.BOT_TOKEN
if (!token) {
  console.error('Missing BOT_TOKEN in .env')
  process.exit(1)
}

const bot = new Bot(token)

const CHECKS = [
  {
    label: 'FREE_CHANNEL_ID (@bazaimporta)',
    envVar: 'FREE_CHANNEL_ID',
    chatId: process.env.FREE_CHANNEL_ID,
    required: ['can_pin_messages'],
  },
  {
    label: 'CLOSED_CHANNEL_ID (private paid channel)',
    envVar: 'CLOSED_CHANNEL_ID',
    chatId: process.env.CLOSED_CHANNEL_ID,
    required: ['can_invite_users'],
  },
]

function printResult(label, member, required) {
  console.log(`\n${label}`)
  console.log(`  status: ${member.status}`)

  if (member.status !== 'administrator' && member.status !== 'creator') {
    console.log(`  ❌ bot is not an admin in this chat (status="${member.status}") — cannot have any permissions`)
    return
  }

  if (member.status === 'creator') {
    for (const perm of required) {
      console.log(`  ✅ ${perm} (bot is the channel creator, has all permissions)`)
    }
    return
  }

  for (const perm of required) {
    const has = member[perm] === true
    console.log(`  ${has ? '✅' : '❌'} ${perm}`)
  }
}

async function main() {
  const me = await bot.api.getMe()
  console.log(`Checking permissions for bot @${me.username} (id=${me.id})`)

  for (const check of CHECKS) {
    if (!check.chatId) {
      console.log(`\n${check.label}`)
      console.log(`  ❌ ${check.envVar} is not set in .env — run scripts/get-chat-id.js first`)
      continue
    }

    try {
      const member = await bot.api.getChatMember(check.chatId, me.id)
      printResult(check.label, member, check.required)
    } catch (err) {
      console.log(`\n${check.label}`)
      console.log(`  ❌ getChatMember failed: ${err.message}`)
      console.log('  (bot may not be a member of this chat, or the id is wrong)')
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
