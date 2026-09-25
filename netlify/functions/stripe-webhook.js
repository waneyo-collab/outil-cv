const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// La clé secrète n'est pas utilisée pour la vérification de signature en
// elle-même (opération purement cryptographique, locale), mais le SDK
// Stripe exige une clé pour s'instancier.
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_placeholder_unused_for_webhook_verification');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('❌ STRIPE_WEBHOOK_SECRET manquant');
    return { statusCode: 500, body: 'Configuration serveur invalide' };
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body || '';

  const signature = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

  let stripeEvent;
  try {
    // constructEvent vérifie la signature (HMAC-SHA256 sur "<ts>.<corps>",
    // en-tête Stripe-Signature) et la fraîcheur du timestamp — le SDK
    // officiel Stripe gère ça pour nous, pas besoin de réimplémenter.
    stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Signature Stripe invalide:', err.message);
    return { statusCode: 401, body: 'Invalid signature' };
  }

  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'Événement ignoré (non pertinent)' };
  }

  const session = stripeEvent.data.object;
  const transactionId = session.id; // ex. "cs_live_..." / "cs_test_..."
  const customerEmail = session.customer_details?.email || session.customer_email || null;

  if (!transactionId) {
    console.error('❌ checkout.session.completed sans id de session');
    return { statusCode: 400, body: 'Payload invalide' };
  }

  // Upsert idempotent : Stripe peut
  // renvoyer le même événement plusieurs fois, et on ne doit jamais
  // réinitialiser `used` si la commande a déjà été consommée.
  const { error } = await supabase
    .from('cv_orders')
    .upsert(
      {
        provider: 'stripe',
        provider_transaction_id: transactionId,
        customer_email: customerEmail,
        status: 'completed',
      },
      { onConflict: 'provider,provider_transaction_id', ignoreDuplicates: false }
    );

  if (error) {
    console.error('❌ Erreur écriture Supabase:', error.message);
    // 500 pour que Stripe retente automatiquement cet envoi plus tard
    return { statusCode: 500, body: 'Erreur serveur' };
  }

  return { statusCode: 200, body: 'OK' };
};
