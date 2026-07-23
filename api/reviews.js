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

  const keywords = rawKeywords
    ? rawKeywords.replace(/[^a-zA-Z0-9,\s]/g, '').split(/[,\s]+/).filter(Boolean).join(', ')
    : '';

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'API key not configured' });

  const systemPromptLines = [
    'You are a consumer research analyst. Your job is to search the web for REAL customer reviews of this brand and extract actual quotes and insights.',
    '',
    'SEARCH STRATEGY:',
    '- Search for reviews on Trustpilot, Reddit, YouTube comments, and Google reviews',
    '- Look for honest, unfiltered customer experiences - both positive and negative',
    '- Find real quotes people have written, not summaries',
    '- Search multiple sources to get a complete picture',
    '',
    'CRITICAL RULES:',
    '- Only use real quotes you actually find in search results',
    '- Write consumer language the way real customers actually write it',
    '- Never fabricate or paraphrase beyond what was actually said',
    '- If a source has no data, note it and move on',
    '- Return ONLY a raw JSON object. No markdown. No backticks. Start with { end with }.'
  ];

  const jsonSchema = [
    '{',
    '  "totalReviewsFound": <number of actual reviews found>,',
    '  "sourcesFound": ["list actual sources where you found reviews"],',
    '  "problemAware": {',
    '    "label": "Problem Aware",',
    '    "description": "They knew something was wrong but did not know a fix existed",',
    '    "reviews": ["real quotes from people who had the problem before finding this brand"],',
    '    "hookOpportunity": "specific hook angle this group opens up"',
    '  },',
    '  "solutionAware": {',
    '    "label": "Solution Aware",',
    '    "description": "Tried other solutions, kept getting burned",',
    '    "reviews": ["real quotes showing frustration with alternatives"],',
    '    "hookOpportunity": "specific hook angle"',
    '  },',
    '  "brandAware": {',
    '    "label": "Brand Aware",',
    '    "description": "Knew the brand, finally tried it",',
    '    "reviews": ["real quotes about first impressions and what made them finally try it"],',
    '    "hookOpportunity": "specific hook angle"',
    '  },',
    '  "mostAware": {',
    '    "label": "Most Aware",',
    '    "description": "Loyal customers with specific results",',
    '    "reviews": ["real quotes with specific results, numbers, time frames"],',
    '    "hookOpportunity": "specific hook angle"',
    '  },',
    '  "topQuotesForScripting": ["8-10 most powerful real quotes a scriptwriter should steal directly"],',
    '  "recurringLanguage": ["12 exact words and phrases that appear repeatedly across reviews"],',
    '  "unexpectedInsights": ["4-5 things customers genuinely care about that the brand is NOT currently saying in ads"]',
    '}'
  ].join('\n');

  const userMessage = 'Search the web for real customer reviews of ' + brand + (keywords ? ' specifically about ' + keywords : '') + '. Look on Trustpilot, Reddit (search r/ communities), YouTube review videos, and Google reviews. Find actual quotes from real customers. Then organize everything you find into this exact JSON structure:\n\n' + jsonSchema;

  try {
    const reviewRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: systemPromptLines.join('\n'),
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    const reviewData = await reviewRes.json();
    if (reviewData.error) {
      return res.status(500).json({ error: 'Anthropic error: ' + JSON.stringify(reviewData.error) });
    }

    // Extract the final text response after web search tool use
    const allContent = reviewData.content || [];
    const textBlocks = allContent.filter(b => b.type === 'text');
    const reviewText = textBlocks.map(b => b.text || '').join('') || '{}';

    let reviews;
    try {
      const cleaned = reviewText.replace(/```json/gi, '').replace(/```/g, '').trim();
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        reviews = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } else {
        reviews = JSON.parse(cleaned);
      }
    } catch(e) {
      reviews = { error: 'Parse failed: ' + e.message, raw: reviewText.slice(0, 500) };
    }

    return res.status(200).json({ success: true, brand, reviews });

  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
