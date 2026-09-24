# Outil CV — Générateur de CV & lettre de motivation par IA

Produit autonome (Waneyo Formation) : contre paiement, génère un CV et une lettre de
motivation professionnels, adaptés au marché de l'emploi du pays visé, à partir des
informations fournies par l'utilisateur.

## Architecture

- `index.html` — page unique : offre, paiement (Paddle Checkout en overlay), formulaire
  profil, affichage du résultat, export PDF (jsPDF, généré dans le navigateur).
- `netlify/functions/generate-cv.js` — vérifie que la commande est payée et pas encore
  utilisée, appelle l'API Claude (Anthropic) pour générer le CV + la lettre, renvoie le
  résultat en JSON.
- `netlify/functions/paddle-webhook.js` — reçoit les webhooks Paddle, vérifie leur
  signature (HMAC-SHA256), et enregistre les commandes payées dans Supabase.
- `supabase-schema.sql` — schéma de la table `cv_orders` à créer une fois dans Supabase.

Aucune dépendance de build : site statique + fonctions Netlify, comme le reste de
l'écosystème Waneyo Formation.

## Flux complet

1. Le visiteur clique sur "Commander" → Paddle Checkout s'ouvre en overlay.
2. Une fois le paiement effectué, Paddle envoie un webhook à `paddle-webhook.js`, qui
   enregistre la commande (`status: completed`) dans `cv_orders`.
3. En parallèle, côté navigateur, l'événement `checkout.completed` de Paddle.js fait
   passer l'utilisateur au formulaire de profil (le `transaction_id` est retenu).
4. À la soumission du formulaire, `generate-cv.js` vérifie la commande. Si le webhook
   n'est pas encore arrivé (quelques secondes de décalage possible), le front-end
   retente automatiquement plusieurs fois avant d'abandonner.
5. Le CV et la lettre s'affichent, avec un bouton de téléchargement PDF.

## Configuration à faire avant mise en ligne

### 1. Variables d'environnement Netlify (Site settings → Environment variables)

| Variable | Où la trouver |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `SUPABASE_URL` | Même projet Supabase que app.waneyo-formation.com |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API (clé **service_role**, jamais la clé anon) |
| `PADDLE_WEBHOOK_SECRET` | Voir étape 3 ci-dessous |
| `CLAUDE_MODEL` | Optionnel — par défaut `claude-haiku-4-5-20251001` |

### 2. Base de données

Exécuter `supabase-schema.sql` une fois dans l'éditeur SQL du **même projet Supabase**
que l'app principale (pas besoin d'un nouveau projet).

### 3. Paddle

1. Créer un produit + un prix dans Paddle (Catalog → Products) → noter le **Price ID**
   (commence par `pri_`).
2. Développer tools → Authentication → Client-side tokens → en créer un → le copier
   (commence par `test_` en sandbox, `live_` en production — **pas un secret**, il est
   prévu pour être visible côté navigateur).
3. Développer tools → Notifications → créer une destination de webhook pointant vers
   `https://<votre-site>.netlify.app/.netlify/functions/paddle-webhook`, cocher au
   minimum l'événement `transaction.completed` → copier le **Secret key** généré →
   c'est la valeur de `PADDLE_WEBHOOK_SECRET`.

### 4. Dans `index.html`

Remplacer les trois constantes en haut du script :
```js
const PADDLE_ENV = 'sandbox';              // 'production' une fois prêt
const PADDLE_CLIENT_TOKEN = '...';         // étape 3.2 ci-dessus
const PADDLE_PRICE_ID = '...';             // étape 3.1 ci-dessus
const PRICE_DISPLAY = '9,99 €';            // texte affiché — le prix réel vient de Paddle
```

## À savoir / limites connues

- **`customer_email` dans `paddle-webhook.js`** : le chemin exact du champ email dans le
  payload Paddle réel n'a pas pu être vérifié sans compte Paddle actif. Le code essaie
  plusieurs emplacements plausibles ; si l'email n'apparaît pas dans `cv_orders` malgré
  tout, vérifier la forme exacte d'un webhook réel reçu (Paddle affiche l'historique des
  webhooks envoyés dans son dashboard) et ajuster la ligne correspondante.
- **Rechargement de page pendant le remplissage du formulaire** : le `transaction_id`
  est conservé dans `localStorage` (nettoyé après une génération réussie), donc un
  rechargement accidentel après paiement ne fait pas perdre la commande.
- **Échec de génération après paiement** (rare — erreur Claude, JSON malformé) : la
  commande est déjà marquée comme utilisée pour éviter un double-appel concurrent ; ce
  cas nécessite un traitement manuel (remboursement ou nouvelle tentative) — voir le
  commentaire dans `generate-cv.js`.

## Tests

Testé (hors ligne, sans appel réseau réel) :
- `generate-cv.js` : 9 scénarios (dont la protection contre la double génération en cas
  de requêtes concurrentes).
- `paddle-webhook.js` : 9 scénarios, avec de vraies signatures HMAC calculées (signature
  valide, absente, falsifiée, corps modifié après signature, timestamp trop ancien).
- `index.html` : 15 scénarios (paiement, formulaire, nouvelle tentative sur commande pas
  encore visible, erreur définitive, export PDF).
