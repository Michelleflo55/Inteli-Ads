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

  const context = `BRAND: ${brand} | KEYWORDS: ${keywords || 'all'} | COMPETITORS: ${(competitors||[]).join(', ')}
BRAND META ADS: ${rawData.mainMeta || 'Limited'}
BRAND REDDIT: ${rawData.mainReddit || 'None'}
REDDIT COMMENTS: ${rawData.mainComments || 'None'}
COMPETITOR REDDIT: ${rawData.compReddit || 'None'}`;

  const HOOK_FRAMEWORKS = `
NEGATIVE/SKEPTIC: Do not buy [brand]+[product] until you see this | [Brand] this is not okay | Is [brand] a scam? | I can not believe [brand] did this | What [brand] won't tell you | I regret buying [brand] | Did [brand] lie to me? | I am returning my order from [brand] | Exposing [brand] for [specific thing] | I can not believe what [brand] put in their [product]
CURIOSITY: I am so pissed no one told me about [product] | I [action] and this is what happened | What you need to know before [action] | Why [popular belief] is complete BS | This [product] is so good it should be illegal | I probably should not be showing you this but [statement] | Most [persona] have no clue this exists | Here is what they don't tell you about [topic] | Don't [action] until you watch this | I wish I tried this sooner | I wish I knew this before [action] | If nobody else is going to tell you I will
PERSONA: [Persona] are losing it over [product] | [Persona] are raving about [product] | Why [persona] is switching to [product] | This is what [pain point] looks like for [persona] | The best [product] for [persona] | What do you mean [product does this]
TRENDING FORMATS: [Confession] | [POV] | [Reaction] | [Before After] | [List] | Things nobody tells you about [topic] | Rating [products] so you don't have to | Tell me you [x] without telling me you [x]`;

  try {
    const analysisRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: `You are a DTC ad strategist. Analyze brand data and return creative intelligence. Use real Reddit language. Be specific. Never vague.

PERSONA RULES: Write personas like a real woman you know personally. Specific enough she reads it and says "that is literally me". BANNED WORDS: journey, empowered, confident, vibrant, thriving, balance, self-care, busy professional, modern woman, hustle, 2pm slump, overwhelmed, juggling, seamlessly, unlock, transform, elevate, relatable, authentic, resonate, lifestyle, busy mom.

Return ONLY valid JSON, no other text:
{
  "topHeadlines": ["5 specific hooks for this brand"],
  "painPoints": ["5 pain points in exact Reddit language"],
  "valueProps": ["5 value props with specific mechanism"],
  "topTopics": ["5 content topics resonating now"],
  "topKeywords": ["12 exact consumer words, no marketing terms"],
  "hookPatterns": ["3 hook structures with full example lines"],
  "redditInsights": ["6 direct Reddit quotes or close paraphrases"],
  "competitorAngles": ["5 angles competitors are running. Format: [Competitor]: [angle]"],
  "competitorAdaptations": ["5 angles working for competitors that could adapt for this brand"],
  "competitorKeywords": ["10 keywords competitors target"],
  "competitorGaps": ["5 untapped angles this brand could own"],
  "personas": [
    {"type":"proven","identity":"4-6 words. Real. E.g. The Burnt Out Mom","description":"2 sentences. Her actual life. Specific.","why_she_buys":"The specific moment she finally tries this.","hook":"First ad line. No greeting. Max 12 words.","angle":"How product fits her life.","redditQuote":"Real Reddit quote"},
    {"type":"proven","identity":"...","description":"...","why_she_buys":"...","hook":"...","angle":"...","redditQuote":"..."},
    {"type":"proven","identity":"...","description":"...","why_she_buys":"...","hook":"...","angle":"...","redditQuote":"..."},
    {"type":"whitespace","identity":"Real underserved woman not in current creative","description":"Her life. Why ads miss her.","why_she_buys":"Specific trigger that would make her buy.","hook":"Hook for her real situation.","angle":"Why this is untapped and how the brand owns it.","redditQuote":""},
    {"type":"whitespace","identity":"...","description":"...","why_she_buys":"...","hook":"...","angle":"...","redditQuote":""}
  ],
  "hooksNegative": ["5 negative hooks filled in for this brand using these frameworks: ${HOOK_FRAMEWORKS.split('CURIOSITY:')[0]}. Only include hooks that genuinely fit. Never fabricate."],
  "hooksCuriosity": ["5 curiosity hooks filled in for this brand using curiosity frameworks above. All blanks filled with brand-specific language."],
  "hooksPersona": ["5 persona hooks filled in using persona frameworks above. Use the real personas detected."],
  "hooksTrending": ["5 trending format hooks. Label each with format in brackets. E.g. [Confession] I finally tried HoneyLove and..."],
  "scriptRecommendation": "Single highest-leverage script angle right now. Reference Reddit language and competitor gap. 3 sentences. Direct and specific."
}`,
        messages: [{ role: 'user', content: `Analyze this data:\n${context}\n\nHook frameworks to use:\n${HOOK_FRAMEWORKS}` }]
      })
    });

    const analysisData = await analysisRes.json();
    const analysisText = analysisData.content?.map(b => b.text || '').join('') || '{}';

    let intelligence;
    try {
      const cleaned = analysisText
        .replace(/```json/gi, '')
        .replace(/```/g, '')
        .trim();
      
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      
      if (firstBrace !== -1 && lastBrace !== -1) {
        intelligence = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } else {
        intelligence = JSON.parse(cleaned);
      }
    } catch(e) {
      // If JSON is truncated, try to salvage what we have
      try {
        const cleaned = analysisText.replace(/```json/gi, '').replace(/```/g, '').trim();
        const firstBrace = cleaned.indexOf('{');
        if (firstBrace !== -1) {
          // Try to find the last complete field
          let truncated = cleaned.slice(firstBrace);
          // Find last complete array by looking for last ],
          const lastCompleteArray = truncated.lastIndexOf('],');
          if (lastCompleteArray !== -1) {
            truncated = truncated.slice(0, lastCompleteArray + 1) + '
,"scriptRecommendation":"Analysis partially loaded. Regenerate for full output."
}';
            intelligence = JSON.parse(truncated);
          } else {
            intelligence = { error: 'Response truncated. Try again.', raw: analysisText.slice(0, 400) };
          }
        } else {
          intelligence = { error: 'Parse failed: ' + e.message, raw: analysisText.slice(0, 400) };
        }
      } catch {
        intelligence = { error: 'Parse failed: ' + e.message, raw: analysisText.slice(0, 400) };
      }
    }

    return res.status(200).json({ success: true, brand, competitors, intelligence });

  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
