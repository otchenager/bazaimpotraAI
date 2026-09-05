CREATE TABLE IF NOT EXISTS tariffs (
  code TEXT PRIMARY KEY,
  amount NUMERIC NOT NULL,
  duration_days INT NOT NULL,
  active BOOLEAN DEFAULT true
);

INSERT INTO tariffs (code, amount, duration_days, active)
VALUES ('1_month', 4990, 30, true)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY,
  owner_telegram_id BIGINT NOT NULL,
  owner_name TEXT,
  commission_rate NUMERIC DEFAULT 0.5,
  discount_rate NUMERIC DEFAULT 0,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  tariff_code TEXT REFERENCES tariffs(code),
  promo_code TEXT REFERENCES promo_codes(code),
  amount NUMERIC NOT NULL,
  commission_amount NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'pending', -- pending / paid / expired / revoked
  invite_link TEXT,
  created_at TIMESTAMP DEFAULT now(),
  paid_at TIMESTAMP,
  expires_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sub_telegram_id ON subscriptions(telegram_id);
CREATE INDEX IF NOT EXISTS idx_sub_status_expires ON subscriptions(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_sub_promo ON subscriptions(promo_code);

CREATE TABLE IF NOT EXISTS payouts (
  id SERIAL PRIMARY KEY,
  promo_code TEXT REFERENCES promo_codes(code),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  total_amount NUMERIC NOT NULL,
  status TEXT DEFAULT 'pending', -- pending / paid / failed
  paid_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now()
);
