#!/usr/bin/env node
// Topic in, raw vertical mp4 out. No npm deps — Node 22 + ffmpeg + three local CLIs.
//   node vidgen.mjs "the history of coffee"      → out/<slug>/final.mp4
// Steps: Claude writes the script → Wikimedia Commons footage per scene (video first, photo fallback)
//        → Piper voiceover → whisper captions → synth music ducked under the voice → ffmpeg assembly.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const run = promisify(execFile);
const W = 1080, H = 1920, FPS = 30;
const PIPER_PY = process.env.PIPER_PY || 'python3'; // a python with `pip install piper-tts`
const VOICE = process.env.PIPER_VOICE; // path to a Piper .onnx voice
const WHISPER_MODEL = process.env.WHISPER_MODEL; // path to a whisper.cpp ggml model
const UA = 'manos-vidgen/0.1 (trial prototype; mcknasma@gmail.com)';
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);
const sh = (cmd, args, opts = {}) => run(cmd, args, { maxBuffer: 64 << 20, ...opts });
const ff = (args, cwd) => sh('ffmpeg', ['-y', '-v', 'error', ...args], { cwd });
const dur = async (f) => Number((await sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f])).stdout);

const topic = process.argv.slice(2).join(' ').trim();
if (!topic) { console.error('usage: node vidgen.mjs "<topic>"'); process.exit(1); }
if (!VOICE || !WHISPER_MODEL) { console.error('set PIPER_VOICE and WHISPER_MODEL (see README)'); process.exit(1); }
const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
const dir = join('out', slug);
mkdirSync(dir, { recursive: true });

// 1. Script — Claude Code CLI in print mode, forced into a JSON schema.
async function writeScript() {
  const schema = { type: 'object', required: ['title', 'scenes'], properties: {
    title: { type: 'string' },
    scenes: { type: 'array', minItems: 5, maxItems: 7, items: { type: 'object', required: ['narration', 'queries'], properties: {
      narration: { type: 'string', description: '1-2 short spoken sentences, ~8 seconds' },
      queries: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string' }, description: '2-4 word Wikimedia Commons searches, most specific first' },
    } } },
  } };
  const prompt = `Write a 45-60 second faceless YouTube Short about: "${topic}".
Hook in the first sentence, one clear fact per scene, plain spoken English, a punchy last line.
Only well-documented facts; no invented numbers or quotes.
For each scene give Wikimedia Commons search queries that would find real photos or video of what is being said.`;
  const { stdout } = await sh('claude', ['-p', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--tools', '', '--no-session-persistence']);
  const res = JSON.parse(stdout);
  return res.structured_output ?? JSON.parse(res.result);
}

// 2. Footage — Commons search, real video preferred, photo fallback. Keeps attribution.
const used = new Set(); // one Commons file never appears twice in a video
async function commons(query, kind) {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  Object.entries({ action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrlimit: '8',
    gsrsearch: `${query} filetype:${kind}`, prop: 'imageinfo', iiprop: 'url|mime|size|extmetadata', iiurlwidth: '1600' })
    .forEach(([k, v]) => u.searchParams.set(k, v));
  const j = await (await fetch(u, { headers: { 'user-agent': UA } })).json();
  const pages = Object.values(j.query?.pages || {}).sort((a, b) => a.index - b.index);
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii || used.has(ii.descriptionurl)) continue;
    if (kind === 'video' && !(ii.size > 300e3 && ii.size < 40e6)) continue; // big originals stall the run
    if (kind === 'bitmap' && (ii.width < 800 || /svg|gif/.test(ii.mime))) continue;
    const meta = ii.extmetadata || {};
    const artist = (meta.Artist?.value || 'unknown').replace(/<[^>]+>/g, '').trim();
    return { kind, url: kind === 'video' ? ii.url : (ii.thumburl || ii.url), page: ii.descriptionurl,
      credit: `${p.title.replace(/^File:/, '')} — ${artist} — ${meta.LicenseShortName?.value || '?'}` };
  }
  return null;
}

async function footage(scene, i) {
  for (const kind of ['video', 'bitmap'])
    for (const q of scene.queries) {
      const hit = await commons(q, kind).catch(() => null);
      if (!hit) continue;
      const file = join(dir, `src${i}.${kind === 'video' ? 'media' : 'jpg'}`);
      const buf = await fetch(hit.url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(60e3) })
        .then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
      if (!buf) continue;
      writeFileSync(file, Buffer.from(buf));
      used.add(hit.page);
      return { ...hit, file, query: q };
    }
  return null;
}

// 3. Voice — Piper, local and free. One wav per scene so each clip matches its line.
async function voice(text, i) {
  const out = join(dir, `voice${i}.wav`);
  const p = sh(PIPER_PY, ['-m', 'piper', '--model', VOICE, '--output_file', out]);
  p.child.stdin.end(text);
  await p;
  return out;
}

// 4. One clip per scene, cut to the length of its narration (+0.3s breath).
async function clip(src, len, i) {
  const out = join(dir, `clip${i}.mp4`);
  const fill = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${FPS}`;
  if (!src) await ff(['-f', 'lavfi', '-i', `color=c=0x111111:s=${W}x${H}:r=${FPS}`, '-t', String(len), '-pix_fmt', 'yuv420p', out]);
  else if (src.kind === 'video') await ff(['-stream_loop', '-1', '-i', src.file, '-t', String(len), '-an', '-vf', fill, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', out]);
  else { // photo: slow Ken Burns push-in so the frame never stands still
    const frames = Math.ceil(len * FPS);
    const zoom = `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='1+0.12*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`;
    await ff(['-loop', '1', '-i', src.file, '-t', String(len), '-vf', zoom, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', out]);
  }
  return out;
}

const t0 = Date.now();
log('script…');
const script = await writeScript();
writeFileSync(join(dir, 'script.json'), JSON.stringify(script, null, 2));
log(`"${script.title}" — ${script.scenes.length} scenes`);

const wavs = await Promise.all(script.scenes.map((s, i) => voice(s.narration, i)));
const scenes = [];
for (const [i, s] of script.scenes.entries()) { // footage serially so de-dup sees earlier picks
  const src = await footage(s, i), wav = wavs[i];
  const len = (await dur(wav)) + 0.3;
  log(`scene ${i + 1}: ${src ? `${src.kind} "${src.query}"` : 'NO FOOTAGE (placeholder)'} · ${len.toFixed(1)}s`);
  scenes.push({ ...s, src, wav, len });
}

const clips = [];
for (const [i, s] of scenes.entries()) clips.push(await clip(s.src, s.len, i)); // serial: ffmpeg already uses every core

// Voice track: each scene's wav padded to its clip length, then joined.
await ff([...scenes.flatMap((s) => ['-i', s.wav.replace(dir + '/', '')]), '-filter_complex',
  scenes.map((s, i) => `[${i}:a]aresample=48000,apad=whole_dur=${s.len}[a${i}]`).join(';') + ';' +
  scenes.map((_, i) => `[a${i}]`).join('') + `concat=n=${scenes.length}:v=0:a=1[a]`, '-map', '[a]', 'voice.wav'], dir);
const total = await dur(join(dir, 'voice.wav'));

// Captions: whisper re-listens to the voice track, short segments → burned-in subtitles.
await sh('whisper-cli', ['-m', WHISPER_MODEL, '-f', 'voice.wav', '-osrt', '-of', 'captions', '-ml', '22', '-sow', '-np'], { cwd: dir });

// Music: owned, synthesized pad (two detuned chords + slow tremolo), ducked under the voice.
await ff(['-f', 'lavfi', '-i', `aevalsrc='0.08*(sin(2*PI*110*t)+sin(2*PI*164.8*t)+sin(2*PI*220.5*t)+0.6*sin(2*PI*277.2*t))*(0.75+0.25*sin(2*PI*0.2*t))':s=48000:d=${total}`,
  '-af', `afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, total - 2)}:d=2`, 'music.wav'], dir);
await ff(['-i', 'voice.wav', '-i', 'music.wav', '-filter_complex',
  '[1:a][0:a]sidechaincompress=threshold=0.03:ratio=8:release=400[duck];[0:a][duck]amix=inputs=2:normalize=0[a]', '-map', '[a]', 'mix.wav'], dir);

// Assemble: concat clips, burn captions, mux audio.
writeFileSync(join(dir, 'clips.txt'), clips.map((c) => `file '${c.replace(dir + '/', '')}'`).join('\n'));
await ff(['-f', 'concat', '-safe', '0', '-i', 'clips.txt', '-c', 'copy', 'raw.mp4'], dir);
const style = 'FontName=Helvetica Neue,FontSize=20,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=3,Shadow=0,Alignment=2,MarginV=160';
await ff(['-i', 'raw.mp4', '-i', 'mix.wav', '-vf', `subtitles=captions.srt:force_style='${style}'`, '-map', '0:v', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', 'final.mp4'], dir);

writeFileSync(join(dir, 'credits.txt'), `${script.title}\n\nFootage (Wikimedia Commons):\n` +
  scenes.map((s, i) => `${i + 1}. ${s.src ? `${s.src.credit}\n   ${s.src.page}` : 'placeholder'}`).join('\n') +
  '\n\nVoice: Piper TTS (local). Music: synthesized in ffmpeg. Script: Claude.\n');
log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s → ${join(dir, 'final.mp4')} (${total.toFixed(1)}s)`);
if (!existsSync(join(dir, 'final.mp4'))) process.exit(1);
