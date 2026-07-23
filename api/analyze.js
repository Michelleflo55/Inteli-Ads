export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { brand, keywords, competitors, rawData } = body;
  if (!brand || !rawData) return res.status(400).json({ error: 'Brand and rawData required' });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'API key not configured' });

  const context = [
    'BRAND: ' + brand,
    'KEYWORDS: ' + (keywords || 'all'),
    'COMPETITORS: ' + (competitors || []).join(', '),
    'REDDIT POSTS: ' + (rawData.mainReddit || 'None'),
    'REDDIT COMMENTS: ' + (rawData.mainComments || 'None'),
    'COMPETITOR DATA: ' + (rawData.compReddit || 'None')
  ].join('\n');

  const negativeHookFrameworks = 'Do not buy BRAND until you see this | BRAND this is not okay | Is BRAND a scam | I cant believe BRAND did this | What BRAND wont tell you | I regret buying BRAND | Did BRAND lie to me | I am returning my order from BRAND | Exposing BRAND for X | I cant believe what BRAND put in their PRODUCT';
  
  const curiosityHookFrameworks = 'I am so pissed no one told me about PRODUCT | I did X and this is what happened | What you need to know before X | Why popular belief is BS | This PRODUCT is so good it should be illegal | I probably should not be showing you this | Most PERSONA have no clue this exists | Here is what they dont tell you about TOPIC | Dont do X until you watch this | I wish I tried this sooner | If nobody else is going to tell you I will';

  const personaHookFrameworks = 'PERSONA are losing it over PRODUCT | PERSONA are raving about PRODUCT | Why PERSONA is switching to PRODUCT | This is what PAIN POINT looks like for PERSONA | The best PRODUCT for PERSONA';

  const systemPrompt = 'You are a DTC ad strategist. Analyze brand and competitor data. Use real Reddit language. Be specific. Never vague.\n\nPERSONA RULES: Write personas like a real woman you know personally. BANNED: journey, empowered, confident, thriving, balance, self-care, 2pm slump, overwhelmed, juggling, seamlessly, unlock, transform, elevate, lifestyle.\n\nReturn ONLY a raw JSON object. No markdown. No backticks. No explanation. Start your response with { and end with }.';

  const userMessage = 'Brand: ' + brand + '\nData:\n' + context + '\n\nNegative hook frameworks: ' + negativeHookFrameworks + '\nCuriosity hook frameworks: ' + curiosityHookFrameworks + '\nPersona hook frameworks: ' + personaHookFrameworks + '\n\nReturn this exact JSON structure with real data filled in:\n{\n  "topHeadlines": ["5 specific hooks for this brand"],\n  "painPoints": ["5 pain points in exact Reddit language"],\n  "valueProps": ["5 value props with specific mechanism"],\n  "topTopics": ["5 content topics resonating now"],\n  "topKeywords": ["12 exact consumer words"],\n  "hookPatterns": ["3 hook structures with full example lines"],\n  "redditInsights": ["6 direct Reddit quotes or close paraphrases"],\n  "competitorAngles": ["5 angles competitors are running"],\n  "competitorAdaptations": ["5 competitor angles that could work for this brand"],\n  "competitorKeywords": ["10 keywords competitors target"],\n  "competitorGaps": ["5 untapped angles this brand could own"],\n  "personas": [\n    {"type":"proven","identity":"4-6 words who she is","description":"2 sentences her daily life","why_she_buys":"specific moment she tries this","hook":"first ad line max 12 words","angle":"how product fits her life","redditQuote":"real reddit quote"},\n    {"type":"proven","identity":"...","description":"...","why_she_buys":"...","hook":"...","angle":"...","redditQuote":"..."},\n    {"type":"proven","identity":"...","description":"...","why_she_buys":"...","hook":"...","angle":"...","redditQuote":"..."},\n    {"type":"whitespace","identity":"underserved woman","description":"her life why ads miss her","why_she_buys":"specific trigger","hook":"hook for her","angle":"why untapped","redditQuote":""},\n    {"type":"whitespace","identity":"...","description":"...","why_she_buys":"...","hook":"...","angle":"...","redditQuote":""}\n  ],\n  "hooksNegative": ["5 negative hooks filled in for this brand. Use the negative frameworks. Fill all blanks with brand-specific language."],\n  "hooksCuriosity": ["5 curiosity hooks filled in for this brand. Use curiosity frameworks. Fill all blanks."],\n  "hooksPersona": ["5 persona hooks filled in for this brand. Use persona frameworks. Fill all blanks."],\n  "hooksTrending": ["[Confession] example hook", "[POV] example hook", "[Reaction] example hook", "[Before After] example hook", "[List] example hook"],\n  "scriptRecommendation": "Single highest-leverage script angle. 3 sentences max."\n}';

  try {
    const analysisRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    const analysisData = await analysisRes.json();
    const analysisText = analysisData.content?.map(b => b.text || '').join('') || '{}';

    let intelligence;
    try {
      const cleaned = analysisText.replace(/```json/gi, '').replace(/```/g, '').trim();
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1) {
        intelligence = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } else {
        intelligence = JSON.parse(cleaned);
      }
    } catch(e) {
      intelligence = { error: 'Parse failed: ' + e.message, raw: analysisText.slice(0, 500) };
    }

    return res.status(200).json({ success: true, brand, competitors, intelligence });

  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
