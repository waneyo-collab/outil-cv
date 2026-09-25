# Outil CV — Générateur de CV & lettre de motivation par IA

Produit autonome (Waneyo Formation) : contre paiement, génère un CV et une lettre de
motivation professionnels, adaptés au marché de l'emploi du pays visé, à partir des
informations fournies par l'utilisateur.

Paiement par **Stripe** (Payment Link), pour tous les pays. Paddle a été envisagé puis
retiré : Paddle exige un domaine personnalisé approuvé pour le mode live, incompatible
avec une adresse `*.netlify.app` — Stripe, lui, ne demande aucune approbation de domaine.

## Architecture

- `index.html` — page unique : offre, redirection vers le Payment Link Stripe, retour
  automatique sur le formulaire de profil après paiement, affichage du résultat, export
  PDF (jsPDF, généré dans le navigateur).
- `netlify/functions/generate-cv.js` — vérifie que la commande est payée et pas encore
  utilisée, appelle l'API Claude (Anthropic) pour générer le CV + la lettre.
- `netlify/functions/stripe-webhook.js` — vérifie la signature des webhooks Stripe via le
  SDK officiel (`stripe.webhooks.constructEvent`) et enregistre les commandes payées dans
  Supabase.
- `supabase-schema.sql` — schéma de la table `cv_orders`. Une colonne `provider` est
  conservée (toujours `'stripe'` pour l'instant) au cas où un second moyen de paiement
  serait réintroduit plus tard — aucun impact tant qu'un seul est utilisé.

Aucune dépendance de build : site statique + fonctions Netlify, comme le reste de
l'écosystème Waneyo Formation. Aucun domaine personnalisé requis : fonctionne tel quel
sur l'adresse `*.netlify.app` fournie gratuitement par Netlify.

## Flux complet

1. Le visiteur clique sur "Commander" → redirection vers le Payment Link Stripe (page
   hébergée par Stripe, aucun code de notre côté à ce stade).
2. Après paiement, Stripe redirige vers `index.html?session_id={CHECKOUT_SESSION_ID}` :
   la page reconnaît ce paramètre et passe directement au formulaire de profil.
3. En parallèle, le webhook Stripe enregistre la commande (`status: completed`) dans
   `cv_orders`.
4. À la soumission du formulaire, `generate-cv.js` vérifie la commande. Si le webhook
   n'est pas encore arrivé (quelques secondes de décalage possible), le front-end
   retente automatiquement plusieurs fois avant d'abandonner.
5. Le CV et la lettre s'affichent, avec un bouton de téléchargement PDF.

## Configuration à faire avant mise en ligne

### 1. Variables d'environnement Netlify (Site settings → Environment variables)

| Variable | Où la trouver |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `SUPABASE_URL` | Même projet Supabase que app.waneyo-formation.com (Project URL) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API (clé **secrète**, anciennement "service_role") |
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys (clé secrète, `sk_...`) |
| `STRIPE_WEBHOOK_SECRET` | Voir section Stripe ci-dessous |
| `CLAUDE_MODEL` | Optionnel — par défaut `claude-haiku-4-5-20251001` |

### 2. Base de données

Exécuter `supabase-schema.sql` une fois dans l'éditeur SQL du **même projet Supabase**
que l'app principale.

### 3. Stripe

1. Créer un **Payment Link** (Produits → Créer un lien de paiement), prix fixe.
2. Dans les options du Payment Link, page de confirmation → "Ne pas afficher la page de
   confirmation" → rediriger vers :
   `https://<votre-site>.netlify.app/?session_id={CHECKOUT_SESSION_ID}`
   (Stripe remplace automatiquement `{CHECKOUT_SESSION_ID}` par le véritable identifiant).
3. Copier l'URL du Payment Link obtenue.
4. Developers → Webhooks → Add endpoint → URL :
   `https://<votre-site>.netlify.app/.netlify/functions/stripe-webhook`,
   événement à cocher : `checkout.session.completed` → copier le **Signing secret**
   (`whsec_...`) → `STRIPE_WEBHOOK_SECRET`.

### 4. Dans `index.html`

Remplacer les deux constantes en haut du script :
```js
const STRIPE_PAYMENT_LINK_URL = '...';   // étape Stripe 3
const PRICE_DISPLAY = '4,99 €';          // texte affiché — le prix réel vient de Stripe
```

## À savoir / limites connues

- **Rechargement de page pendant le remplissage du formulaire** : le `transaction_id`
  est conservé dans `localStorage` (nettoyé après une génération réussie), donc un
  rechargement accidentel après paiement ne fait pas perdre la commande.
- **Échec de génération après paiement** (rare — erreur Claude, JSON malformé) : la
  commande est déjà marquée comme utilisée pour éviter un double-appel concurrent ; ce
  cas nécessite un traitement manuel — voir le commentaire dans `generate-cv.js`.
- **Domaine personnalisé** : non nécessaire pour fonctionner (Stripe n'exige aucune
  approbation de domaine). Peut être ajouté plus tard pour l'image de marque, sans rien
  changer au fonctionnement.

## Tests

Testé (hors ligne, sans appel réseau réel, sans vraie clé) :
- `generate-cv.js` : 12 scénarios, dont la preuve + correction du bug de concurrence sur
  le verrou anti-double-génération.
- `stripe-webhook.js` : 9 scénarios, avec le **vrai SDK Stripe officiel** pour générer et
  vérifier les signatures de test (signature valide/absente/falsifiée, corps modifié,
  timestamp expiré, événement non pertinent).
- `index.html` : scénarios de paiement (retour Stripe via `session_id`), formulaire,
  reprise après rechargement, nouvelle tentative sur commande pas encore visible, erreur
  définitive, export PDF.
