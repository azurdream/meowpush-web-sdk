/** The official icon is fixed; integration metadata never chooses this URL. */
const ICON_URL = 'https://meowpush.com/res/appicon/meowpush.png';
export function createLogo(document: Document): HTMLImageElement {
  const image = document.createElement('img');
  image.className = 'mp-connect__icon';
  image.alt = '';
  image.setAttribute('aria-hidden', 'true');
  image.width = 21;
  image.height = 21;
  image.draggable = false;
  image.referrerPolicy = 'no-referrer';
  image.decoding = 'async';
  // Reserve the same space on failure; authorization never depends on image loading.
  image.addEventListener('error', () => { image.dataset.failed = 'true'; });
  image.addEventListener('load', () => { delete image.dataset.failed; });
  image.src = ICON_URL;
  return image;
}
