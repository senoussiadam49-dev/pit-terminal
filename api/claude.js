// api/claude.js
// Handles all Claude API calls for both SIS and PIT terminals.
// Supports standard completions AND the web_search tool for PIT.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // API key: prefer Vercel env variable, fall back to header (local dev)
  const apiKey =
    process.env.ANTHROPIC_API_KEY ||
    req.headers['x-api-key'] ||
    '';

  if (!apiKey) {
    return res.status(401).json({
      error: { message: 'No API key. Add ANTHROPIC_API_KEY to Vercel env variables.' },
    });
  }

  try {
    const body = req.body;

    const anthropicBody = {
      model: body.model || 'claude-sonnet-4-20250514',
      max_tokens: body.max_tokens || 4000,
      messages: body.messages,
    };

    if (body.system) anthropicBody.system = body.system;

    // Web search tool — only included when PIT requests it
    if (body.tools && Array.isArray(body.tools)) {
      anthropicBody.tools = body.tools;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify(anthropicBody),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: {
          message: data.error?.message || `API error ${response.status}`,
          type: data.error?.type,
        },
      });
    }

    // Extract text from mixed content blocks (web search returns text + tool blocks)
    if (data.content && Array.isArray(data.content)) {
      data._extracted_text = data.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim();
    }

    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({
      error: { message: error.message || 'Internal server error' },
    });
  }
}
