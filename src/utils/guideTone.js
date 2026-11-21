export const GUIDE_TONES = {
  friendly: { label: 'Friendly', intro: 'Quick tip', rate: 1.05, pitch: 1.08 },
  funny: { label: 'Funny', intro: 'Tiny side quest', rate: 1.1, pitch: 1.13 },
  professional: { label: 'Professional', intro: 'Tip', rate: 1.03, pitch: 1 },
};

export function readGuideTone(userId) {
  try {
    const stored = window.localStorage.getItem(`finsphere:guide-tone:${userId}`);
    return Object.hasOwn(GUIDE_TONES, stored) ? stored : 'friendly';
  } catch {
    return 'friendly';
  }
}

export function saveGuideTone(userId, tone) {
  window.localStorage.setItem(`finsphere:guide-tone:${userId}`, tone);
}
