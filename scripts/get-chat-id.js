// Diagnostic script: discover numeric chat IDs for @bazaimporta_bot's channels.
//
// How to use:
//   1. cp .env.example .env   (fill in BOT_TOKEN)
//   2. npm install
//   3. npm run get-chat-id
//   4. Add the bot as admin to both channels (free @bazaimporta and the
//      closed/paid one), then post any message in each — or just add/remove
//      the bot as admin, which alone fires a my_chat_member update.
//   5. Read the console output: each chat logs its numeric id
//      (format: -100xxxxxxxxxx) plus its title/username.
//   6. Ctrl+C to stop, then copy the ids into FREE_CHANNEL_ID / CLOSED_CHANNEL_ID.

import 'dotenv/config'
import { Bot } from 'grammy'

const token = process.env.BOT_TOKEN
if (!token) {
  console.error('Missing BOT_TOKEN in .env')
  process.exit(1)
}

const bot = new Bot(token)

function logChat(source, chat) {
  const label = chat.title ?? chat.username ?? chat.first_name ?? '(no title)'
  const username = chat.username ? `@${chat.username}` : '(no username)'
  console.log(
    `[${source}] chat.id=${chat.id} type=${chat.type} title="${label}" username=${username}`
  )
}

bot.on('message', (ctx) => logChat('message', ctx.chat))
bot.on('channel_post', (ctx) => logChat('channel_post', ctx.chat))
bot.on('my_chat_member', (ctx) => {
  logChat('my_chat_member', ctx.chat)
  console.log(
    `  status change: ${ctx.myChatMember.old_chat_member.status} -> ${ctx.myChatMember.new_chat_member.status}`
  )
})

bot.catch((err) => {
  console.error('Bot error:', err)
})

console.log('Listening for updates... add the bot to both channels now.')
bot.start()
