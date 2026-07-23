export const config = { api: { bodyParser: true } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { brand, keywords: rawKeywords, competitors, rawData } = body;
  if (!brand || !rawData) return res.status(400).json({ error: 'Brand and rawData required' });
  // Sanitize keywords
  const keywords = rawKeywords
    ? rawKeywords.replace(/[^a-zA-Z0-9,\s]/g, '').split(/[,\s]+/).filter(Boolean).join(', ')
    : '';

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'API key not configured' });

  const context = [
    'BRAND: ' + brand,
    'KEYWORDS: ' + (keywords || 'all'),
    'COMPETITORS: ' + (competitors || []).join(', '),
    'CONSUMER LANGUAGE: ' + (rawData.mainReddit || 'None'),
    'PAIN POINTS DATA: ' + (rawData.mainComments || 'None'),
    'COMPETITOR DATA: ' + (rawData.compReddit || 'None')
  ].join('\n');

  const negativeHookFrameworks = 'Do not buy BRAND until you see this | BRAND this is not okay | Is BRAND a scam | I cant believe BRAND did this | What BRAND wont tell you | I regret buying BRAND | Did BRAND lie to me | I am returning my order from BRAND | Exposing BRAND for X | I cant believe what BRAND put in their PRODUCT';
  const curiosityHookFrameworks = 'I am so pissed no one told me about PRODUCT | I did X and this is what happened | What you need to know before X | Why popular belief is BS | This PRODUCT is so good it should be illegal | I probably should not be showing you this | Most PERSONA have no clue this exists | Here is what they dont tell you about TOPIC | Dont do X until you watch this | I wish I tried this sooner | If nobody else is going to tell you I will';
  const personaHookFrameworks = 'PERSONA are losing it over PRODUCT | PERSONA are raving about PRODUCT | Why PERSONA is switching to PRODUCT | This is what PAIN POINT looks like for PERSONA | The best PRODUCT for PERSONA';

  const systemPromptLines = [
    'You are a DTC ad strategist. Analyze brand and competitor data. Use real consumer language. Be specific. Never vague.',
    '',
    'PERSONA RULES: Write personas that match the actual target customer for this brand. BANNED WORDS: journey, empowered, confident, thriving, balance, self-care, 2pm slump, overwhelmed, juggling, seamlessly, unlock, transform, elevate, lifestyle.',
    '',
    'GENDER RULE: Personas must match the actual target customer gender for this brand. A mens health brand gets male personas with why he buys. A womens brand gets female personas with why she buys. A unisex brand gets mixed. Infer correct gender from brand name and product category.',
    '',
    'CRITICAL HOOK RULE: Never mention competitor names in any hook. Hooks must stand alone without referencing other brands.',
    '',
    'Return ONLY a raw JSON object. No markdown. No backticks. No explanation. Start your response with { and end with }.'
  ];
  const systemPrompt = systemPromptLines.join('\n');

  const jsonSchema = [
    '{',
    '  "topHeadlines": ["5 specific hooks for this brand"],',
    '  "painPoints": ["5 pain points in exact consumer language"],',
    '  "valueProps": ["5 value props with specific mechanism"],',
    '  "topTopics": ["5 content topics resonating now"],',
    '  "topKeywords": ["12 exact consumer words"],',
    '  "hookPatterns": ["3 hook structures with full example lines"],',
    '  "redditInsights": ["6 direct consumer quotes or close paraphrases"],',
    '  "competitorAngles": ["5 angles competitors are running"],',
    '  "competitorAdaptations": ["5 competitor angles that could work for this brand"],',
    '  "competitorKeywords": ["10 keywords competitors target"],',
    '  "competitorGaps": ["5 untapped angles this brand could own"],',
    '  "personas": [',
    '    {"type":"proven","identity":"4-6 words who they are","description":"2 sentences their daily life","why_they_buy":"specific moment they try this use correct gender pronoun","hook":"first ad line max 12 words","angle":"how product fits their life","redditQuote":"real consumer quote"},',
    '    {"type":"proven","identity":"...","description":"...","why_they_buy":"...","hook":"...","angle":"...","redditQuote":"..."},',
    '    {"type":"proven","identity":"...","description":"...","why_they_buy":"...","hook":"...","angle":"...","redditQuote":"..."},',
    '    {"type":"whitespace","identity":"underserved customer","description":"their life why ads miss them","why_they_buy":"specific trigger","hook":"hook for them","angle":"why untapped","redditQuote":""},',
    '    {"type":"whitespace","identity":"...","description":"...","why_they_buy":"...","hook":"...","angle":"...","redditQuote":""}',
    '  ],',
    '  "hooksNegative": ["5 negative hooks for this brand. Fill all blanks with brand-specific language. NEVER mention competitor names."],',
    '  "hooksCuriosity": ["5 curiosity hooks for this brand. Fill all blanks. NEVER mention competitor names."],',
    '  "hooksPersona": ["5 persona hooks for this brand. Fill all blanks. NEVER mention competitor names."],',
    '  "hooksTrending": ["[Confession] hook", "[POV] hook", "[Reaction] hook", "[Before After] hook", "[List] hook"],',
    '  "scriptRecommendation": "Single highest-leverage script angle. 3 sentences max."',
    '}'
  ].join('\n');

  const userMessage = 'Brand: ' + brand + '\n\nData:\n' + context + '\n\nNegative hook frameworks: ' + negativeHookFrameworks + '\nCuriosity hook frameworks: ' + curiosityHookFrameworks + '\nPersona hook frameworks: ' + personaHookFrameworks + '\n\nReturn this exact JSON structure with real data:\n' + jsonSchema;

  try {
    if (typeof brand !== 'string') return res.status(400).json({ error: 'Invalid brand' });
    if (typeof rawData !== 'object') return res.status(400).json({ error: 'Invalid rawData' });

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
    if (analysisData.error) {
      return res.status(500).json({ error: 'Anthropic error: ' + JSON.stringify(analysisData.error) });
    }

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
    return res.status(500).json({
      error: String(err.message || err),
      stack: err.stack ? err.stack.slice(0, 300) : 'no stack'
    });
  }
}
