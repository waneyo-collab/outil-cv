const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
const MAX_FIELD_LEN = 1500; // anti-abus : borne la taille de chaque champ texte

// CORS : à restreindre au(x) domaine(s) réel(s) une fois le site en ligne,
// plutôt que '*' (utile si le front-end de l'outil CV n'est pas sur le
// même site que cette fonction, ce qui sera probablement le cas une fois
// dans son propre repo).
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function clean(str) {
  return String(str || '').slice(0, MAX_FIELD_LEN).trim();
}

function buildPrompt(profile) {
  return `Tu es un consultant RH spécialisé dans le marché de l'emploi francophone au Maroc, en France, au Canada et en Afrique francophone. Rédige un CV et une lettre de motivation professionnels, prêts à l'emploi, à partir des informations suivantes.

Informations du candidat :
- Nom : ${clean(profile.nom)}
- Poste visé : ${clean(profile.poste)}
- Pays / marché cible : ${clean(profile.pays)}
- Expériences professionnelles (brut, à reformuler) : ${clean(profile.experiences)}
- Formation : ${clean(profile.formation)}
- Compétences : ${clean(profile.competences)}
- Langues : ${clean(profile.langues)}

Consignes impératives :
- Ton professionnel, phrases courtes, verbes d'action en début de ligne pour chaque expérience.
- Adapte les formules de politesse et la structure aux usages RH du pays cible indiqué (ex : formules d'ouverture/fermeture de lettre différentes entre Maroc, France, Canada).
- N'invente aucune expérience, diplôme ou compétence non mentionnée : reformule et structure uniquement ce qui est fourni.
- N'inclus aucune donnée personnelle sensible (état civil, date de naissance, nationalité, photo) même si absente des informations fournies.
- La lettre de motivation fait 250 à 350 mots, personnalisée au poste visé.

Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ou après, au format exact :
{"cv": {"titre_professionnel": "...", "experiences": [{"poste": "...", "entreprise_periode": "...", "bullets": ["...", "..."]}], "formation": ["..."], "competences": ["..."], "langues": ["..."]}, "lettre_motivation": "texte complet de la lettre"}`;
}

async function callClaude(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const textBlock = data.content?.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Réponse Claude vide');
  return textBlock.text;
}

function parseModelJson(raw) {
  // Retire d'éventuelles balises de code si le modèle en ajoute malgré la consigne
  const cleaned = raw.trim().replace(/^```json\s*|\s*```$/g, '');
  return JSON.parse(cleaned);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'JSON invalide' }) };
  }

  const { provider, transaction_id, profile } = body;
  if (!provider || !['paddle', 'stripe'].includes(provider)) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Moyen de paiement invalide' }) };
  }
  if (!transaction_id || !profile) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Champs manquants' }) };
  }

  // 1. Vérifier la commande : payée et pas encore utilisée
  const { data: order, error: fetchError } = await supabase
    .from('cv_orders')
    .select('id, status, used')
    .eq('provider', provider)
    .eq('provider_transaction_id', transaction_id)
    .maybeSingle();

  if (fetchError || !order) {
    return { statusCode: 402, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Commande introuvable' }) };
  }
  if (order.status !== 'completed') {
    return { statusCode: 402, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Paiement non confirmé' }) };
  }
  if (order.used) {
    return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Commande déjà utilisée' }) };
  }

  // 2. Marquer comme utilisée AVANT l'appel IA — avec vérification que
  //    CETTE requête a bien remporté le verrou. .select('id') est
  //    indispensable ici : sans lui, Supabase ne renvoie aucune erreur
  //    même si l'UPDATE n'a modifié aucune ligne (ex. double-clic ou
  //    requête concurrente ayant déjà pris le verrou), et le code
  //    continuerait à tort vers une 2e génération.
  const { data: lockedRows, error: lockError } = await supabase
    .from('cv_orders')
    .update({ used: true })
    .eq('id', order.id)
    .eq('used', false)
    .select('id');

  if (lockError) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Erreur verrouillage commande' }) };
  }
  if (!lockedRows || lockedRows.length === 0) {
    // Une autre requête a déjà remporté le verrou entre-temps
    return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Commande déjà utilisée' }) };
  }

  // 3. Génération
  try {
    const prompt = buildPrompt(profile);
    const raw = await callClaude(prompt);
    const result = parseModelJson(raw);
    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(result) };
  } catch (err) {
    console.error('Erreur génération:', err.message);
    // On ne redonne pas le crédit automatiquement : cas rare, à traiter manuellement (email client)
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Erreur de génération, contactez le support.' }) };
  }
};
