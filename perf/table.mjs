// Prints a markdown table from a perf/results/*.json file: node perf/table.mjs <file>
import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync(process.argv[2], 'utf8'));
console.log(`**${r.model}** (Android ${r.android}, DPR ${r.dpr}, RAM ${r.ramMB}MB) — label \`${r.label}\`\n`);
console.log('| Model | Load ms | Longest frame during load ms | WebGL fps | Frame p95 ms | Stalls >50ms /10s | gfxinfo janky % (legacy) | gfxinfo p90 ms | PSS MB | Graphics MB | Renderer PSS MB | GC /10s | Alive |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const s of r.steps) {
  if (s.error) { console.log(`| ${s.url} | ERROR: ${s.error} ||||||||||| ${s.alive} |`); continue; }
  console.log(`| ${s.url.replace('models/', '')} | ${s.load.ms} | ${s.load.longestFrameMs} | ${s.webgl.fps} | ${s.webgl.frameP95} | ${s.webgl.stallsOver50ms} | ${s.gfx.jankyPct} (${s.gfx.jankyLegacyPct}) | ${s.gfx.p90} | ${s.mem.pssMB} | ${s.mem.graphicsMB} | ${s.mem.rendererPssMB} | ${s.gcPer10s} | ${s.alive} |`);
}
