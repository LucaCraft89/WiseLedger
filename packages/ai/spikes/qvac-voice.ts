// Parakeet speech-to-text: load, transcribe a short WAV twice (cold, warm), print timings. Usage: tsx spikes/qvac-voice.ts [file.wav]
import { createTranscriber } from '../src/voice.js';
import { rssMb, secs } from './util.js';

// Third-party audio is not committed: pass a speech WAV, default the ALSA system sample.
const file = process.argv[2] ?? '/usr/share/sounds/alsa/Front_Center.wav';
const stt = createTranscriber({
  provider: 'qvac',
  onProgress: (p) => process.stdout.write(`\rdownload ${p.toFixed(0)}%   `),
});
const first = await stt.transcribe(file, 'audio/wav');
console.log(
  `\nfirst call (load + transcribe) ${secs(first.ms)} s · load ${secs(stt.info().loadMs ?? 0)} s · rss ${rssMb()} MB`,
);
console.log(`text: ${first.text}`);
const second = await stt.transcribe(file, 'audio/wav');
console.log(`warm transcribe ${secs(second.ms)} s · text: ${second.text}`);
await stt.unload();
process.exit(0);
