// pages/api/gemini.js
import fetch from "node-fetch";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const { items = [], mode = "autodetect", customTargets = [] } = req.body;

  // Basic validation
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "No OCR items provided" });
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Server missing GOOGLE_API_KEY env var" });

  // Build a clear prompt asking Gemini to return JSON:
  // We pass a list of objects with index and text. Gemini should return a JSON array of indices to redact.
  const smallList = items.map((it, idx) => ({ i: idx, text: it.text }));
  const prompt = `
You are a JSON-only assistant. INPUT is a JSON object with "mode" ("autodetect" or "custom"), "customTargets" (array of strings), and "items" (array of {i: index, text: string}).

Your job: return a JSON object with a single key "redact_indices" which is an array of integers (the indices of items that should be redacted).
Rules:
- If "mode" is "autodetect", mark items that are sensitive (credit card numbers, full names, street addresses, phone numbers, email, passport/ID numbers, account numbers, bank routing numbers, Minecraft coordinates like "123 64 -200", or other PII). Use common-sense: if an item is just a single common word (like "Hello") do not redact.
- If "mode" is "custom", mark items whose text matches (case-insensitive) any entry in "customTargets" or which contain those tokens as substrings. Also allow simple patterns like "credit_card" to match numeric groups that look like card numbers.
- Always output strictly valid JSON, nothing else.
- Example output: {"redact_indices":[0,2,5]}

Here is the INPUT:
${JSON.stringify({ mode, customTargets, items: smallList })}
  `;

  try {
    // Use Google Generative API (Gemini). Use the REST API endpoint documented by Google.
    // We'll call the text generation endpoint with a short generation and ask for JSON output.
    // Replace model name if needed (e.g. "models/gemini-1.5" or "models/gemini-2.5-flash").
    const model = process.env.GEN_MODEL || "models/gemini-2.5-flash"; // change as needed

    // Example REST endpoint (ai.google.dev / generative API). Use the method documented in Google's GenAI docs.
    const url = `https://api.generativeai.googleapis.com/v1beta/${model}:generateText?key=${apiKey}`;

    const body = {
      prompt: {
        text: prompt
      },
      // small response
      temperature: 0,
      maxOutputTokens: 200
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const jr = await r.json();
    // Try to parse the text generation from the response. The exact JSON path can vary by API version.
    let genText = "";
    if (jr && jr.candidates && jr.candidates[0] && jr.candidates[0].output) {
      // older style
      genText = jr.candidates[0].output;
    } else if (jr && jr.output && jr.output[0] && jr.output[0].content) {
      // other shapes
      genText = jr.output.map(o => (o.content ? (typeof o.content === "string" ? o.content : JSON.stringify(o.content)) : "")).join("\n");
    } else if (jr && jr.result && jr.result?.content) {
      genText = jr.result.content;
    } else {
      // fallback: try first text field
      genText = JSON.stringify(jr);
    }

    // extract JSON object from genText (Gemini is instructed to be JSON-only)
    let parsed = null;
    try {
      parsed = JSON.parse(genText);
    } catch (exe) {
      // attempt to find JSON substring
      const m = genText.match(/\{[\s\S]*\}/m);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch(e2) { parsed = null; }
      }
    }

    if (!parsed || !Array.isArray(parsed.redact_indices)) {
      // best-effort fallback: try simple heuristic server-side: redact anything matching digits or common PII regexes
      const fallback = [];
      const reCard = /(?:\d[ -]?){13,19}/;
      const reCoord = /-?\d+[, \s]+-?\d+[, \s]+-?\d+/;
      const reEmail = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;
      const rePhone = /(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;

      items.forEach((it, idx) => {
        const t = (it.text || "");
        if (reCard.test(t) || reCoord.test(t) || reEmail.test(t) || rePhone.test(t)) fallback.push(idx);
        // handle custom targets
        if (mode === "custom") {
          for (const ct of customTargets) {
            if (ct && t.toLowerCase().includes(ct.toLowerCase())) {
              if (!fallback.includes(idx)) fallback.push(idx);
            }
          }
        }
      });

      return res.status(200).json({ redact_indices: fallback, note: "fallback heuristics used" });
    }

    return res.status(200).json({ redact_indices: parsed.redact_indices });
  } catch (err) {
    console.error("Gemini call error", err);
    return res.status(500).json({ error: "Gemini call failed", detail: String(err) });
  }
}