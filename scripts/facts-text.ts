// Fetch a URL, strip tags, print sentences containing any of the given needles.
const [url, ...needles] = process.argv.slice(2);
const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
let t = await r.text();
t = t.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const sents = t.split(/(?<=[.!?])\s+/);
for (const s of sents) if (needles.some((n) => s.toLowerCase().includes(n.toLowerCase())) && s.length < 700) console.log("- " + s);
