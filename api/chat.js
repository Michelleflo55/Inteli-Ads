export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Vercel environment variables.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: body.model || 'claude-sonnet-4-6',
        max_tokens: body.max_tokens || 1000,
        system: body.system || '',
        messages: body.messages || []
      })
    });

    const rawText = await anthropicRes.text();

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return res.status(500).json({ error: 'Anthropic returned non-JSON', preview: rawText.slice(0, 300) });
    }

    return res.status(anthropicRes.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
