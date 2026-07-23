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

  try {
    // Step 1: Get competitors fast using Haiku
    let competitorList = [];
    try {
      const compRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 80,
          messages: [{ role: 'user', content: `Top 4 direct competitors to "${brand}" in ${keywords || 'DTC apparel'}. Return JSON array only. No text.` }]
        })
      });
      const cd = await compRes.json();
      const ct = cd.content?.map(b => b.text || '').join('') || '[]';
      const cleanCt = ct.replace(/```json/g, '').replace(/```/g, '').trim();
      const fb = cleanCt.indexOf('[');
      const lb = cleanCt.lastIndexOf(']');
      competitorList = fb !== -1 && lb !== -1 
        ? JSON.parse(cleanCt.slice(fb, lb + 1))
        : JSON.parse(cleanCt);
    } catch { competitorList = []; }

    // Step 2: All data fetches in parallel
    const urls = [
      `https://www.reddit.com/search.json?q=${encodeURIComponent(brand + ' review OR honest OR hate OR love')}&sort=relevance&limit=10&type=link`,
      `https://www.reddit.com/search.json?q=${encodeURIComponent(brand)}&sort=top&limit=8&type=comment`,
      `https://www.reddit.com/search.json?q=${encodeURIComponent(brand + ' ' + (keywords||'') + ' honest review')}&sort=new&limit=6&type=link`,
      ...competitorList.slice(0, 3).map(c =>
        `https://www.reddit.com/search.json?q=${encodeURIComponent(c + ' review OR complaint OR honest')}&sort=relevance&limit=4&type=link`
      )
    ];

    const results = await Promise.allSettled(
      urls.map(url => fetch(url, {
        headers: { 'User-Agent': 'InteliAds/1.0 research tool', 'Accept': 'application/json' }
      }))
    );

    const extractText = async (r) => {
      if (r?.status !== 'fulfilled' || !r.value.ok) return '';
      const t = await r.value.text();
      return t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000);
    };

    const extractReddit = async (r) => {
      if (r?.status !== 'fulfilled' || !r.value.ok) return '';
      try {
        const d = await r.value.json();
        return (d?.data?.children || []).map(p => `"${p.data.title}" ${(p.data.selftext||'').slice(0,120)}`).join('\n');
      } catch { return ''; }
    };

    const mainReddit = await extractReddit(results[0]);
    const mainComments = await extractReddit(results[1]);
    const mainReddit2 = await extractReddit(results[2]);
    
    let compReddit = '';
    for (let i = 0; i < competitorList.slice(0,3).length; i++) {
      const r = await extractReddit(results[3 + i]);
      if (r) compReddit += `\n=== ${competitorList[i]} ===\n${r}`;
    }

    const combinedReddit = [mainReddit, mainReddit2].filter(Boolean).join('\n');

    return res.status(200).json({
      success: true,
      competitors: competitorList,
      rawData: {
        mainMeta: '',
        mainReddit: combinedReddit.slice(0, 2000),
        mainComments: mainComments.slice(0, 800),
        compReddit: compReddit.slice(0, 1500)
      }
    });

  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
