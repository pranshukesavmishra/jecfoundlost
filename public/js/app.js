(() => {
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
  const loggedIn = document.body.dataset.loggedIn === '1';

  // ---------- Confirm before dangerous actions ----------
  document.querySelectorAll('form[data-confirm]').forEach((f) => {
    f.addEventListener('submit', (e) => {
      if (!confirm(f.dataset.confirm)) e.preventDefault();
    });
  });

  // ---------- Gallery ----------
  const main = document.getElementById('gallery-main');
  document.querySelectorAll('[data-thumb]').forEach((b) => {
    b.addEventListener('click', () => {
      main.src = b.dataset.thumb;
      document.querySelectorAll('[data-thumb]').forEach((x) => x.classList.toggle('active', x === b));
    });
  });

  // ---------- Share ----------
  document.querySelectorAll('[data-share]').forEach((b) => {
    b.addEventListener('click', async () => {
      const data = { title: b.dataset.title, text: b.dataset.text, url: b.dataset.url };
      if (navigator.share) {
        try { await navigator.share(data); } catch { /* cancelled */ }
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(data.url);
        b.textContent = 'Link copied!';
      }
    });
  });

  // ---------- Photo upload: preview + compress before sending ----------
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
      // Browser can't decode it (e.g. HEIC on Android) — send the original and let the server decide.
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  document.querySelectorAll('form[data-photo-form]').forEach((form) => {
    const inputs = form.querySelectorAll('input[type=file]');
    const previews = form.querySelector('[data-previews]');
    const errorBox = document.querySelector('[data-form-error]');

    const showError = (msg) => {
      if (errorBox) {
        errorBox.textContent = msg;
        errorBox.classList.remove('hidden');
        errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        alert(msg);
      }
    };

    inputs.forEach((input) => input.addEventListener('change', () => {
      const max = Number(input.dataset.max || 1);
      if (input.files.length > max) {
        showError(`You can add at most ${max} photos.`);
        input.value = '';
      }
      if (!previews) return;
      previews.innerHTML = '';
      [...input.files].forEach((f) => {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(f);
        img.alt = '';
        previews.appendChild(img);
      });
    }));

    form.addEventListener('submit', async (e) => {
      const hasFiles = [...inputs].some((i) => i.files.length);
      if (!hasFiles || !window.fetch || !window.FormData) return; // normal submit
      e.preventDefault();
      const btn = form.querySelector('button:not([type=button])');
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Uploading…';
      try {
        const fd = new FormData(form);
        for (const input of inputs) {
          fd.delete(input.name);
          for (const f of input.files) fd.append(input.name, await compress(f));
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
      btn.textContent = label;
    });
  });

  // ---------- Unread notifications badge ----------
  if (loggedIn) {
    const badge = document.getElementById('unread-count');
    setInterval(async () => {
      if (document.hidden) return;
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

  async function currentSub() {
    if (!registration) return null;
    return registration.pushManager.getSubscription();
  }

  async function refreshUi() {
    const statusEl = document.querySelector('[data-push-status]');
    const banner = document.getElementById('notify-banner');
    if (!pushSupported) {
      if (statusEl) statusEl.textContent = /iPhone|iPad/.test(navigator.userAgent)
        ? 'On iPhone: tap Share → Add to Home Screen, open the app from there, then turn notifications on.'
        : 'This browser does not support notifications.';
      return;
    }
    const sub = await currentSub();
    let state = { subscribed: false, scope: null };
    if (sub) state = await post('/push/status', { endpoint: sub.endpoint }).catch(() => state);
    if (statusEl) {
      statusEl.textContent = Notification.permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in your browser settings.'
        : state.subscribed
          ? `On — ${state.scope === 'mine' ? 'only alerts about your own posts' : 'alerts for every new post'}.`
          : 'Off on this device.';
    }
    const dismissed = localStorage.getItem('jlf_banner_dismissed');
    if (banner && !state.subscribed && Notification.permission !== 'denied' && !dismissed) banner.classList.remove('hidden');
    if (banner && state.subscribed) banner.classList.add('hidden');
  }

  async function enable(scope = 'all') {
    if (!pushSupported) {
      alert(/iPhone|iPad/.test(navigator.userAgent)
        ? 'On iPhone: tap Share → Add to Home Screen, open the app from there, then turn notifications on.'
        : 'Sorry, this browser does not support notifications.');
      return;
    }
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
      if (!loggedIn && scope === 'all') localStorage.setItem('jlf_banner_dismissed', '1');
    } catch (err) {
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

  document.querySelectorAll('[data-push-enable]').forEach((b) => b.addEventListener('click', () => enable(b.dataset.scope || 'all')));
  document.querySelectorAll('[data-push-disable]').forEach((b) => b.addEventListener('click', disable));
  document.querySelectorAll('[data-push-toggle]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    if (loggedIn) window.location.href = '/me/profile';
    else enable('all');
  }));

  if (pushSupported) {
    navigator.serviceWorker.register('/sw.js').then(async () => {
      registration = await navigator.serviceWorker.ready;
      refreshUi();
    }).catch(() => {});
  } else {
    refreshUi();
  }
})();
