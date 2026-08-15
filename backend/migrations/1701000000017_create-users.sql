-- Up Migration

-- Renumbered ahead of the bets migration -- bets.user_id now references
-- this table. password_hash, never a plaintext password: bcrypt output
-- (includes its own salt), verified at login via bcrypt.compare, never
-- decrypted (hashing is one-way by design).
CREATE TABLE users (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE users;
