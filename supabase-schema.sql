-- ============================================================
-- StayLiquid Engine · esquema de Supabase
-- Pégalo en Supabase → SQL Editor → New query → Run.
-- ============================================================

-- Clave-valor del motor: clients, state (posiciones) y strategy.
create table if not exists engine_kv (
  k          text primary key,
  v          jsonb,
  updated_at timestamptz default now()
);

-- Registro de órdenes (append-only, auditable). Nunca guarda claves.
create table if not exists engine_orders (
  id   bigserial primary key,
  at   timestamptz default now(),
  data jsonb
);

-- Seguridad: activamos RLS SIN políticas. Así solo la clave service_role
-- (la que usa el motor en el servidor) puede leer/escribir; la clave anon
-- pública no accede a nada.
alter table engine_kv     enable row level security;
alter table engine_orders enable row level security;
