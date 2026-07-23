export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { brand, keywords: rawKeywords } = body;
  if (!brand) return res.status(400).json({ error: 'Brand required' });
  // Sanitize keywords - strip special chars, normalize commas
  const keywords = rawKeywords 
    ? rawKeywords.replace(/[^a-zA-Z0-9,\s]/g, '').split(/[,\s]+/).filter(Boolean).join(', ')
    : '';

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
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ 
          role: 'user', 
          content: 'Search Reddit, Trustpilot, and review sites for real consumer language about ' + brand + (keywords ? ' and their ' + keywords + ' products' : '') + '. Also search for what people say about ' + (competitorList.join(', ') || 'competitors in this space') + '. Find actual quotes and recurring complaints or praises. Return a plain text summary with these sections:\n\nCONSUMER_LANGUAGE: Real quotes and language patterns from reviews\n\nPAIN_POINTS: Specific frustrations people mention repeatedly\n\nCOMPETITOR_COMPARISON: What people say when comparing brands in this space'
        }]
      })
    });

    const kd = await knowledgeRes.json();
    if (kd.error) {
      return res.status(500).json({ error: 'Search failed: ' + JSON.stringify(kd.error), competitors: competitorList });
    }
    const knowledgeText = (kd.content || []).filter(b => b.type === 'text').map(b => b.text || '').join('') || '';
    if (!knowledgeText) {
      return res.status(500).json({ error: 'Empty search response', competitors: competitorList });
    }

    // Extract sections
    const getSection = (text, label) => {
      const idx = text.indexOf(label + ':');
      if (idx === -1) return text.slice(0, 1000); // fallback to full text
      const start = idx + label.length + 1;
      const next = text.indexOf('\n\n', start + 50);
      return (next !== -1 ? text.slice(start, next) : text.slice(start)).trim();
    };

    return res.status(200).json({
      success: true,
      competitors: competitorList,
      rawData: {
        mainMeta: '',
        mainReddit: getSection(knowledgeText, 'CONSUMER_LANGUAGE').slice(0, 2000),
        mainComments: getSection(knowledgeText, 'PAIN_POINTS').slice(0, 800),
        compReddit: getSection(knowledgeText, 'COMPETITOR_COMPARISON').slice(0, 1500)
      }
    });

  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
