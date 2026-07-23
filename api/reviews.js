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
  if (!anthropicKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    // Fetch reviews from multiple public sources in parallel
    const searchQueries = [
      `${brand} reviews site:trustpilot.com`,
      `${brand} ${keywords || ''} review`,
      `${brand} reviews`,
      `"${brand}" review ${keywords || ''}`,
      `${brand} ${keywords || ''} honest review`,
    ];

    const fetchPromises = [
      // Trustpilot
      fetch(`https://www.trustpilot.com/search?query=${encodeURIComponent(brand)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html' }
      }),
      // Reddit reviews
      fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent(brand + ' review')}&sort=top&limit=10&type=link`, {
        headers: { 'User-Agent': 'InteliAds/1.0', 'Accept': 'application/json' }
      }),
      // Reddit comments specifically about the brand
      fetch(`https://www.reddit.com/search.json?q=${encodeURIComponent('"' + brand + '"')}&sort=top&limit=10&type=comment`, {
        headers: { 'User-Agent': 'InteliAds/1.0', 'Accept': 'application/json' }
      }),
      // Google search results for reviews
      fetch(`https://www.google.com/search?q=${encodeURIComponent(brand + ' reviews ' + (keywords || ''))}&num=10`, {
        headers: { 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html' }
      }),
      // YouTube search for reviews
      fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(brand + ' review ' + (keywords || ''))}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html' }
      })
    ];

    const results = await Promise.allSettled(fetchPromises);

    const extractText = async (result, maxLen = 1500) => {
      if (result?.status !== 'fulfilled' || !result.value.ok) return '';
      try {
        const text = await result.value.text();
        return text
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, maxLen);
      } catch { return ''; }
    };

    const extractReddit = async (result) => {
      if (result?.status !== 'fulfilled' || !result.value.ok) return '';
      try {
        const data = await result.value.json();
        return (data?.data?.children || [])
          .map(p => p.data.body || p.data.selftext || p.data.title || '')
          .filter(t => t.length > 30)
          .join('\n---\n');
      } catch { return ''; }
    };

    const trustpilot = await extractText(results[0]);
    const redditPosts = await extractReddit(results[1]);
    const redditComments = await extractReddit(results[2]);
    const googleResults = await extractText(results[3], 2000);
    const youtubeResults = await extractText(results[4], 1000);

    const rawReviews = `
TRUSTPILOT: ${trustpilot || 'No data'}
REDDIT POSTS: ${redditPosts || 'No data'}
REDDIT COMMENTS: ${redditComments || 'No data'}
GOOGLE RESULTS: ${googleResults || 'No data'}
YOUTUBE: ${youtubeResults || 'No data'}
`.slice(0, 8000);

    // Use Claude to extract and group reviews by persona/awareness
    const analysisRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2500,
        system: `You are a DTC creative strategist analyzing customer reviews to extract real consumer language and group it by persona and awareness level for ad scripting.

Your job is to find real quotes and experiences from customers and organize them strategically so a scriptwriter can pull directly from them.

AWARENESS LEVELS:
- Problem Aware: They know something is wrong but didn't know a fix existed. E.g. "I've always hated how my bra digs in but thought that was just how it was"
- Solution Aware: They know solutions exist but haven't found the right one. E.g. "I've tried every shapewear brand and they all roll down"
- Brand Aware: They know this brand but hadn't tried it yet. E.g. "I kept seeing HoneyLove everywhere so I finally tried it"
- Most Aware: They're customers sharing their experience. E.g. "I've been wearing this for 3 months and it still hasn't rolled once"

Return ONLY valid JSON:
{
  "totalReviewsFound": number,
  "sourcesFound": ["list of sources that had data"],
  "problemAware": {
    "label": "Problem Aware",
    "description": "They knew something was wrong but didn't know a fix existed",
    "reviews": ["5-8 direct quotes or close paraphrases from real reviews that show this awareness level. Must sound like a real person. Include the struggle without the solution."],
    "hookOpportunity": "The specific hook angle this group suggests for scripting"
  },
  "solutionAware": {
    "label": "Solution Aware",
    "description": "They know solutions exist but kept getting burned",
    "reviews": ["5-8 quotes showing they've tried other things and been disappointed"],
    "hookOpportunity": "The specific hook angle this group suggests"
  },
  "brandAware": {
    "label": "Brand Aware",
    "description": "They knew the brand, finally tried it",
    "reviews": ["5-8 quotes about what made them finally try this brand specifically"],
    "hookOpportunity": "The specific hook angle this group suggests"
  },
  "mostAware": {
    "label": "Most Aware",
    "description": "Customers sharing real transformation or ongoing experience",
    "reviews": ["5-8 quotes showing life after using the product. Specific results only, no vague praise."],
    "hookOpportunity": "The specific hook angle this group suggests"
  },
  "topQuotesForScripting": ["8-10 single most powerful quotes across all groups. These are the ones a scriptwriter should steal directly."],
  "recurringLanguage": ["12 exact words and phrases that appear repeatedly across reviews. These are the words consumers naturally use."],
  "unexpectedInsights": ["3-5 things customers say that the brand probably isn't using in its ads yet but should be"]
}`,
        messages: [{ role: 'user', content: `Brand: ${brand}\nKeywords: ${keywords || 'all products'}\n\nRaw data from public sources:\n${rawReviews}\n\nExtract and group the reviews by awareness level. Use real language only.` }]
      })
    });

    const data = await analysisRes.json();
    const text = data.content?.map(b => b.text || '').join('') || '{}';

    let reviews;
    try {
      reviews = JSON.parse(text.replace(/```json|```/g, '').trim());
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      try { reviews = JSON.parse(match[0]); }
      catch { reviews = { error: 'Parse failed', raw: text.slice(0, 300) }; }
    }

    return res.status(200).json({ success: true, brand, reviews });

  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
