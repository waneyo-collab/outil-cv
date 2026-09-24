-- À exécuter une fois dans Supabase (SQL Editor) — projet à réutiliser :
-- celui déjà utilisé par app.waneyo-formation.com, pour ne pas multiplier
-- les projets Supabase. Ajoute une table indépendante, ne touche à rien
-- d'existant.

create table if not exists cv_orders (
  id bigint generated always as identity primary key,
  paddle_transaction_id text not null unique,
  customer_email text,
  status text not null default 'pending',
  used boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists cv_orders_transaction_id_idx
  on cv_orders (paddle_transaction_id);

-- RLS activé, sans policy : la table n'est accessible qu'avec la clé
-- service_role (utilisée uniquement côté serveur, dans les fonctions
-- Netlify) — jamais depuis le navigateur.
alter table cv_orders enable row level security;
