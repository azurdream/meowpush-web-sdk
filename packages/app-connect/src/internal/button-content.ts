import { createLogo } from './logo.js';

type Icon = 'logo' | 'loading' | 'success' | 'error';

/** Owns decorative content only; never receives authorization data. */
export function buttonContent(button: HTMLButtonElement) {
  const doc = button.ownerDocument;
  const view = doc.defaultView;
  const content = doc.createElement('span');
  content.className = 'mp-connect__content';
  content.setAttribute('aria-hidden', 'true');
  button.append(content);
  let current: HTMLSpanElement | undefined;
  let signature = '';
  let cleanup: ReturnType<typeof setTimeout> | undefined;

  const measure = () => {
    if (!current || !view) return;
    const box = current.getBoundingClientRect();
    // A hidden host (and SSR DOM shims) cannot be measured yet. ResizeObserver
    // measures it when visible rather than pinning the button to zero pixels.
    if (!box.width || !box.height) return;
    const css = view.getComputedStyle(button);
    const px = (value: string) => Number.parseFloat(value) || 0;
    const width = box.width + px(css.paddingLeft) + px(css.paddingRight) + px(css.borderLeftWidth) + px(css.borderRightWidth);
    const height = Math.max(px(css.getPropertyValue('--mp-connect-min-height')), px(css.minHeight), box.height + px(css.paddingTop) + px(css.paddingBottom) + px(css.borderTopWidth) + px(css.borderBottomWidth));
    button.style.width = `${width}px`;
    button.style.height = `${height}px`;
  };
  const observer = view?.ResizeObserver ? new view.ResizeObserver(measure) : undefined;
  const clearOutgoing = () => {
    if (cleanup !== undefined) clearTimeout(cleanup);
    cleanup = undefined;
    content.querySelectorAll('.mp-connect__face--outgoing').forEach((face) => face.remove());
  };
  const finished = (event: AnimationEvent) => {
    if (event.animationName === 'mp-connect-enter') clearOutgoing();
  };
  content.addEventListener('animationend', finished);
  return {
    render(label: string, icon: Icon) {
      const nextSignature = `${icon}:${label}`;
      if (signature === nextSignature) { measure(); return; }
      signature = nextSignature;
      clearOutgoing();
      observer?.disconnect();
      const previous = current;
      const face = doc.createElement('span');
      face.className = 'mp-connect__face';
      let image: HTMLElement;
      if (icon === 'logo') image = createLogo(doc);
      else {
        image = doc.createElement('span');
        image.className = icon === 'loading' ? 'mp-connect__loader' : `mp-connect__result-icon mp-connect__result-icon--${icon}`;
        if (icon === 'loading') {
          for (let i = 0; i < 3; i++) {
            const dot = doc.createElement('span');
            dot.className = 'mp-connect__dot';
            image.append(dot);
          }
        }
      }
      const text = doc.createElement('span');
      text.className = 'mp-connect__label';
      text.textContent = label;
      face.append(image, text);
      if (previous) previous.classList.add('mp-connect__face--outgoing');
      current = face;
      content.append(face);
      measure();
      observer?.observe(face);
      // Covers reduced motion, hidden hosts and detached nodes, where the
      // animationend event may never fire. Only one outgoing face is retained.
      if (previous) {
        const css = view?.getComputedStyle(face);
        const milliseconds = (value: string | undefined) => {
          const n = Number.parseFloat(value ?? '');
          return Number.isFinite(n) ? n * (value?.trim().endsWith('ms') ? 1 : 1000) : 0;
        };
        cleanup = setTimeout(clearOutgoing, Math.max(100, milliseconds(css?.animationDuration) + milliseconds(css?.animationDelay)) + 50);
      }
    },
    destroy() {
      clearOutgoing();
      observer?.disconnect();
      content.removeEventListener('animationend', finished);
    },
  };
}
