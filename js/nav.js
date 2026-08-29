// Persistent hamburger navigation, injected on every page that includes this script.
// Fixed top-left button opens a slide-in drawer with Home, Search, Overview (and
// Admin / Log Out when relevant). Works from both the site root and /charts/.

const inCharts = window.location.pathname.includes('/charts/');
const basePath = inCharts ? '../' : '';

function getPatientIdFromUrl() {
  return new URLSearchParams(window.location.search).get('patient');
}

function injectStyles() {
  if (document.getElementById('gnavStyles')) return;
  const style = document.createElement('style');
  style.id = 'gnavStyles';
  style.textContent = `
    .gnav-toggle {
      position: fixed; top: 12px; left: 12px; z-index: 4000;
      width: 40px; height: 40px; border: none; border-radius: 8px;
      background: #111827; color: #fff; font-size: 18px; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.35); padding: 0;
    }
    .gnav-toggle:hover { background: #1f2937; }
    .gnav-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,.45);
      z-index: 4998; opacity: 0; pointer-events: none; transition: opacity .18s ease;
    }
    .gnav-overlay.gnav-open { opacity: 1; pointer-events: auto; }
    .gnav-drawer {
      position: fixed; top: 0; left: 0; height: 100%; width: 250px; max-width: 82vw;
      background: #fff; z-index: 4999; transform: translateX(-100%);
      transition: transform .2s ease; box-shadow: 2px 0 14px rgba(0,0,0,.25);
      display: flex; flex-direction: column;
    }
    .gnav-drawer.gnav-open { transform: translateX(0); }
    .gnav-drawer-head {
      background: #111827; color: #fff; padding: 16px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .gnav-drawer-head span { font-weight: bold; font-size: 15px; }
    .gnav-drawer-close { background: none; border: none; color: #fff; font-size: 22px; cursor: pointer; line-height: 1; }
    .gnav-drawer-body { padding: 10px; overflow-y: auto; flex: 1; }
    .gnav-link {
      display: flex; align-items: center; gap: 10px; padding: 12px 14px; margin-bottom: 4px;
      border-radius: 8px; font-size: 14px; font-weight: bold; color: #111827; cursor: pointer;
      border: none; background: none; width: 100%; text-align: left; font-family: inherit;
    }
    .gnav-link:hover { background: #f3f4f6; }
    .gnav-link.gnav-disabled { color: #9ca3af; cursor: not-allowed; }
    .gnav-link .gnav-icon { font-size: 16px; width: 20px; text-align: center; }
    .gnav-drawer-foot { border-top: 1px solid #e5e7eb; padding: 10px; }
    .gnav-who { padding: 8px 14px 4px; font-size: 12px; color: #6b7280; }
    @media print {
      .gnav-toggle, .gnav-overlay, .gnav-drawer { display: none !important; }
    }
  `;
  document.head.appendChild(style);
}

function buildMenu() {
  const patientId = getPatientIdFromUrl();
  const overviewHref = patientId ? basePath + 'charts/overview.html?patient=' + encodeURIComponent(patientId) : null;

  const wrap = document.createElement('div');

  const toggle = document.createElement('button');
  toggle.className = 'gnav-toggle no-print';
  toggle.setAttribute('aria-label', 'Open menu');
  toggle.innerHTML = '&#9776;';

  const overlay = document.createElement('div');
  overlay.className = 'gnav-overlay no-print';

  const drawer = document.createElement('div');
  drawer.className = 'gnav-drawer no-print';
  drawer.innerHTML = `
    <div class="gnav-drawer-head">
      <span>68 NARHY Ward Charts</span>
      <button class="gnav-drawer-close" aria-label="Close menu">&times;</button>
    </div>
    <div class="gnav-who" id="gnavWho"></div>
    <div class="gnav-drawer-body">
      <button class="gnav-link" data-action="home"><span class="gnav-icon">&#127968;</span>Home</button>
      <button class="gnav-link" data-action="search"><span class="gnav-icon">&#128269;</span>Search</button>
      <button class="gnav-link${overviewHref ? '' : ' gnav-disabled'}" data-action="overview"><span class="gnav-icon">&#128203;</span>Overview</button>
      <button class="gnav-link" data-action="profile"><span class="gnav-icon">&#128100;</span>My Profile</button>
      <button class="gnav-link" data-action="admin" style="display:none;"><span class="gnav-icon">&#9881;&#65039;</span>Admin</button>
    </div>
    <div class="gnav-drawer-foot">
      <button class="gnav-link" data-action="logout"><span class="gnav-icon">&#128682;</span>Log Out</button>
    </div>
  `;

  wrap.appendChild(toggle);
  wrap.appendChild(overlay);
  wrap.appendChild(drawer);
  document.body.appendChild(wrap);

  function open() {
    overlay.classList.add('gnav-open');
    drawer.classList.add('gnav-open');
  }
  function close() {
    overlay.classList.remove('gnav-open');
    drawer.classList.remove('gnav-open');
  }

  toggle.addEventListener('click', open);
  overlay.addEventListener('click', close);
  drawer.querySelector('.gnav-drawer-close').addEventListener('click', close);

  drawer.querySelector('[data-action="home"]').addEventListener('click', () => {
    close();
    window.location.href = basePath + 'index.html';
  });

  drawer.querySelector('[data-action="search"]').addEventListener('click', () => {
    close();
    const onIndex = /(^|\/)index\.html$/.test(window.location.pathname) || /\/$/.test(window.location.pathname);
    if (onIndex) {
      const input = document.getElementById('searchInput');
      if (input) { input.scrollIntoView({ behavior: 'smooth', block: 'center' }); input.focus(); }
    } else {
      window.location.href = basePath + 'index.html#search';
    }
  });

  const overviewBtn = drawer.querySelector('[data-action="overview"]');
  overviewBtn.addEventListener('click', () => {
    if (!overviewHref) return;
    close();
    window.location.href = overviewHref;
  });

  drawer.querySelector('[data-action="profile"]').addEventListener('click', () => {
    close();
    window.location.href = basePath + 'profile.html';
  });

  drawer.querySelector('[data-action="admin"]').addEventListener('click', () => {
    close();
    window.location.href = basePath + 'admin.html';
  });

  const logoutBtn = drawer.querySelector('[data-action="logout"]');
  logoutBtn.addEventListener('click', async () => {
    close();
    try {
      const mod = await import(basePath + 'js/auth-guard.js');
      mod.logout();
    } catch (e) {
      window.location.href = basePath + 'login.html';
    }
  });

  return { drawer };
}

function wireIdentity(drawer) {
  import(basePath + 'js/auth-guard.js').then(({ requireAuth }) => {
    requireAuth((user, profile) => {
      const who = document.getElementById('gnavWho');
      if (who && profile) who.textContent = profile.name + ' (' + profile.role + ')';
      if (profile && profile.role === 'admin') {
        const adminBtn = drawer.querySelector('[data-action="admin"]');
        if (adminBtn) adminBtn.style.display = 'flex';
      }
    });
  }).catch(() => { /* not on an authenticated page context */ });
}

injectStyles();
const { drawer } = buildMenu();
wireIdentity(drawer);
