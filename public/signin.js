(() => {
  'use strict';
  const PASS_KEY = 'pickup-passcode'; // the app's key: writes keep using it, so no second prompt
  const PROFILES_KEY = 'pickup-profiles'; // the app's offline roster
  const $ = id => document.getElementById(id);
  const form = $('signin'), pass = $('pass'), go = $('go'), msg = $('msg');
  const showForm = () => { $('enter').hidden = true; form.hidden = false; pass.focus(); };
  // "Enter as organizer": a signed-in device goes straight into the app; any other device gets
  // the passcode box in place. With no connection, try the app anyway: a device that signed in
  // before has it saved for offline use.
  $('enter').addEventListener('click', async e => {
    e.preventDefault();
    try {
      const res = await fetch('/api/session', { cache: 'no-store' });
      if (res.ok) location.assign('/app');
      else {
        // Not signed in (the session ran out): don't leave the offline app and roster behind.
        try { localStorage.removeItem(PASS_KEY); localStorage.removeItem(PROFILES_KEY); } catch {}
        try { await Promise.all((await caches.keys()).map(k => caches.delete(k))); } catch {}
        showForm();
      }
    } catch {
      location.assign('/app');
    }
  });
  // Someone opened /app directly without being signed in: the Worker sent them here with ?signin.
  if (new URLSearchParams(location.search).has('signin')) {
    showForm();
    history.replaceState(null, '', '/'); // a refresh shows the plain home page again
  }
  form.addEventListener('submit', async e => {
    e.preventDefault();
    go.disabled = true;
    msg.textContent = '';
    try {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: pass.value }),
      });
      if (res.ok) {
        try { localStorage.setItem(PASS_KEY, pass.value); } catch {}
        location.assign('/app');
        return;
      }
      msg.textContent = res.status === 401 ? 'Wrong passcode.'
        : res.status === 429 ? 'Too many tries. Wait a minute, then try again.'
        : 'Could not sign in. Try again in a moment.';
      if (res.status === 401) pass.select();
    } catch {
      msg.textContent = 'No connection. Signing in needs the internet.';
    } finally {
      go.disabled = false;
    }
  });
})();
