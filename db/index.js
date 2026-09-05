import pg from 'pg'

const { Pool } = pg

// Parsed by hand instead of passed as `connectionString`: pg's
// ConnectionParameters merges pg-connection-string's parse of the raw URL
// on TOP of explicit config (node_modules/pg/lib/connection-parameters.js),
// so a `sslmode=` query param in DATABASE_URL silently overrides the `ssl`
// option below. Passing discrete fields skips that merge entirely.
const url = new URL(process.env.DATABASE_URL)
const isRailwayInternal = url.hostname.endsWith('.railway.internal')

export const pool = new Pool({
  host: url.hostname,
  port: url.port ? Number(url.port) : 5432,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.slice(1),
  // Railway's private network doesn't need SSL; public endpoints
  // (Railway's proxy, Neon, etc.) present a cert we don't need to verify.
  ssl: isRailwayInternal ? false : { rejectUnauthorized: false },
})
