/**
 * In-app alert cues when a Realtime chat/match toast appears (app already open).
 * Safe on unsupported browsers — never throws into chat UX.
 */

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const Ctor = window.AudioContext
      || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
      sharedAudioCtx = new Ctor();
    }
    return sharedAudioCtx;
  } catch {
    return null;
  }
}

function playChimeOnContext(ctx: AudioContext): void {
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
  gain.connect(ctx.destination);

  const osc1 = ctx.createOscillator();
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(880, now);
  osc1.connect(gain);
  osc1.start(now);
  osc1.stop(now + 0.14);

  const osc2 = ctx.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(1174.7, now + 0.12);
  osc2.connect(gain);
  osc2.start(now + 0.12);
  osc2.stop(now + 0.28);
}

/** Short two-tone chime via Web Audio. Best-effort resume if previously unlocked. */
export function playInboxAlertChime(): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'running') {
      playChimeOnContext(ctx);
      return;
    }
    // Previously unlocked contexts may be suspended after tab sleep — try resume.
    void ctx.resume().then(() => {
      if (ctx.state === 'running') playChimeOnContext(ctx);
    }).catch(() => { /* autoplay blocked */ });
  } catch {
    /* unsupported / autoplay blocked */
  }
}

export function vibrateInboxAlert(): void {
  try {
    navigator.vibrate?.([150, 80, 150]);
  } catch {
    /* ignore */
  }
}

/** Unlock AudioContext on first user gesture so later toasts can chime. */
export function armInboxAlertAudio(): () => void {
  if (typeof window === 'undefined') return () => {};
  const unlock = () => {
    try {
      const ctx = getAudioContext();
      if (ctx && ctx.state === 'suspended') {
        void ctx.resume().catch(() => { /* ignore */ });
      }
    } catch {
      /* ignore */
    }
  };
  window.addEventListener('pointerdown', unlock, { once: true, passive: true });
  window.addEventListener('keydown', unlock, { once: true });
  return () => {
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
}

export function cueInboxAlert(): void {
  vibrateInboxAlert();
  playInboxAlertChime();
}
