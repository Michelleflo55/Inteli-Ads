export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { brand, keywords } = body;

  if (!brand) return res.status(400).json({ error: 'Brand name required' });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const keywordList = keywords ? keywords.split(',').map(k => k.trim()).filter(Boolean) : [];

    // STEP 1: Ask Claude who the top competitors are
    const competitorRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `What are the top 4 direct competitors to the brand "${brand}" in the ${keywords || 'DTC apparel/intimates'} space? Return only a JSON array of brand names, nothing else. Example: ["Brand A", "Brand B", "Brand C", "Brand D"]. Only return brands that actually exist and compete directly.`
        }]
      })
    });

    const compData = await competitorRes.json();
    const compText = compData.content?.map(b => b.text || '').join('') || '[]';
    
    let competitorList = [];
    try {
      const clean = compText.replace(/```json|```/g, '').trim();
      competitorList = JSON.parse(clean);
    } catch { competitorList = []; }

    // STEP 2: Run all data fetches in parallel
    const fetchPromises = [
      // Main brand Meta Ads Library
      fetch(`https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=${encodeURIComponent(brand)}&search_type=keyword_unordered&media_type=all`, {
        headers: { 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36', 'Accept': 'text/html' }
      }),
      // Main brand Reddit
      fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(brand + ' review OR experience OR honest OR hate OR love')}&sort=relevance&limit=10&type=link`, {
        headers: { 'User-Agent': 'InteliAds/1.0', 'Accept': 'application/json' }
      }),
      // Main brand Reddit comments
      fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(brand)}&sort=top&limit=8&type=comment`, {
        headers: { 'User-Agent': 'InteliAds/1.0', 'Accept': 'application/json' }
      }),
      // Category Reddit
      fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent((keywordList[0] || brand) + ' review complaint honest')}&sort=relevance&limit=8&type=link`, {
        headers: { 'User-Agent': 'InteliAds/1.0', 'Accept': 'application/json' }
      }),
      // Each competitor: Meta + Reddit
      ...competitorList.slice(0, 4).flatMap(comp => [
        fetch(`https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=${encodeURIComponent(comp)}&search_type=keyword_unordered&media_type=all`, {
          headers: { 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36', 'Accept': 'text/html' }
        }),
        fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(comp + ' review OR complaint OR honest OR bad OR love')}&sort=relevance&limit=6&type=link`, {
          headers: { 'User-Agent': 'InteliAds/1.0', 'Accept': 'application/json' }
        })
      ])
    ];

    const results = await Promise.allSettled(fetchPromises);

    const extractText = (html) => html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1500);

    const extractReddit = async (result) => {
      if (result?.status !== 'fulfilled' || !result.value.ok) return '';
      try {
        const data = await result.value.json();
        return (data?.data?.children || [])
          .map(p => `"${p.data.title || ''}" ${(p.data.selftext || '').slice(0, 200)}`)
          .join('\n');
      } catch { return ''; }
    };

    // Main brand data
    let mainMetaText = '';
    if (results[0]?.status === 'fulfilled' && results[0].value.ok) {
      mainMetaText = extractText(await results[0].value.text());
    }
    const mainRedditPosts = await extractReddit(results[1]);
    const mainRedditComments = await extractReddit(results[2]);
    const categoryReddit = await extractReddit(results[3]);

    // Competitor data
    let competitorData = '';
    for (let i = 0; i < competitorList.slice(0, 4).length; i++) {
      const comp = competitorList[i];
      const baseIdx = 4 + (i * 2);
      let compMeta = '';
      if (results[baseIdx]?.status === 'fulfilled' && results[baseIdx].value.ok) {
        compMeta = extractText(await results[baseIdx].value.text());
      }
      const compReddit = await extractReddit(results[baseIdx + 1]);
      competitorData += `\n=== ${comp} ===\nMETA ADS: ${compMeta || 'No data'}\nREDDIT: ${compReddit || 'No data'}\n`;
    }

    const fullContext = `
BRAND: ${brand}
AUTO-DETECTED COMPETITORS: ${competitorList.join(', ')}
PRODUCT FOCUS: ${keywords || 'all products'}

BRAND META ADS: ${mainMetaText || 'Limited'}
BRAND REDDIT POSTS: ${mainRedditPosts.slice(0, 1500)}
BRAND REDDIT COMMENTS: ${mainRedditComments.slice(0, 800)}
CATEGORY DISCUSSIONS: ${categoryReddit.slice(0, 800)}
COMPETITOR DATA: ${competitorData.slice(0, 3500)}
`.slice(0, 12000);

    const systemPrompt = `You are a senior DTC ad strategist. You analyze Meta Ads Library data, Reddit consumer discussions, and competitor activity to find creative gaps and opportunities.

Use REAL consumer language from Reddit. Pull exact phrases where possible. Never use marketing language.

Return ONLY valid JSON, no other text:
{
  "detectedCompetitors": ["list the competitors you analyzed"],
  "topHeadlines": ["5 hooks/headlines working or predicted to work for the brand"],
  "painPoints": ["5 pain points in exact consumer language from Reddit. E.g. 'rolls down the second I sit', 'wire digs in marks by lunch'"],
  "valueProps": ["5 value props with specific mechanism. E.g. 'no underwire but holds 36DDD through 10hr shift'"],
  "topTopics": ["5 content topics resonating in this category right now"],
  "topKeywords": ["12 exact words real consumers use. No marketing terms."],
  "hookPatterns": ["3 proven hook structures with full example lines written for this brand"],
  "redditInsights": ["6 direct quotes or very close paraphrases from Reddit. Sound like real people."],
  "competitorAngles": ["5 angles competitors are actively running. Format: '[Competitor]: [specific angle and hook message]'"],
  "competitorComplaints": ["5 specific complaints real people have about competitors that this brand could address. Format: 'People hate that [Competitor] [complaint]. Win here by [specific angle].'"],
  "competitorKeywords": ["10 keywords competitors appear to be targeting"],
  "competitorGaps": ["5 specific untapped angles this brand could own that competitors are missing"],
  "scriptRecommendation": "The single highest-leverage script angle right now. Reference competitor gaps, Reddit language, and the specific opportunity. 3 sentences max. Direct and specific."
}`;

    const analysisRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2500,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Analyze this and return the JSON:\n\n${fullContext}` }]
      })
    });

    const analysisData = await analysisRes.json();
    const analysisText = analysisData.content?.map(b => b.text || '').join('') || '{}';

    let intelligence;
    try {
      const clean = analysisText.replace(/```json|```/g, '').trim();
      intelligence = JSON.parse(clean);
    } catch {
      intelligence = { error: 'Parse failed', raw: analysisText.slice(0, 300) };
    }

    return res.status(200).json({ success: true, brand, detectedCompetitors: competitorList, intelligence });

  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
