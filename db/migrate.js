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

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
  await pool.query(sql)
  console.log('Schema applied successfully.')
  await pool.end()
}

migrate().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
