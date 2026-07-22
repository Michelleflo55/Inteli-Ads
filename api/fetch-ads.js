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
    // Fetch the Meta Ads Library page for this brand
    const searchUrl = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=${encodeURIComponent(brand)}&search_type=keyword_unordered&media_type=all`;

    const pageRes = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });

    const html = await pageRes.text();

    // Extract any visible text content from the page
    const textContent = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 8000);

    // Use Claude to analyze whatever we got and generate intelligence
    const systemPrompt = `You are an ad intelligence analyst. You analyze Meta Ads Library data and extract creative intelligence for a brand. 

Your job is to analyze whatever content is available and return a JSON object with this exact structure:
{
  "topHeadlines": ["headline 1", "headline 2", "headline 3", "headline 4", "headline 5"],
  "painPoints": ["pain point 1", "pain point 2", "pain point 3", "pain point 4", "pain point 5"],
  "valueProps": ["value prop 1", "value prop 2", "value prop 3", "value prop 4", "value prop 5"],
  "topTopics": ["topic 1", "topic 2", "topic 3", "topic 4", "topic 5"],
  "topKeywords": ["keyword 1", "keyword 2", "keyword 3", "keyword 4", "keyword 5", "keyword 6", "keyword 7", "keyword 8", "keyword 9", "keyword 10"],
  "hookPatterns": ["hook pattern 1", "hook pattern 2", "hook pattern 3"],
  "scriptRecommendation": "A 2-3 sentence recommendation on what angle to script next based on gaps or opportunities you see."
}

If the page content doesn't have enough ad data, use your training knowledge about the brand to fill in likely patterns based on the brand name and any keywords provided. Always return valid JSON only, no other text.`;

    const userMessage = `Brand: ${brand}
Keywords to focus on: ${keywords || 'all products'}
Page content extracted from Meta Ads Library: ${textContent}

Analyze this and return the JSON intelligence object.`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
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
      intelligence = { error: 'Could not parse intelligence', raw: claudeText.slice(0, 200) };
    }

    return res.status(200).json({ success: true, brand, intelligence });

  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
