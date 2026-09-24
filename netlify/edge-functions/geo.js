// Edge Function Netlify (runtime Deno) — même principe que /api/geo sur
// app.waneyo-formation.com : utilise le contexte géo natif fourni par
// Netlify (déduit de l'IP côté edge), sans appeler de service externe.
export default async (request, context) => {
  const country = context.geo?.country?.code || null;
  return new Response(JSON.stringify({ country }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};
