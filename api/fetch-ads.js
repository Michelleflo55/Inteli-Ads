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
        max_tokens: 3000,
        system: `You are a DTC ad strategist. Analyze brand and competitor data. Use real consumer language from Reddit. Return ONLY valid JSON.

CRITICAL PERSONA RULES:
- Write personas like you are describing a real woman you know personally, not a target demographic
- Every detail must be specific enough that a real woman reads it and says "that is literally me"
- If it sounds like it came from a marketing deck, rewrite it
- BANNED WORDS AND PHRASES across all personas: journey, empowered, confident, vibrant, thriving, balance, self-care, busy professional, modern woman, health-conscious, hustle, 2pm slump, overwhelmed, juggling, seamlessly, unlock, transform, elevate, relatable, authentic, resonate, lifestyle
- Use plain conversational language. The kind you would text a friend.
- Personas must be grounded in real observed behavior from Reddit and social, not invented archetypes:
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
  "hooksNegative": [
    "5 negative/skeptic hooks filled in for this brand and product. Use the proven frameworks below as starting points but only output hooks that genuinely fit this brand. Fill in all blanks with specific brand/product/pain language from the Reddit data. Frameworks to draw from: Do not buy [brand] + [product] until you see this. [Brand] this is not okay. Is [brand] a scam? I can not believe [brand] did this. Exposing the truth about [brand]. What [brand] won t tell you. I regret buying [brand]. You re being lied to about [topic]. Did [brand] lie to me? I think I just got scammed. I am returning my order from [brand]. I can not believe what [brand] put in their [product]. Exposing [brand] for [specific thing]. Only include a hook if it genuinely fits the brand. Never fabricate negative claims."
  ],
  "hooksCuriosity": [
    "5 curiosity and pattern interrupt hooks filled in for this brand. Frameworks: I am so pissed no one told me about [product]. I [action] and this is what happened. What you need to know before [action]. You have been lied to about [topic]. Why [popular belief] is complete BS. This [product] is so good it should be illegal. What I am about to show you is so [adjective] I probably should not. I probably should not be showing you this but [statement]. Most [persona] have no clue this exists. Here is what they don t tell you about [topic]. Don t [action] until you watch this. Signs that [pain point] is affecting your life. Apparently I ve been doing this wrong. If nobody else is going to tell you I will. I wish I tried this sooner. I wish I knew this before [action]. Fill ALL blanks with real brand-specific language from the Reddit and analysis data."
  ],
  "hooksPersona": [
    "5 persona and identity hooks filled in for this brand. Frameworks: [Persona] are losing it over [product]. [Persona] are raving about [product]. Why [persona] is switching to [product]. This is what [pain point] looks like for [persona]. The best [product] for [persona]. Pretty soon [persona] won t be [doing x] because [y]. What do you mean [product does this]. Fill in persona with the real identity personas from the data, not generic labels."
  ],
  "hooksTrending": [
    "5 hooks based on currently trending cross-platform viral formats that fit this brand right now. These should feel native to TikTok and Reels in 2025-2026. Reference current internet culture, trending audio formats, confession formats, POV formats, or reaction formats that are scaling right now. Fill in all specifics for this brand. Label each with the format it uses in brackets at the start. E.g. [Confession], [POV], [Reaction], [List], [Before After]."
  ],
  "personas": [
    {
      "type": "proven",
      "identity": "Who she is in 4-6 words. Real and specific. E.g. The Burnt Out Mom, The Girl Who Quit the Gym, The Woman Dressing for Comfort Now. NOT: The Busy Professional, The Health Conscious Consumer, The Modern Woman.",
      "description": "2 sentences. Her actual life right now. What her morning looks like, what she is tired of, what she tells herself. Must be specific enough that a real woman reads it and says that is me. No vague emotional language. No product. No marketing words. Banned: journey, empowered, confident, vibrant, balance, self-care, thriving, busy, hustling, slump.",
      "why_she_buys": "The exact moment or situation that makes her finally try this. Specific scenario, not a general motivation. E.g. She has a wedding in 6 weeks and nothing fits right and she is out of patience.",
      "hook": "First line of an ad written for her. Sounds like something she would say or something that stops her mid-scroll. No greeting. No product name. Max 12 words. Must feel human not scripted.",
      "angle": "One sentence. The exact script angle that connects her specific life situation to the product mechanism. Specific, not generic.",
      "redditQuote": "A real or very close paraphrase of something someone on Reddit said that this persona would have written herself. If no Reddit data, leave empty string."
    },
    { "type": "proven", "identity": "...", "description": "...", "why_she_buys": "...", "hook": "...", "angle": "...", "redditQuote": "..." },
    { "type": "proven", "identity": "...", "description": "...", "why_she_buys": "...", "hook": "...", "angle": "...", "redditQuote": "..." },
    { "type": "whitespace", "identity": "A real woman this brand is not speaking to yet. Same specificity rules apply. No archetypes.", "description": "Her life in 2 specific sentences. Why current ads are not reaching her.", "why_she_buys": "The specific trigger that would make her buy.", "hook": "Hook written for her real situation.", "angle": "Why this is untapped and how the brand owns it.", "redditQuote": "" },
    { "type": "whitespace", "identity": "...", "description": "...", "why_she_buys": "...", "hook": "...", "angle": "...", "redditQuote": "" }
  ],
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
