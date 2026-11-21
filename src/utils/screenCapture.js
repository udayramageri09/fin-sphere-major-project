// "Circle to ask": reads what is on screen inside the area the user circled. The drawing itself is only a gesture; what the
// assistant receives is the visible text under the circle, the page name and the app's own description of that section.
const IGNORED = '.ai-chat-panel, .ai-orb-button, .snippet-overlay-container, .voice-stage, .companion-guide-static, .companion-roaming-orb, script, style, noscript';
export const MIN_CIRCLE_PX = 24;
export const SCREEN_TEXT_MAX = 700;

export function boxFromPoints(points, pad = 12) {
  if (!points?.length) return null;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  if (right - left < MIN_CIRCLE_PX && bottom - top < MIN_CIRCLE_PX) return null;
  return { left: left - pad, top: top - pad, right: right + pad, bottom: bottom + pad };
}

const inside = (box, x, y) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;

function textRect(node) {
  const range = node.ownerDocument.createRange();
  range.selectNodeContents(node);
  return range.getBoundingClientRect();
}

// rectOf is injectable so the logic can be tested without a layout engine.
export function collectScreenContext(box, { doc = document, rectOf = textRect } = {}) {
  const found = [];
  const walker = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.replace(/\s+/g, ' ').trim();
    const parent = node.parentElement;
    if (!text || !parent || parent.closest(IGNORED) || parent.checkVisibility?.() === false) continue;
    const rect = rectOf(node);
    if (!rect.width && !rect.height) continue;
    if (inside(box, (rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)) found.push({ text, top: Math.round(rect.top / 8), left: rect.left });
  }
  found.sort((a, b) => a.top - b.top || a.left - b.left);
  const text = found.map((item) => item.text).filter((item, index, all) => item !== all[index - 1]).join(' · ').slice(0, SCREEN_TEXT_MAX);
  const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
  const hint = [...doc.querySelectorAll('[data-guide-tip]')]
    .filter((element) => !element.closest(IGNORED))
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => inside(rect, cx, cy))
    .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0]?.element.dataset.guideTip ?? '';
  return { text, hint };
}
