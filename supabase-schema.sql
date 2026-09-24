-- À exécuter dans Supabase (SQL Editor) — projet à réutiliser : celui
-- déjà utilisé par app.waneyo-formation.com. Ajoute une table indépendante,
-- ne touche à rien d'existant.
--
-- Schéma agnostique du moyen de paiement : une commande peut venir de
-- Paddle OU de Stripe (géo-détection Europe/Amériques -> Stripe,
-- Afrique -> Paddle, même principe que app.waneyo-formation.com).

create table if not exists cv_orders (
  id bigint generated always as identity primary key,
  provider text not null check (provider in ('paddle', 'stripe')),
  provider_transaction_id text not null,
  customer_email text,
  status text not null default 'pending',
  used boolean not null default false,
  created_at timestamptz not null default now(),
  unique (provider, provider_transaction_id)
);

create index if not exists cv_orders_lookup_idx
  on cv_orders (provider, provider_transaction_id);

-- RLS activé, sans policy : la table n'est accessible qu'avec la clé
-- service_role (utilisée uniquement côté serveur, dans les fonctions
-- Netlify) — jamais depuis le navigateur.
alter table cv_orders enable row level security;

-- ── Si vous avez déjà exécuté une version précédente de ce schéma
--    (avec paddle_transaction_id au lieu de provider/provider_transaction_id),
--    utilisez cette migration à la place du create table ci-dessus :
--
-- alter table cv_orders add column if not exists provider text;
-- update cv_orders set provider = 'paddle' where provider is null;
-- alter table cv_orders alter column provider set not null;
-- alter table cv_orders add constraint cv_orders_provider_check check (provider in ('paddle','stripe'));
-- alter table cv_orders rename column paddle_transaction_id to provider_transaction_id;
-- alter table cv_orders add constraint cv_orders_provider_txn_unique unique (provider, provider_transaction_id);
