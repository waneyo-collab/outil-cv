const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Rejette les webhooks trop anciens (protection anti-rejeu) — 5 minutes de tolérance
const MAX_TIMESTAMP_AGE_SECONDS = 300;

// ── Vérification de la signature Paddle Billing ──
// Format de l'en-tête Paddle-Signature : "ts=<timestamp>;h1=<hmac_hex>"
// Signature = HMAC-SHA256("<ts>:<corps_brut>", secret), comparée en temps constant.
// Doc : https://developer.paddle.com/webhooks/signature-verification
function verifyPaddleSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(';').map((p) => p.split('=').map((s) => s.trim()))
  );
  const ts = parts.ts;
  const h1 = parts.h1;
  if (!ts || !h1) return false;

  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > MAX_TIMESTAMP_AGE_SECONDS) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${ts}:${rawBody}`)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(h1, 'hex');
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  if (!process.env.PADDLE_WEBHOOK_SECRET) {
    console.error('❌ PADDLE_WEBHOOK_SECRET manquant');
    return { statusCode: 500, body: 'Configuration serveur invalide' };
  }

  // Le corps DOIT être utilisé brut (non re-sérialisé) pour que la signature corresponde.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body || '';

  const signatureHeader = event.headers['paddle-signature'] || event.headers['Paddle-Signature'];
  const isValid = verifyPaddleSignature(rawBody, signatureHeader, process.env.PADDLE_WEBHOOK_SECRET);

  if (!isValid) {
    console.error('❌ Signature Paddle invalide ou expirée');
    return { statusCode: 401, body: 'Invalid signature' };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: 'JSON invalide' };
  }

  // On ne traite que les transactions complétées ; les autres événements
  // (created, updated, etc.) sont accusés-réception sans action.
  if (payload.event_type !== 'transaction.completed') {
    return { statusCode: 200, body: 'Événement ignoré (non pertinent)' };
  }

  const transactionId = payload.data?.id;
  const customerEmail = payload.data?.customer?.email || payload.data?.custom_data?.email || null;

  if (!transactionId) {
    console.error('❌ transaction.completed sans id de transaction');
    return { statusCode: 400, body: 'Payload invalide' };
  }

  // Upsert idempotent : si Paddle renvoie le même événement plusieurs fois
  // (garanti "au moins une fois" par leur système), on ne duplique rien et
  // on ne réinitialise pas `used` si la commande a déjà été consommée.
  const { error } = await supabase
    .from('cv_orders')
    .upsert(
      {
        provider: 'paddle',
        provider_transaction_id: transactionId,
        customer_email: customerEmail,
        status: 'completed',
      },
      { onConflict: 'provider,provider_transaction_id', ignoreDuplicates: false }
    );

  if (error) {
    console.error('❌ Erreur écriture Supabase:', error.message);
    // 500 pour que Paddle retente automatiquement cet envoi plus tard
    return { statusCode: 500, body: 'Erreur serveur' };
  }

  return { statusCode: 200, body: 'OK' };
};
