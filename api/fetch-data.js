export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { brand, keywords } = body;
  if (!brand) return res.status(400).json({ error: 'Brand required' });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  // Detect competitors using Haiku
  let competitorList = [];
  try {
    const compRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'List top 4 direct competitors to "' + brand + '" in ' + (keywords || 'DTC') + ' space. Return only a JSON array like ["Brand1","Brand2","Brand3","Brand4"]. No other text.' }]
      })
    });
    const cd = await compRes.json();
    const ct = (cd.content?.map(b => b.text || '').join('') || '[]').replace(/```json/g,'').replace(/```/g,'').trim();
    const fb = ct.indexOf('[');
    const lb = ct.lastIndexOf(']');
    if (fb !== -1 && lb !== -1) competitorList = JSON.parse(ct.slice(fb, lb + 1));
  } catch { competitorList = []; }

  // Use Claude's knowledge to gather brand intelligence since Reddit/Meta block server requests
  // This gives us richer, more accurate data than scraped HTML anyway
  try {
    const knowledgeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ 
          role: 'user', 
          content: 'You have deep knowledge of consumer brands and what real customers say about them online on Reddit, Trustpilot, and social media.\n\nBrand: ' + brand + '\nProduct focus: ' + (keywords || 'all products') + '\nCompetitors: ' + competitorList.join(', ') + '\n\nProvide real consumer intelligence in this exact format (raw text, no JSON):\n\nREDDIT_POSTS: [5-8 things real people say about ' + brand + ' on Reddit. Direct quotes or very close paraphrases. The kind of raw honest language people use when reviewing products online.]\n\nREDDIT_COMMENTS: [5-8 short comments real customers leave. Include both positive and negative. Very specific.]\n\nCOMPETITOR_DATA: [What real people say about ' + competitorList.join(', ') + ' vs ' + brand + '. Specific comparisons people make online.]'
        }]
      })
    });

    const kd = await knowledgeRes.json();
    const knowledgeText = kd.content?.map(b => b.text || '').join('') || '';

    const extractSection = (text, label) => {
      const idx = text.indexOf(label + ':');
      if (idx === -1) return '';
      const start = idx + label.length + 1;
      const nextLabel = text.indexOf('\n\n', start);
      return (nextLabel !== -1 ? text.slice(start, nextLabel) : text.slice(start)).trim();
    };

    return res.status(200).json({
      success: true,
      competitors: competitorList,
      rawData: {
        mainMeta: '',
        mainReddit: extractSection(knowledgeText, 'REDDIT_POSTS').slice(0, 2000),
        mainComments: extractSection(knowledgeText, 'REDDIT_COMMENTS').slice(0, 800),
        compReddit: extractSection(knowledgeText, 'COMPETITOR_DATA').slice(0, 1500)
      }
    });

  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
