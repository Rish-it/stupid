// Home's two sounds, made by the browser with Web Audio: no files to download. Our own, in the spirit of short UI
// sounds: a bright tick when work is done, a glass bell that rings longer when something needs the person.
export const doneSounds = { tick: "Tick", chord: "Chord", pop: "Pop", off: "Off" } as const;
export const needsSounds = { bell: "Bell", chime: "Chime", knock: "Knock", off: "Off" } as const;
export type Sounds = { done: keyof typeof doneSounds; needs: keyof typeof needsSounds };

// Each note: pitch in Hz, start and length in seconds, and the wave.
type Note = [number, number, number, OscillatorType?];
const notes: Record<string, Note[]> = {
  tick: [[1320, 0, 0.09]],
  chord: [[660, 0, 0.3], [831, 0.05, 0.3], [988, 0.1, 0.35]],
  pop: [[520, 0, 0.06, "triangle"], [880, 0.05, 0.09, "triangle"]],
  bell: [[1568, 0, 1.1], [2349, 0, 0.7], [3136, 0, 0.35]],
  chime: [[988, 0, 0.45], [1319, 0.16, 0.6]],
  knock: [[196, 0, 0.08, "triangle"], [196, 0.16, 0.08, "triangle"]],
};

let audio: AudioContext | undefined;
// Browsers allow sound only after the person interacts with the page, so the first tap or key wakes it.
const wake = () => { audio ??= new AudioContext(); void audio.resume(); };
addEventListener("pointerdown", wake, { once: true });
addEventListener("keydown", wake, { once: true });

/** Plays one sound by name; silent for "off" or before the person has interacted with the page. */
export function play(name: string) {
  if (!audio || audio.state !== "running" || !notes[name]) return;
  const now = audio.currentTime;
  for (const [pitch, start, length, wave = "sine"] of notes[name]) {
    const tone = audio.createOscillator(), level = audio.createGain();
    tone.type = wave;
    tone.frequency.value = pitch;
    level.gain.setValueAtTime(0, now + start);
    level.gain.linearRampToValueAtTime(0.15, now + start + 0.01);
    level.gain.exponentialRampToValueAtTime(0.0001, now + start + length);
    tone.connect(level).connect(audio.destination);
    tone.start(now + start);
    tone.stop(now + start + length + 0.05);
  }
}
