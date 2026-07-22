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
    // Run Meta Ads Library fetch and Reddit searches in parallel
    const keywordList = keywords ? keywords.split(',').map(k => k.trim()) : [brand];
    const searchTerms = [brand, ...keywordList].slice(0, 3);

    const [metaRes, ...redditResults] = await Promise.allSettled([
      // Meta Ads Library
      fetch(`https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=${encodeURIComponent(brand)}&search_type=keyword_unordered&media_type=all`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      }),
      // Reddit searches for brand + keywords
      ...searchTerms.map(term =>
        fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(term + ' review OR honest OR hate OR love OR uncomfortable OR fit')}&sort=relevance&limit=10&type=link`, {
          headers: {
            'User-Agent': 'InteliAds/1.0 (ad intelligence research tool)',
            'Accept': 'application/json'
          }
        })
      )
    ]);

    // Extract Meta content
    let metaContent = '';
    if (metaRes.status === 'fulfilled' && metaRes.value.ok) {
      const html = await metaRes.value.text();
      metaContent = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 3000);
    }

    // Extract Reddit content
    let redditContent = '';
    for (const result of redditResults) {
      if (result.status === 'fulfilled' && result.value.ok) {
        try {
          const data = await result.value.json();
          const posts = data?.data?.children || [];
          const postTexts = posts.map(p => {
            const d = p.data;
            return `TITLE: ${d.title || ''} | SELFTEXT: ${(d.selftext || '').slice(0, 300)} | SUBREDDIT: r/${d.subreddit || ''}`;
          }).join('\n');
          redditContent += postTexts + '\n';
        } catch {}
      }
    }

    // Also fetch top Reddit comments for brand
    let redditComments = '';
    try {
      const commentRes = await fetch(
        `https://www.reddit.com/search.json?q=${encodeURIComponent(brand)}&sort=top&limit=5&type=comment`,
        { headers: { 'User-Agent': 'InteliAds/1.0', 'Accept': 'application/json' } }
      );
      if (commentRes.ok) {
        const commentData = await commentRes.json();
        const comments = commentData?.data?.children || [];
        redditComments = comments.map(c => c.data?.body || '').filter(Boolean).join('\n').slice(0, 2000);
      }
    } catch {}

    // Build the full context for Claude
    const fullContext = `
META ADS LIBRARY DATA:
${metaContent || 'Limited data available from Meta Ads Library.'}

REDDIT POSTS AND DISCUSSIONS:
${redditContent || 'No Reddit posts found.'}

REDDIT COMMENTS FROM REAL USERS:
${redditComments || 'No Reddit comments found.'}
`.slice(0, 10000);

    const systemPrompt = `You are an ad intelligence analyst specializing in DTC consumer brands. You analyze real consumer language from Reddit, social media, and ad data to extract authentic creative intelligence.

Your job is to find the RAW, UNFILTERED language real people use when talking about this product category. Not marketing language. The exact words real customers type when they're frustrated, happy, or honest.

Return ONLY a valid JSON object with this exact structure, no other text:
{
  "topHeadlines": ["5 specific ad headlines or hooks you detected or would predict based on data"],
  "painPoints": ["5 specific pain points in real customer language, e.g. 'rolls down by noon', 'wire digs in after 2 hours', not generic phrases"],
  "valueProps": ["5 specific value props with mechanism, e.g. 'no underwire but holds size 36DDD', not just 'comfortable'"],
  "topTopics": ["5 content topics that are resonating, e.g. 'postpartum body changes', 'wedding shapewear panic', 'first time trying shapewear'"],
  "topKeywords": ["10 exact words and phrases real people use in Reddit posts and reviews, not marketing terms"],
  "hookPatterns": ["3 specific hook structures working right now with example wording"],
  "redditInsights": ["3-5 direct quotes or paraphrases of real things people said on Reddit about this brand or category"],
  "scriptRecommendation": "2-3 sentences on the highest opportunity script angle based on what real people are saying vs what ads are currently doing. Be specific about the gap."
}`;

    const userMessage = `Brand: ${brand}
Keywords/products to focus on: ${keywords || 'all products'}

Here is all the data gathered:
${fullContext}

Extract the real consumer language and intelligence. Focus especially on Reddit data since that's where people are most honest. Return the JSON object.`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    const claudeData = await claudeRes.json();
    const claudeText = claudeData.content?.map(b => b.text || '').join('') || '{}';

    let intelligence;
    try {
      const clean = claudeText.replace(/```json|```/g, '').trim();
      intelligence = JSON.parse(clean);
    } catch {
      intelligence = { error: 'Parse failed', raw: claudeText.slice(0, 300) };
    }

    return res.status(200).json({ success: true, brand, intelligence });

  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
