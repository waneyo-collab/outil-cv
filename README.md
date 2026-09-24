# Outil CV — Générateur de CV & lettre de motivation par IA

Produit autonome (Waneyo Formation) : contre paiement, génère un CV et une lettre de
motivation professionnels, adaptés au marché de l'emploi du pays visé, à partir des
informations fournies par l'utilisateur.

Deux moyens de paiement, avec géo-détection automatique (même principe que
app.waneyo-formation.com) : **Stripe** pour l'Europe et les Amériques, **Paddle** pour
l'Afrique.

## Architecture

- `index.html` — page unique : offre, paiement (Stripe Payment Link ou Paddle Checkout en
  overlay selon la géo-détection), formulaire profil, affichage du résultat, export PDF.
- `netlify/edge-functions/geo.js` — renvoie le pays du visiteur (contexte géo natif
  Netlify, aucun appel externe) sur `/api/geo`, utilisé par `index.html` pour choisir le
  moyen de paiement.
- `netlify/functions/generate-cv.js` — vérifie que la commande (Stripe ou Paddle) est
  payée et pas encore utilisée, appelle l'API Claude pour générer le CV + la lettre.
- `netlify/functions/paddle-webhook.js` — vérifie la signature des webhooks Paddle
  (HMAC-SHA256 fait main, Paddle n'a pas de SDK léger équivalent à celui de Stripe) et
  enregistre les commandes payées.
- `netlify/functions/stripe-webhook.js` — vérifie la signature des webhooks Stripe via le
  SDK officiel (`stripe.webhooks.constructEvent`) et enregistre les commandes payées.
- `supabase-schema.sql` — schéma de la table `cv_orders` (agnostique du fournisseur de
  paiement) à créer une fois dans Supabase.

Aucune dépendance de build : site statique + fonctions Netlify, comme le reste de
l'écosystème Waneyo Formation.

## Flux complet

1. Au chargement, `index.html` interroge `/api/geo` pour savoir si le visiteur est en
   Afrique (→ Paddle) ou non (→ Stripe). En cas d'échec de la détection, repli sur Paddle
   (fonctionne partout).
2. Le visiteur clique sur "Commander" :
   - **Stripe** → redirection vers le Payment Link. Après paiement, Stripe redirige vers
     `index.html?session_id={CHECKOUT_SESSION_ID}` : la page reconnaît ce paramètre et
     passe directement au formulaire.
   - **Paddle** → Checkout en overlay, sans quitter la page. L'événement
     `checkout.completed` de Paddle.js déclenche le passage au formulaire.
3. En parallèle, le webhook du fournisseur concerné enregistre la commande
   (`status: completed`) dans `cv_orders`.
4. À la soumission du formulaire, `generate-cv.js` vérifie la commande (par
   `provider` + `provider_transaction_id`). Si le webhook n'est pas encore arrivé
   (quelques secondes de décalage possible), le front-end retente automatiquement
   plusieurs fois avant d'abandonner.
5. Le CV et la lettre s'affichent, avec un bouton de téléchargement PDF.

## Configuration à faire avant mise en ligne

### 1. Variables d'environnement Netlify (Site settings → Environment variables)

| Variable | Où la trouver |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `SUPABASE_URL` | Même projet Supabase que app.waneyo-formation.com |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API (clé **service_role**) |
| `PADDLE_WEBHOOK_SECRET` | Voir section Paddle ci-dessous |
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys (clé secrète) |
| `STRIPE_WEBHOOK_SECRET` | Voir section Stripe ci-dessous |
| `CLAUDE_MODEL` | Optionnel — par défaut `claude-haiku-4-5-20251001` |

### 2. Base de données

Exécuter `supabase-schema.sql` une fois dans l'éditeur SQL du **même projet Supabase**
que l'app principale. Si une version précédente (Paddle uniquement) a déjà été exécutée,
utiliser le bloc de migration en commentaire en bas du fichier à la place.

### 3. Paddle

1. Catalog → Products → créer un produit + un prix → noter le **Price ID** (`pri_...`).
2. Developer tools → Authentication → Client-side tokens → en créer un (pas un secret,
   prévu pour être visible côté navigateur).
3. Developer tools → Notifications → créer une destination de webhook vers
   `https://mon-cv.waneyo-formation.com/.netlify/functions/paddle-webhook`, cocher au
   minimum `transaction.completed` → copier le **Secret key** → `PADDLE_WEBHOOK_SECRET`.

### 4. Stripe

1. Créer un **Payment Link** (Produits → Créer un lien de paiement) pour le CV, prix fixe.
2. Dans les options du Payment Link, définir l'URL de redirection après paiement sur :
   `https://mon-cv.waneyo-formation.com/?session_id={CHECKOUT_SESSION_ID}`
   (Stripe remplace automatiquement `{CHECKOUT_SESSION_ID}` par le véritable identifiant).
3. Copier l'URL du Payment Link obtenue.
4. Developers → Webhooks → Add endpoint → URL :
   `https://mon-cv.waneyo-formation.com/.netlify/functions/stripe-webhook`,
   événement à cocher : `checkout.session.completed` → copier le **Signing secret**
   (`whsec_...`) → `STRIPE_WEBHOOK_SECRET`.

### 5. Dans `index.html`

Remplacer les constantes en haut du script :
```js
const PADDLE_ENV = 'sandbox';                 // 'production' une fois prêt
const PADDLE_CLIENT_TOKEN = '...';            // étape Paddle 2
const PADDLE_PRICE_ID = '...';                // étape Paddle 1
const STRIPE_PAYMENT_LINK_URL = '...';        // étape Stripe 3
const PRICE_DISPLAY = '9,99 €';               // texte affiché — le prix réel vient de Stripe/Paddle
```

### 6. Domaine

Prévu pour vivre sur `mon-cv.waneyo-formation.com` : dans Netlify (Domain management →
Add a domain), ajouter ce sous-domaine, puis créer l'enregistrement DNS (CNAME) indiqué
par Netlify chez l'hébergeur DNS de waneyo-formation.com. Aucun achat de nom de domaine
nécessaire (sous-domaine d'un domaine déjà possédé).

## À savoir / limites connues

- **`customer_email` (Paddle)** : le chemin exact du champ email dans le payload Paddle
  réel n'a pas pu être vérifié sans compte actif. Si l'email n'apparaît pas dans
  `cv_orders` pour les commandes Paddle, vérifier la forme d'un webhook réel reçu
  (Paddle affiche l'historique des envois) et ajuster `paddle-webhook.js`. Le champ
  équivalent côté Stripe (`session.customer_details.email`) est, lui, documenté de façon
  stable.
- **Rechargement de page pendant le remplissage du formulaire** : le `transaction_id` et
  le `provider` sont conservés dans `localStorage` (nettoyés après une génération
  réussie), donc un rechargement accidentel après paiement ne fait pas perdre la commande.
- **Échec de génération après paiement** (rare — erreur Claude, JSON malformé) : la
  commande est déjà marquée comme utilisée pour éviter un double-appel concurrent ; ce
  cas nécessite un traitement manuel — voir le commentaire dans `generate-cv.js`.
- **Géo-détection** : classification par liste de codes pays africains (ISO 3166-1) ; à
  ajuster dans `index.html` (`AFRICAN_COUNTRY_CODES`) si un pays doit changer de camp.

## Tests

Testé (hors ligne, sans appel réseau réel, sans vraies clés) : 50 scénarios au total.
- `generate-cv.js` : 12 scénarios (dont provider invalide, et la preuve + correction du
  bug de concurrence sur le verrou anti-double-génération).
- `paddle-webhook.js` : 9 scénarios (signature valide/absente/falsifiée, corps modifié,
  timestamp expiré, événement non pertinent).
- `stripe-webhook.js` : 9 scénarios, avec le **vrai SDK Stripe officiel** pour générer et
  vérifier les signatures de test (pas une réimplémentation approximative).
- `index.html` : 20 scénarios (géo-détection des deux routes, retour Stripe via
  `session_id`, checkout Paddle, reprise après rechargement, nouvelle tentative sur
  commande pas encore visible, erreur définitive, export PDF).
