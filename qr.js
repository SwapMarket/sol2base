// The WalletConnect QR code in the page's own dialog, as in liq2sol's page (SwapMarket/liq2sol, client/site/js/app.js), instead of
// WalletConnect's modal, whose code can't be enlarged: a tap fills the screen with it, in white, for a phone held at a distance.
// The same file is in sol2base, eth2base and sol2tron.
import { qrcode } from 'qrcode';

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

// The code alone, filling the screen. A tap, Enter or Escape closes it.
function enlarge(box) {
  const layer = el('div', { class: 'qr-full', role: 'dialog', tabindex: '0', 'aria-label': 'QR code, enlarged. Tap to close.' });
  layer.append(box.querySelector('svg').cloneNode(true));
  const close = () => { layer.remove(); box.focus(); };
  layer.onclick = close;
  layer.onkeydown = (e) => {
    if (['Escape', 'Enter', ' '].includes(e.key)) {
      // Escape would otherwise also close the dialog underneath.
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  (box.closest('dialog') ?? document.body).append(layer);
  layer.focus();
}

/**
 * Shows `uri` as a QR code. Returns `closed`, a promise that rejects with `closedByUser` when the person closes the dialog, which
 * ends the attempt, and `close()`, for when the wallet has connected.
 */
export function walletConnectDialog(uri, title) {
  const qr = qrcode(0, 'L');
  qr.addData(uri);
  qr.make();
  const box = el('div', { class: 'qr', title: 'Tap to enlarge', tabindex: '0', role: 'button', 'aria-label': 'QR code. Tap to enlarge.' });
  box.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
  box.onclick = () => enlarge(box);
  box.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      enlarge(box);
    }
  };
  const copy = el('button', { type: 'button', class: 'ghost' }, 'Copy the link');
  copy.onclick = () => navigator.clipboard?.writeText(uri).then(() => { copy.textContent = 'Copied'; }, () => {});
  const close = el('button', { type: 'button', class: 'ghost' }, 'Close');
  const dialog = el('dialog', { class: 'wc-dialog' }, el('h3', {}, title), box, el('div', { class: 'row' }, copy, close));
  // A phone can't scan its own screen: the same request, for a wallet on this device.
  if (matchMedia('(pointer: coarse)').matches) {
    box.after(
      el('a', { class: 'btn open-wc', href: uri }, 'Open in a wallet on this phone'),
      el('p', { class: 'muted' }, 'Your phone only lists wallets that handle these links. If yours isn’t there, close this and open the page in the wallet’s own browser.'),
    );
  }
  let done = false;
  let reject;
  const closed = new Promise((_, no) => { reject = no; });
  closed.catch(() => {});
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (!done) reject(Object.assign(new Error('closed'), { closedByUser: true }));
  }, { once: true });
  close.onclick = () => dialog.close();
  document.body.append(dialog);
  dialog.showModal();
  return {
    closed,
    close: () => {
      done = true;
      if (dialog.open) dialog.close();
    },
  };
}
