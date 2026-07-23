export const config = { api: { bodyParser: true, externalResolver: true } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { brand, keywords, competitors: providedCompetitors } = body;

  if (!brand) return res.status(400).json({ error: 'Brand name required' });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const keywordList = keywords ? keywords.split(',').map(k => k.trim()).filter(Boolean) : [];

  // Use provided competitors or detect them
  let competitorList = providedCompetitors || [];

  try {
    // If no competitors provided, detect them quickly
    if (!competitorList.length) {
      const compRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 100,
          messages: [{ role: 'user', content: `List the top 4 direct competitors to "${brand}" in the ${keywords || 'DTC apparel'} space. Return only a JSON array of brand names. No other text.` }]
        })
      });
      const compData = await compRes.json();
      const compText = compData.content?.map(b => b.text || '').join('') || '[]';
      try { competitorList = JSON.parse(compText.replace(/```json|```/g, '').trim()); } catch { competitorList = []; }
    }

    // Run all data fetches in parallel
    const fetchPromises = [
      fetch(`https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=${encodeURIComponent(brand)}&search_type=keyword_unordered&media_type=all`, {
        headers: { 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36', 'Accept': 'text/html' }
      }),
      fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(brand + ' review OR honest OR hate OR love')}&sort=relevance&limit=8&type=link`, {
        headers: { 'User-Agent': 'InteliAds/1.0', 'Accept': 'application/json' }
      }),
      fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(brand)}&sort=top&limit=6&type=comment`, {
        headers: { 'User-Agent': 'InteliAds/1.0', 'Accept': 'application/json' }
      }),
      ...competitorList.slice(0, 4).flatMap(comp => [
        fetch(`https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=${encodeURIComponent(comp)}&search_type=keyword_unordered&media_type=all`, {
          headers: { 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36', 'Accept': 'text/html' }
        }),
        fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(comp + ' review OR complaint OR honest')}&sort=relevance&limit=5&type=link`, {
          headers: { 'User-Agent': 'InteliAds/1.0', 'Accept': 'application/json' }
        })
      ])
    ];

    const results = await Promise.allSettled(fetchPromises);

    const extractText = async (result) => {
      if (result?.status !== 'fulfilled' || !result.value.ok) return '';
      const html = await result.value.text();
      return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
    };

    const extractReddit = async (result) => {
      if (result?.status !== 'fulfilled' || !result.value.ok) return '';
      try {
        const data = await result.value.json();
        return (data?.data?.children || []).map(p => `"${p.data.title}" ${(p.data.selftext || '').slice(0, 150)}`).join('\n');
      } catch { return ''; }
    };

    const mainMeta = await extractText(results[0]);
    const mainReddit = await extractReddit(results[1]);
    const mainComments = await extractReddit(results[2]);

    let compData = '';
    for (let i = 0; i < competitorList.slice(0, 4).length; i++) {
      const comp = competitorList[i];
      const base = 3 + (i * 2);
      const compMeta = await extractText(results[base]);
      const compReddit = await extractReddit(results[base + 1]);
      compData += `\n=== ${comp} ===\nMETA: ${compMeta || 'No data'}\nREDDIT: ${compReddit || 'No data'}\n`;
    }

    const context = `BRAND: ${brand} | KEYWORDS: ${keywords || 'all'} | COMPETITORS: ${competitorList.join(', ')}
BRAND META: ${mainMeta || 'Limited'} | BRAND REDDIT: ${mainReddit.slice(0, 1200)} | COMMENTS: ${mainComments.slice(0, 600)}
COMPETITOR DATA: ${compData.slice(0, 3000)}`.slice(0, 9000);

    const analysisRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: `You are a DTC ad strategist. Analyze brand and competitor data. Use real consumer language from Reddit. Return ONLY valid JSON:
{
  "topHeadlines": ["5 hooks/headlines for the brand"],
  "painPoints": ["5 pain points in exact Reddit consumer language"],
  "valueProps": ["5 value props with specific mechanism"],
  "topTopics": ["5 content topics resonating now"],
  "topKeywords": ["12 exact words real consumers use"],
  "hookPatterns": ["3 hook structures with full example lines for this brand"],
  "redditInsights": ["6 direct quotes or close paraphrases from Reddit"],
  "competitorAngles": ["5 angles competitors are running. Format: '[Competitor]: [angle and hook]'"],
  "competitorAdaptations": ["5 specific angles working for competitors that could be adapted for this brand. Format: '[Competitor] wins with [angle]. Adapt for this brand by [specific execution].'"]],
  "competitorKeywords": ["10 keywords competitors are targeting"],
  "competitorGaps": ["5 untapped angles this brand could own that competitors are missing"],
  "scriptRecommendation": "Single highest-leverage script angle. Reference Reddit language and competitor gap. 3 sentences max."
}`,
        messages: [{ role: 'user', content: `Analyze:\n${context}` }]
      })
    });

    const analysisData = await analysisRes.json();
    const analysisText = analysisData.content?.map(b => b.text || '').join('') || '{}';

    let intelligence;
    try {
      intelligence = JSON.parse(analysisText.replace(/```json|```/g, '').trim());
    } catch {
      intelligence = { error: 'Parse failed', raw: analysisText.slice(0, 300) };
    }

    return res.status(200).json({ success: true, brand, detectedCompetitors: competitorList, intelligence });

  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
