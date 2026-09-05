// Applies db/schema.sql against DATABASE_URL. Safe to re-run (all
// statements use IF NOT EXISTS / ON CONFLICT DO NOTHING).
//
// Usage: npm run db:migrate

import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { pool } from './index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function logTargetDatabase() {
  const raw = process.env.DATABASE_URL
  if (!raw) {
    console.log('Connecting to database: DATABASE_URL is not set')
    return
  }
  try {
    const { hostname, port, pathname } = new URL(raw)
    console.log(`Connecting to database: ${hostname}:${port || 5432}${pathname}`)
  } catch {
    console.log('Connecting to database: DATABASE_URL is set but could not be parsed')
  }
}

async function migrate() {
  logTargetDatabase()
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
    await pool.query(sql)
    console.log('Schema applied successfully.')
  } finally {
    await pool.end()
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
