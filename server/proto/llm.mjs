// Time candidate models on OpenRouter with a real persona prompt. Prints timings and the reply only.
import { PERSONAS } from '../src/personas.js';
const models = (process.argv[2] || 'thedrummer/cydonia-24b-v4.1,cognitivecomputations/dolphin-mistral-24b-venice-edition,thedrummer/unslopnemo-12b,sao10k/l3.1-euryale-70b,x-ai/grok-4.3').split(',');
const persona = PERSONAS[process.argv[3] || 'roast'];
const user = process.argv[4] || "ok so I slept until 2pm and then ate cereal for dinner";
async function run(model) {
  const t0 = Date.now();
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, max_tokens: 220, temperature: 0.9, messages: [{ role: 'system', content: persona.prompt }, { role: 'user', content: user }] }),
  });
  if (!r.ok) return console.log(`${model}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  let first = 0, firstSentence = 0, text = '', buf = '';
  const dec = new TextDecoder();
  for await (const c of r.body) {
    buf += dec.decode(c, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:') || line.endsWith('[DONE]')) continue;
      let d; try { d = JSON.parse(line.slice(5)).choices?.[0]?.delta?.content; } catch {}
      if (!d) continue;
      if (!first) first = Date.now() - t0;
      text += d;
      if (!firstSentence && /[.!?]\s*$/.test(text) && text.length > 15) firstSentence = Date.now() - t0;
    }
  }
  const total = Date.now() - t0;
  console.log(`${model}\n  first token ${first} ms | first sentence ${firstSentence} ms | done ${total} ms | ~${Math.round(text.length / 4 / ((total - first) / 1000 || 1))} tok/s\n  ${text.replace(/\s+/g, ' ').slice(0, 260)}`);
}
for (let round = 0; round < 2; round++) { console.log(`--- round ${round + 1}`); for (const m of models) await run(m).catch((e) => console.log(m, 'failed', e.message)); }
