import 'dotenv/config'
import { bot } from './src/bot.js'
import { startServer } from './src/server.js'
import { startCronJobs } from './src/cron.js'

async function main() {
  startServer()
  startCronJobs()
  console.log('Starting bot polling...')
  await bot.start()
}

main().catch((err) => {
  console.error('Fatal error starting bot:', err)
  process.exit(1)
})
