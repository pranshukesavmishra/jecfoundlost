(() => {
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
  const loggedIn = document.body.dataset.loggedIn === '1';
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const iconSvg = (paths) => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  const X_ICON = iconSvg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');

  // ---------- Confirm before dangerous actions ----------
  $$('form[data-confirm]').forEach((f) => f.addEventListener('submit', (e) => {
    if (!confirm(f.dataset.confirm)) e.preventDefault();
  }));

  // ---------- Dropdown menus: one open at a time, close on outside click ----------
  const menus = $$('details.menu');
  menus.forEach((m) => m.addEventListener('toggle', () => {
    if (m.open) menus.forEach((o) => { if (o !== m) o.open = false; });
  }));
  document.addEventListener('click', (e) => {
    menus.forEach((m) => { if (m.open && !m.contains(e.target)) m.open = false; });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') menus.forEach((m) => { m.open = false; });
  });

  // ---------- Bottom sheet ----------
  $$('[data-sheet-open]').forEach((b) => b.addEventListener('click', () => {
    const d = document.getElementById(b.dataset.sheetOpen);
    if (d?.showModal) d.showModal();
    else window.location.href = '/report/lost';
  }));
  $$('dialog.sheet').forEach((d) => d.addEventListener('click', (e) => {
    if (e.target === d) d.close();
  }));

  // ---------- Toast ----------
  const toast = document.querySelector('[data-toast]');
  if (toast) {
    const hide = () => { toast.classList.add('out'); setTimeout(() => toast.remove(), 400); };
    toast.querySelector('[data-toast-close]')?.addEventListener('click', hide);
    setTimeout(hide, 6000);
  }

  // ---------- Reveal on scroll + count-up ----------
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    }), { rootMargin: '0px 0px -40px 0px' });
    $$('.reveal').forEach((el, i) => { el.style.transitionDelay = `${Math.min(i % 8, 6) * 45}ms`; io.observe(el); });
  } else {
    $$('.reveal').forEach((el) => el.classList.add('in'));
  }
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    $$('[data-count]').forEach((el) => {
      const target = Number(el.dataset.count);
      if (!target) return;
      const start = performance.now();
      const step = (t) => {
        const p = Math.min(1, (t - start) / 900);
        el.textContent = Math.round(target * (1 - (1 - p) ** 3));
        if (p < 1) requestAnimationFrame(step);
      };
      el.textContent = '0';
      requestAnimationFrame(step);
    });
  }

  // Search results: jump to the list
  if (/[?&](q|category|type|status|page)=/.test(location.search) && !location.hash) {
    document.getElementById('browse')?.scrollIntoView({ block: 'start' });
  }

  // ---------- Gallery ----------
  const main = document.getElementById('gallery-main');
  $$('[data-thumb]').forEach((b) => b.addEventListener('click', () => {
    main.src = b.dataset.thumb;
    $$('[data-thumb]').forEach((x) => x.classList.toggle('on', x === b));
  }));

  // ---------- Share ----------
  $$('[data-share]').forEach((b) => b.addEventListener('click', async () => {
    const data = { title: b.dataset.title, text: b.dataset.text, url: b.dataset.url };
    if (navigator.share) {
      try { await navigator.share(data); } catch { /* cancelled */ }
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(data.url);
      const label = b.querySelector('span');
      if (label) { label.textContent = 'Link copied!'; setTimeout(() => { label.textContent = 'Share'; }, 2000); }
    }
  }));

  // ---------- Quick-fill chips (places, dates) ----------
  $$('[data-fill]').forEach((row) => {
    const target = document.querySelector(row.dataset.fill);
    const chips = $$('.chip-btn', row);
    const sync = () => chips.forEach((c) => c.classList.toggle('on', c.dataset.value === target.value));
    chips.forEach((c) => c.addEventListener('click', () => {
      target.value = c.dataset.value;
      target.dispatchEvent(new Event('input'));
      sync();
    }));
    target.addEventListener('input', sync);
    sync();
  });

  // ---------- Photo upload: previews, remove, compress before sending ----------
  const MAX_SIDE = 1600;

  function compress(file) {
    return new Promise((resolve) => {
      if (!file.type.startsWith('image/') || file.type === 'image/gif') return resolve(file);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (!blob || (blob.size > file.size && file.type === 'image/jpeg')) return resolve(file);
          resolve(new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }));
        }, 'image/jpeg', 0.82);
      };
      // Browser can't decode it (e.g. HEIC on Android): send the original and let the server decide.
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  $$('form[data-photo-form]').forEach((form) => {
    const inputs = $$('input[type=file]', form);
    const errorBox = form.parentElement.querySelector('[data-form-error]') || document.querySelector('[data-form-error]');
    const selected = new Map(inputs.map((i) => [i, []]));

    const showError = (msg) => {
      if (!errorBox) return alert(msg);
      errorBox.textContent = msg;
      errorBox.classList.remove('hidden');
      errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    const syncInput = (input) => {
      if (typeof DataTransfer === 'undefined') return;
      const dt = new DataTransfer();
      selected.get(input).forEach((f) => dt.items.add(f));
      input.files = dt.files;
    };

    const render = (input) => {
      const box = input.closest('.field, .panel, form').querySelector('[data-previews]');
      if (!box) return;
      box.innerHTML = '';
      selected.get(input).forEach((f, idx) => {
        const el = document.createElement('div');
        el.className = 'preview';
        const img = document.createElement('img');
        img.src = URL.createObjectURL(f);
        img.alt = '';
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.setAttribute('aria-label', 'Remove photo');
        rm.innerHTML = X_ICON;
        rm.addEventListener('click', () => {
          selected.get(input).splice(idx, 1);
          syncInput(input);
          render(input);
        });
        el.append(img, rm);
        if (idx === 0 && Number(input.dataset.max || 1) > 1) {
          const cover = document.createElement('span');
          cover.className = 'cover';
          cover.textContent = 'Cover';
          el.append(cover);
        }
        box.append(el);
      });
    };

    inputs.forEach((input) => {
      const zone = input.closest('.dropzone');
      if (zone) {
        ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.add('drag')));
        ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove('drag')));
      }
      input.addEventListener('change', () => {
        const max = Number(input.dataset.max || 1);
        const fresh = [...input.files].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
        let list = max === 1 ? fresh.slice(0, 1) : [...selected.get(input), ...fresh];
        if (list.length > max) {
          showError(`You can add up to ${max} photos — extra ones were left out.`);
          list = list.slice(0, max);
        }
        selected.set(input, list);
        syncInput(input);
        render(input);
      });
    });

    form.addEventListener('submit', async (e) => {
      const files = inputs.flatMap((i) => selected.get(i));
      if (!files.length || !window.fetch || !window.FormData) return; // normal submit
      e.preventDefault();
      const btn = form.querySelector('button:not([type=button])');
      const label = btn.innerHTML;
      btn.disabled = true;
      btn.textContent = 'Uploading…';
      try {
        const fd = new FormData(form);
        for (const input of inputs) {
          fd.delete(input.name);
          for (const f of selected.get(input)) fd.append(input.name, await compress(f));
        }
        const res = await fetch(form.action, { method: 'POST', body: fd, headers: { Accept: 'application/json' }, credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (data.redirect) {
          window.location.href = data.redirect;
          return;
        }
        showError(data.error || 'Something went wrong. Please try again.');
      } catch {
        showError('Upload failed. Check your internet connection and try again.');
      }
      btn.disabled = false;
      btn.innerHTML = label;
    });
  });

  // ---------- Unread notifications badge ----------
  if (loggedIn) {
    const badge = document.querySelector('[data-unread]');
    setInterval(async () => {
      if (document.hidden || !badge) return;
      try {
        const r = await fetch('/me/unread', { headers: { Accept: 'application/json' } });
        const { unread } = await r.json();
        badge.textContent = unread;
        badge.classList.toggle('hidden', !unread);
      } catch { /* offline */ }
    }, 60000);
  }

  // ---------- Push notifications ----------
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const IOS_HINT = 'On iPhone: tap Share → Add to Home Screen, open the app from there, then turn alerts on.';
  const post = (url, body) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  }).then((r) => r.json());

  const b64ToUint8 = (b64) => {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  };

  let registration = null;
  const currentSub = async () => (registration ? registration.pushManager.getSubscription() : null);

  async function refreshUi() {
    const statusEl = document.querySelector('[data-push-status]');
    const banner = document.getElementById('notify-banner');
    if (!pushSupported) {
      if (statusEl) statusEl.textContent = isIOS ? IOS_HINT : 'This browser does not support notifications.';
      return;
    }
    const sub = await currentSub();
    let state = { subscribed: false, scope: null };
    if (sub) state = await post('/push/status', { endpoint: sub.endpoint }).catch(() => state);
    if (statusEl) {
      statusEl.textContent = Notification.permission === 'denied'
        ? 'Blocked for this site. Allow notifications in your browser settings.'
        : state.subscribed
          ? `On · ${state.scope === 'mine' ? 'only updates about your posts' : 'every new post on campus'}`
          : 'Off on this device';
    }
    let dismissed = false;
    try { dismissed = !!localStorage.getItem('jlf_banner_dismissed'); } catch { /* private mode */ }
    if (banner) banner.classList.toggle('hidden', state.subscribed || Notification.permission === 'denied' || dismissed);
  }

  async function enable(scope = 'all') {
    if (!pushSupported) return alert(isIOS ? IOS_HINT : 'Sorry, this browser does not support notifications.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      alert('Notifications were not allowed. You can allow them later from the browser settings.');
      return refreshUi();
    }
    try {
      const { publicKey } = await fetch('/push/key').then((r) => r.json());
      let sub = await currentSub();
      if (!sub) sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(publicKey) });
      await post('/push/subscribe', { subscription: sub.toJSON(), scope });
      try { localStorage.setItem('jlf_banner_dismissed', '1'); } catch { /* ignore */ }
    } catch {
      alert('Could not turn on notifications on this device.');
    }
    refreshUi();
  }

  async function disable() {
    const sub = await currentSub();
    if (sub) {
      await post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
    refreshUi();
  }

  $$('[data-push-enable]').forEach((b) => b.addEventListener('click', () => enable(b.dataset.scope || 'all')));
  $$('[data-push-disable]').forEach((b) => b.addEventListener('click', disable));

  if (pushSupported) {
    navigator.serviceWorker.register('/sw.js').then(async () => {
      registration = await navigator.serviceWorker.ready;
      refreshUi();
    }).catch(() => {});
  } else {
    refreshUi();
  }
})();

// ---------- Light / dark mode (per device) ----------
(() => {
  const root = document.documentElement;
  const KEY = 'jlf_mode';
  const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
  const get = () => { try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; } };
  const apply = (mode) => {
    try { if (mode === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode); } catch { /* private mode */ }
    if (mode === 'auto') root.removeAttribute('data-mode'); else root.setAttribute('data-mode', mode);
    document.querySelectorAll('[data-mode-set]').forEach((b) => b.classList.toggle('on', b.dataset.modeSet === mode));
  };
  document.querySelectorAll('[data-mode-toggle]').forEach((b) => b.addEventListener('click', () => {
    const mode = get();
    const isDark = mode === 'dark' || (mode === 'auto' && systemDark());
    apply(isDark ? 'light' : 'dark');
  }));
  document.querySelectorAll('[data-mode-set]').forEach((b) => b.addEventListener('click', () => apply(b.dataset.modeSet)));
  apply(get());
})();
