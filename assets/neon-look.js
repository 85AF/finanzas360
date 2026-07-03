// Finanzas 360 · Neumorphic visual layer + theme switch
// Solo cambia apariencia. No toca Supabase, roles, permisos ni datos.

(() => {
  const root = document.documentElement;
  const THEME_KEY = "finanzas360.theme";
  const LEGACY_KEYS = ["f360.theme", "f360-theme", "finanzas360-theme"];
  let leaveTimer;
  let lastThemeToggleAt = 0;
  let themeToggleObserverStarted = false;
  let switchObserverStarted = false;

  function safeStorageGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function safeStorageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (_) {}
  }

  function storedTheme() {
    const direct = safeStorageGet(THEME_KEY);
    if (direct === "dark" || direct === "light") return direct;
    for (const key of LEGACY_KEYS) {
      const value = safeStorageGet(key);
      if (value === "dark" || value === "light") return value;
    }
    return null;
  }

  function preferredTheme() {
    const saved = storedTheme();
    if (saved) return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function currentTheme() {
    const current = root.getAttribute("data-f360-theme") || document.body?.getAttribute("data-f360-theme");
    return current === "dark" ? "dark" : "light";
  }

  function updateThemeToggle(theme = currentTheme()) {
    document.querySelectorAll(".f360-theme-toggle").forEach((button) => {
      const isDark = theme === "dark";
      button.setAttribute("aria-pressed", String(isDark));
      button.setAttribute("data-theme-state", theme);
      button.setAttribute("title", isDark ? "Cambiar a claro" : "Cambiar a oscuro");
      button.setAttribute("aria-label", isDark ? "Cambiar a claro" : "Cambiar a oscuro");
      const text = button.querySelector(".theme-toggle-text");
      if (text) text.textContent = isDark ? "Oscuro" : "Claro";
    });
  }

  function applyTheme(theme, persist = true) {
    const safeTheme = theme === "dark" ? "dark" : "light";
    const body = document.body;

    root.setAttribute("data-f360-theme", safeTheme);
    root.dataset.f360Theme = safeTheme;
    root.classList.toggle("f360-theme-dark", safeTheme === "dark");
    root.classList.toggle("f360-theme-light", safeTheme === "light");

    if (body) {
      body.setAttribute("data-f360-theme", safeTheme);
      body.dataset.f360Theme = safeTheme;
      body.classList.toggle("f360-theme-dark", safeTheme === "dark");
      body.classList.toggle("f360-theme-light", safeTheme === "light");
    }

    if (persist) {
      safeStorageSet(THEME_KEY, safeTheme);
      LEGACY_KEYS.forEach((key) => safeStorageSet(key, safeTheme));
    }

    updateThemeToggle(safeTheme);
  }

  function toggleTheme() {
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
  }

  function createThemeToggleButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "f360-theme-toggle";
    button.setAttribute("data-f360-theme-toggle", "true");
    button.innerHTML = `<span class="theme-toggle-track" aria-hidden="true"></span><span class="theme-toggle-text">Claro</span>`;
    return button;
  }

  function isThemeToggleTarget(target) {
    return target?.closest?.(".f360-theme-toggle, [data-f360-theme-toggle]") || null;
  }

  function runThemeToggle(event) {
    const now = Date.now();
    if (now - lastThemeToggleAt < 180) {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      event?.stopImmediatePropagation?.();
      return;
    }
    lastThemeToggleAt = now;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
    toggleTheme();
  }

  function bindThemeButton(button) {
    if (!button) return;
    button.type = "button";
    button.disabled = false;
    button.removeAttribute("disabled");
    button.setAttribute("data-f360-theme-toggle", "true");
    button.style.pointerEvents = "auto";

    if (button.dataset.f360ThemeBound === "true") return;
    button.dataset.f360ThemeBound = "true";

    button.addEventListener("pointerup", runThemeToggle, true);
    button.addEventListener("click", runThemeToggle, true);
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") runThemeToggle(event);
    }, true);
  }

  function bindThemeToggleDelegatedEvents() {
    if (window.__f360ThemeToggleDelegatedBound) return;
    window.__f360ThemeToggleDelegatedBound = true;

    const handler = (event) => {
      const button = isThemeToggleTarget(event.target);
      if (!button) return;
      bindThemeButton(button);
      runThemeToggle(event);
    };

    document.addEventListener("pointerup", handler, true);
    document.addEventListener("click", handler, true);
    document.addEventListener("keydown", (event) => {
      const button = isThemeToggleTarget(event.target);
      if (!button) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      bindThemeButton(button);
      runThemeToggle(event);
    }, true);
  }

  function getThemeToggle() {
    const buttons = Array.from(document.querySelectorAll(".f360-theme-toggle, [data-f360-theme-toggle]"));
    const [mainButton, ...duplicates] = buttons;
    duplicates.forEach((button) => button.remove());
    return mainButton || createThemeToggleButton();
  }

  function placeThemeToggle(button) {
    const sideNav = document.querySelector("#app .side-nav") || document.querySelector(".side-nav");
    const sideFooter = sideNav?.querySelector(".side-footer");

    button.classList.remove("theme-toggle-floating");
    button.type = "button";
    bindThemeButton(button);

    if (sideFooter) {
      const userBox = sideFooter.querySelector(".side-user");
      if (button.parentElement !== sideFooter) {
        if (userBox?.nextSibling) sideFooter.insertBefore(button, userBox.nextSibling);
        else if (userBox) sideFooter.appendChild(button);
        else sideFooter.insertBefore(button, sideFooter.firstChild);
      }
      button.classList.add("in-side-nav");
      button.dataset.placement = "sidebar";
      return;
    }

    if (sideNav) {
      if (button.parentElement !== sideNav) sideNav.appendChild(button);
      button.classList.add("in-side-nav");
      button.dataset.placement = "sidebar";
      return;
    }

    if (button.parentElement !== document.body) document.body.appendChild(button);
    button.classList.remove("in-side-nav");
    button.classList.add("theme-toggle-floating");
    button.dataset.placement = "floating";
  }

  function ensureThemeToggle() {
    const button = getThemeToggle();
    placeThemeToggle(button);
    bindThemeButton(button);
    updateThemeToggle(currentTheme());
  }

  function startThemeToggleObserver() {
    if (themeToggleObserverStarted || !window.MutationObserver) return;
    themeToggleObserverStarted = true;

    let scheduled = false;
    const schedulePlace = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        ensureThemeToggle();
      });
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes?.length || mutation.removedNodes?.length) {
          schedulePlace();
          break;
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    window.setTimeout(ensureThemeToggle, 50);
    window.setTimeout(ensureThemeToggle, 250);
    window.setTimeout(ensureThemeToggle, 700);
  }

  function setPointer(x, y) {
    root.style.setProperty("--pointer-x", `${x}px`);
    root.style.setProperty("--pointer-y", `${y}px`);
    document.body?.classList.add("neon-pointer-active");
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => document.body?.classList.remove("neon-pointer-active"), 900);
  }

  function initThemeLayer() {
    applyTheme(preferredTheme(), false);
    bindThemeToggleDelegatedEvents();
    ensureThemeToggle();
    startThemeToggleObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initThemeLayer, { once: true });
  } else {
    initThemeLayer();
  }

  window.addEventListener("storage", (event) => {
    if ([THEME_KEY, ...LEGACY_KEYS].includes(event.key) && (event.newValue === "dark" || event.newValue === "light")) {
      applyTheme(event.newValue, false);
    }
  });

  document.addEventListener("pointermove", (event) => {
    setPointer(event.clientX, event.clientY);

    const card = event.target.closest?.(".topbar, .hero-card, .card, .metric, .section-card, .auth-card, .create-household-card, .boot-card, .setup-warning, .permission-card, .permission-control");
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100;
    const y = ((event.clientY - rect.top) / rect.height) * 100;
    card.style.setProperty("--mx", `${x}%`);
    card.style.setProperty("--my", `${y}%`);
  }, { passive: true });

  // V16 · Normaliza todos los switches simples para que usen el mismo DOM visual de Admin.
  function normalizeSwitchRows(scope = document) {
    const rootNode = scope?.querySelectorAll ? scope : document;
    const rows = rootNode.querySelectorAll("label.switch-row");

    rows.forEach((row) => {
      const directCheckbox = Array.from(row.children).find((child) =>
        child?.matches?.('input[type="checkbox"]')
      );

      if (!directCheckbox || directCheckbox.closest(".permission-switch")) return;

      const wrapper = document.createElement("span");
      wrapper.className = "permission-switch switch-row-switch";

      const track = document.createElement("span");
      track.className = "permission-switch-track";
      track.setAttribute("aria-hidden", "true");

      row.insertBefore(wrapper, directCheckbox);
      wrapper.appendChild(directCheckbox);
      wrapper.appendChild(track);
      row.classList.add("switch-row-normalized");
    });
  }

  function initSwitchRowNormalizer() {
    normalizeSwitchRows(document);

    const target = document.getElementById("app") || document.body;
    if (!target || !window.MutationObserver || switchObserverStarted) return;
    switchObserverStarted = true;

    let scheduled = false;
    const scheduleNormalize = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        normalizeSwitchRows(target);
      });
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes && mutation.addedNodes.length) {
          scheduleNormalize();
          break;
        }
      }
    });

    observer.observe(target, { childList: true, subtree: true });
    window.setTimeout(() => normalizeSwitchRows(target), 80);
    window.setTimeout(() => normalizeSwitchRows(target), 300);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSwitchRowNormalizer, { once: true });
  } else {
    initSwitchRowNormalizer();
  }
})();

// V25 · Responsive helpers reales para móvil/tablet.
// No toca Supabase ni cálculos: solo mejora UI, tablas, meses y secciones plegables.
(() => {
  let observerStarted = false;
  let scheduled = false;
  const compactMql = window.matchMedia ? window.matchMedia('(max-width: 980px)') : { matches: false, addEventListener() {} };
  const COLLAPSE_KEY = 'f360.mobile.collapsed.sections.v25';
  const SESSION_KEY = 'f360.mobile.compact.mode.v25';

  function getRoot() {
    return document.getElementById('app') || document.body;
  }

  function safeJsonRead(key, fallback) {
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function safeJsonWrite(key, value) {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  function activeSectionKey() {
    const active = document.querySelector('.app-old-mirror .old-menu button.active[data-section]');
    return active?.getAttribute('data-section') || 'dashboard';
  }

  function labelResponsiveTables(scope = document) {
    const root = scope?.querySelectorAll ? scope : document;
    root.querySelectorAll('.app-old-mirror table').forEach((table) => {
      table.classList.add('f360-responsive-table');
      const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent.trim());
      table.querySelectorAll('tbody tr').forEach((row) => {
        Array.from(row.children).forEach((cell, index) => {
          if (!cell || cell.nodeType !== 1) return;
          const label = headers[index] || cell.getAttribute('data-label') || (index === row.children.length - 1 ? 'Acciones' : '');
          if (label) cell.setAttribute('data-label', label);
        });
      });
    });
  }

  function markScrollableAreas(scope = document) {
    const root = scope?.querySelectorAll ? scope : document;
    root.querySelectorAll('.app-old-mirror .old-menu, .app-old-mirror .month-strip, .app-old-mirror .chart-bars, .app-old-mirror .table-wrap').forEach((el) => {
      el.setAttribute('data-f360-scrollable', 'true');
    });
  }

  function monthLabel(value) {
    if (!/^\d{4}-\d{2}$/.test(String(value || ''))) return String(value || '');
    const [year, month] = String(value).split('-').map(Number);
    const date = new Date(year, month - 1, 1);
    const label = date.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  function monthOptions(centerValue) {
    const now = /^\d{4}-\d{2}$/.test(String(centerValue || ''))
      ? new Date(Number(centerValue.slice(0, 4)), Number(centerValue.slice(5, 7)) - 1, 1)
      : new Date();
    const options = [];
    for (let offset = -12; offset <= 3; offset += 1) {
      const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      options.push(value);
    }
    return Array.from(new Set(options));
  }

  function createMonthSelect(value, className = 'f360-month-select') {
    const select = document.createElement('select');
    select.className = className;
    monthOptions(value).forEach((optionValue) => {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = monthLabel(optionValue);
      option.selected = optionValue === value;
      select.appendChild(option);
    });
    return select;
  }

  function enhanceMonthInputs(scope = document) {
    const root = scope?.querySelectorAll ? scope : document;
    root.querySelectorAll('.app-old-mirror input[type="month"]').forEach((input) => {
      if (input.dataset.f360MonthProxy === 'true') return;
      input.dataset.f360MonthProxy = 'true';
      input.classList.add('f360-has-month-proxy');

      const proxy = document.createElement('div');
      proxy.className = 'f360-month-picker-proxy';
      const select = createMonthSelect(input.value || new Date().toISOString().slice(0, 7), 'f360-month-proxy-select');
      proxy.appendChild(select);
      input.insertAdjacentElement('afterend', proxy);

      select.addEventListener('change', () => {
        input.value = select.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  }

  function simplifyMonthHistory(scope = document) {
    const root = scope?.querySelectorAll ? scope : document;
    root.querySelectorAll('.app-old-mirror .month-history-card').forEach((card) => {
      const strip = card.querySelector(':scope > .month-strip') || card.querySelector('.month-strip');
      if (!strip) return;
      strip.classList.add('f360-month-original');

      let panel = card.querySelector(':scope > .f360-month-mobile-panel');
      if (!panel) {
        panel = document.createElement('div');
        panel.className = 'f360-month-mobile-panel';
        strip.insertAdjacentElement('afterend', panel);
      }

      const buttons = Array.from(strip.querySelectorAll('.month-pill[data-set-month]'));
      if (!buttons.length) return;
      const activeButton = buttons.find((button) => button.classList.contains('active')) || buttons[0];
      const activeValue = activeButton.getAttribute('data-set-month') || '';
      const activeStrong = activeButton.querySelector('strong')?.textContent?.trim() || monthLabel(activeValue);
      const activeSpan = activeButton.querySelector('span')?.textContent?.trim() || '';

      const signature = buttons.map((button) => `${button.getAttribute('data-set-month') || ''}:${button.textContent.trim()}:${button.classList.contains('active') ? '1' : '0'}`).join('|');
      if (panel.dataset.f360MonthSignature === signature) return;
      panel.dataset.f360MonthSignature = signature;
      panel.innerHTML = '';
      const current = document.createElement('div');
      current.className = 'f360-month-current';
      current.innerHTML = `<div><strong>${activeStrong}</strong><span>${activeSpan}</span></div><small>Mes activo</small>`;

      const select = document.createElement('select');
      select.className = 'f360-month-select';
      buttons.forEach((button) => {
        const option = document.createElement('option');
        option.value = button.getAttribute('data-set-month') || '';
        option.textContent = `${button.querySelector('strong')?.textContent?.trim() || monthLabel(option.value)} · ${button.querySelector('span')?.textContent?.trim() || ''}`;
        option.selected = button === activeButton;
        select.appendChild(option);
      });
      select.addEventListener('change', () => {
        const escaped = window.CSS?.escape ? CSS.escape(select.value) : String(select.value).replace(/"/g, '\"');
        const target = strip.querySelector(`.month-pill[data-set-month="${escaped}"]`);
        target?.click();
      });

      panel.appendChild(current);
      panel.appendChild(select);
    });
  }

  function ensureCompactToolbar() {
    const content = document.querySelector('.app-old-mirror .content-area.old-content');
    if (!content) return;
    let toolbar = content.querySelector(':scope > .f360-compact-toolbar');
    if (!toolbar) {
      toolbar = document.createElement('div');
      toolbar.className = 'f360-compact-toolbar';
      toolbar.innerHTML = `<span>Vista móvil compacta</span><button class="btn ghost small" type="button" data-f360-toggle-all>Expandir todo</button>`;
      content.insertBefore(toolbar, content.firstChild);
    }
    updateCompactToolbar(toolbar);
  }

  function updateCompactToolbar(toolbar = document.querySelector('.f360-compact-toolbar')) {
    if (!toolbar) return;
    const cards = Array.from(document.querySelectorAll('.app-old-mirror .section-card.f360-collapsible'));
    const collapsed = cards.filter((card) => card.classList.contains('f360-collapsed')).length;
    const button = toolbar.querySelector('[data-f360-toggle-all]');
    const nextText = collapsed ? 'Expandir todo' : 'Contraer secciones';
    if (button && button.textContent !== nextText) button.textContent = nextText;
  }

  function sectionCardTitle(card) {
    const header = Array.from(card.children).find((child) => child?.matches?.('h4'));
    return header?.textContent?.trim() || '';
  }

  function shouldSkipCollapse(card) {
    return card.classList.contains('quick-period-card') ||
      card.classList.contains('month-history-card') ||
      card.classList.contains('help-card') ||
      card.closest('.old-period') ||
      !sectionCardTitle(card);
  }

  function cardKey(card, title) {
    return `${activeSectionKey()}::${title.toLowerCase().replace(/\s+/g, ' ').slice(0, 90)}`;
  }

  function setCollapsed(card, collapsed, persist = true) {
    const isCollapsed = Boolean(collapsed);
    const button = card.querySelector(':scope > .f360-card-toolbar .f360-collapse-toggle');
    const body = card.querySelector(':scope > .f360-collapse-body');

    card.classList.toggle('f360-collapsed', isCollapsed);
    card.setAttribute('aria-expanded', String(!isCollapsed));

    if (body) {
      body.hidden = isCollapsed;
      body.setAttribute('aria-hidden', String(isCollapsed));
      body.style.display = isCollapsed ? 'none' : '';
      body.style.height = isCollapsed ? '0px' : '';
      body.style.minHeight = isCollapsed ? '0px' : '';
      body.style.overflow = isCollapsed ? 'hidden' : '';
    }

    if (button) {
      button.setAttribute('aria-expanded', String(!isCollapsed));
      button.textContent = isCollapsed ? 'Abrir' : 'Cerrar';
    }
    if (persist) {
      const title = card.dataset.f360CollapseTitle || '';
      const key = card.dataset.f360CollapseKey || cardKey(card, title);
      const store = safeJsonRead(COLLAPSE_KEY, {});
      store[key] = isCollapsed;
      safeJsonWrite(COLLAPSE_KEY, store);
    }
    updateCompactToolbar();
  }


  function disableDashboardAccordions(scope = document) {
    // Evita tarjetas vacías: antes el helper convertía gráficas y resúmenes en acordeones.
    // Al volver de móvil/tablet a escritorio quedaban cuerpos ocultos por estilos inline/sessionStorage.
    const root = scope?.querySelectorAll ? scope : document;
    document.querySelectorAll('.f360-compact-toolbar').forEach((toolbar) => toolbar.remove());

    root.querySelectorAll('.app-old-mirror .section-card.f360-collapsible').forEach((card) => {
      const toolbar = card.querySelector(':scope > .f360-card-toolbar');
      const body = card.querySelector(':scope > .f360-collapse-body');
      const title = toolbar?.querySelector('h4');

      if (title && toolbar) card.insertBefore(title, toolbar);
      if (body) {
        body.hidden = false;
        body.removeAttribute('aria-hidden');
        body.style.display = '';
        body.style.height = '';
        body.style.minHeight = '';
        body.style.maxHeight = '';
        body.style.overflow = '';
        while (body.firstChild) card.appendChild(body.firstChild);
        body.remove();
      }
      toolbar?.remove();
      card.classList.remove('f360-collapsible', 'f360-collapsed');
      card.removeAttribute('aria-expanded');
      delete card.dataset.f360Collapsible;
      delete card.dataset.f360CollapseTitle;
      delete card.dataset.f360CollapseKey;
    });
  }

  function enhanceCollapsibleSections(scope = document) {
    const content = document.querySelector('.app-old-mirror .content-area.old-content');
    if (!content) return;

    const cards = Array.from(content.querySelectorAll('.section-card')).filter((card) => !shouldSkipCollapse(card));
    const store = safeJsonRead(COLLAPSE_KEY, {});
    const compactDefault = safeJsonRead(SESSION_KEY, null);

    cards.forEach((card, index) => {
      if (card.dataset.f360Collapsible === 'true') return;
      const title = sectionCardTitle(card);
      if (!title) return;
      const key = cardKey(card, title);
      const h4 = Array.from(card.children).find((child) => child?.matches?.('h4'));
      if (!h4) return;

      const toolbar = document.createElement('div');
      toolbar.className = 'f360-card-toolbar';
      const button = document.createElement('button');
      button.className = 'f360-collapse-toggle';
      button.type = 'button';
      button.setAttribute('aria-expanded', 'true');
      button.textContent = 'Cerrar';

      card.insertBefore(toolbar, h4);
      toolbar.appendChild(h4);
      toolbar.appendChild(button);

      const body = document.createElement('div');
      body.className = 'f360-collapse-body';
      while (toolbar.nextSibling) body.appendChild(toolbar.nextSibling);
      card.appendChild(body);

      card.classList.add('f360-collapsible');
      card.dataset.f360Collapsible = 'true';
      card.dataset.f360CollapseTitle = title;
      card.dataset.f360CollapseKey = key;

      button.addEventListener('click', () => setCollapsed(card, !card.classList.contains('f360-collapsed')));

      let shouldCollapse = false;
      if (Object.prototype.hasOwnProperty.call(store, key)) {
        shouldCollapse = Boolean(store[key]);
      } else if (compactDefault === 'collapsed') {
        shouldCollapse = index >= 1;
      } else if (compactMql.matches) {
        shouldCollapse = index >= 3;
      }
      setCollapsed(card, shouldCollapse, false);
    });

    ensureCompactToolbar();
  }

  function bindGlobalCompactActions() {
    if (window.__f360CompactActionsBound) return;
    window.__f360CompactActionsBound = true;
    document.addEventListener('click', (event) => {
      const allButton = event.target.closest?.('[data-f360-toggle-all]');
      if (!allButton) return;
      event.preventDefault();
      const cards = Array.from(document.querySelectorAll('.app-old-mirror .section-card.f360-collapsible'));
      const anyCollapsed = cards.some((card) => card.classList.contains('f360-collapsed'));
      safeJsonWrite(SESSION_KEY, anyCollapsed ? 'expanded' : 'collapsed');
      cards.forEach((card) => setCollapsed(card, !anyCollapsed));
      updateCompactToolbar();
    }, true);
  }

  function apply(scope = document) {
    document.body.classList.remove('f360-mobile-nav-open');
    document.querySelectorAll('.f360-mobile-menu-toggle').forEach((button) => button.remove());
    labelResponsiveTables(scope);
    markScrollableAreas(scope);
    enhanceMonthInputs(scope);
    simplifyMonthHistory(scope);
    disableDashboardAccordions(scope);
    bindGlobalCompactActions();
  }

  function schedule(scope = document) {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      apply(scope);
    });
  }

  function startObserver() {
    if (observerStarted || !window.MutationObserver) return;
    observerStarted = true;
    const target = getRoot();
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes?.length || mutation.removedNodes?.length) {
          schedule(target);
          break;
        }
      }
    });
    observer.observe(target, { childList: true, subtree: true });
  }

  function init() {
    apply(document);
    startObserver();
    window.setTimeout(() => apply(document), 100);
    window.setTimeout(() => apply(document), 400);
    window.setTimeout(() => apply(document), 900);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  window.addEventListener('resize', () => schedule(document), { passive: true });
  if (compactMql.addEventListener) compactMql.addEventListener('change', () => schedule(document));
})();

// V26 · Ajustes finales de responsive real.
// Solo capa visual: acorta títulos KPI en móvil/tablet y garantiza que los acordeones no dejen huecos.
(() => {
  const compactMq = window.matchMedia ? window.matchMedia('(max-width: 1180px)') : { matches: false, addEventListener() {} };
  let raf = 0;

  function shortKpiLabel(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    const lower = clean.toLowerCase();
    if (lower.startsWith('ingresos de ')) return 'Ingresos';
    if (lower.startsWith('gastos de ')) return 'Gastos';
    if (lower.startsWith('balance de ')) return 'Balance';
    if (lower.startsWith('gasto asignado a ')) return 'Gasto asignado';
    if (lower === 'ahorro estimado') return 'Ahorro';
    if (lower === 'tu parte compartida') return 'Parte compartida';
    if (lower === 'categoría más cara' || lower === 'categoria más cara') return 'Top categoría';
    if (lower === 'variación de gastos' || lower === 'variacion de gastos') return 'Variación';
    return clean;
  }

  function normalizeKpis() {
    const compact = compactMq.matches;
    document.querySelectorAll('.app-old-mirror .old-kpi-grid .metric small').forEach((node) => {
      if (!node.dataset.f360OriginalLabel) node.dataset.f360OriginalLabel = node.textContent.trim();
      const original = node.dataset.f360OriginalLabel;
      const next = compact ? shortKpiLabel(original) : original;
      if (node.textContent.trim() !== next) node.textContent = next;
      node.title = original;
    });
  }

  function normalizeCollapsedCards() {
    document.querySelectorAll('.app-old-mirror .f360-collapsible').forEach((card) => {
      const body = card.querySelector(':scope > .f360-collapse-body');
      const button = card.querySelector(':scope > .f360-card-toolbar .f360-collapse-toggle');
      if (!body) return;
      const collapsed = card.classList.contains('f360-collapsed');
      body.hidden = collapsed;
      body.setAttribute('aria-hidden', String(collapsed));
      body.style.display = collapsed ? 'none' : '';
      body.style.height = collapsed ? '0px' : '';
      body.style.minHeight = collapsed ? '0px' : '';
      body.style.overflow = collapsed ? 'hidden' : '';
      card.setAttribute('aria-expanded', String(!collapsed));
      if (button) {
        button.setAttribute('aria-expanded', String(!collapsed));
        button.textContent = collapsed ? 'Abrir' : 'Cerrar';
      }
    });
  }

  function apply() {
    normalizeKpis();
    normalizeCollapsedCards();
  }

  function schedule() {
    if (raf) return;
    raf = window.requestAnimationFrame(() => {
      raf = 0;
      apply();
    });
  }

  function init() {
    apply();
    window.setTimeout(apply, 120);
    window.setTimeout(apply, 500);
    if (window.MutationObserver) {
      const root = document.getElementById('app') || document.body;
      const observer = new MutationObserver(schedule);
      observer.observe(root, { childList: true, subtree: true, characterData: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  window.addEventListener('resize', schedule, { passive: true });
  if (compactMq.addEventListener) compactMq.addEventListener('change', schedule);
})();

// V28 · UX foundation helpers.
// Solo mejora accesibilidad/experiencia: foco, navegación activa, inputs táctiles y tablas.
(() => {
  let scheduled = false;
  const compactMq = window.matchMedia ? window.matchMedia('(max-width: 1280px)') : { matches: false, addEventListener() {} };

  function rootApp() {
    return document.getElementById('app') || document.body;
  }

  function activeMenuButton() {
    return document.querySelector('.app-old-mirror .old-menu button.active[data-section]') ||
      document.querySelector('.app-old-mirror .old-menu button[aria-current="page"][data-section]');
  }

  function labelFromButton(button) {
    return button?.querySelector('b')?.textContent?.trim() || button?.textContent?.trim() || '';
  }

  function normalizeActiveNavigation() {
    const buttons = Array.from(document.querySelectorAll('.app-old-mirror .old-menu button[data-section]'));
    buttons.forEach((button) => {
      const active = button.classList.contains('active');
      if (active) {
        button.setAttribute('aria-current', 'page');
        button.setAttribute('aria-label', `Sección actual: ${labelFromButton(button)}`);
      } else {
        button.removeAttribute('aria-current');
        button.setAttribute('aria-label', `Abrir sección: ${labelFromButton(button)}`);
      }
    });

    const active = activeMenuButton();
    const app = rootApp();
    const section = active?.getAttribute('data-section') || '';
    if (section) app.setAttribute('data-f360-active-section', section);
    if (active && compactMq.matches) {
      active.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    }
  }

  function improveScrollableSemantics(scope = document) {
    const root = scope?.querySelectorAll ? scope : document;
    root.querySelectorAll('.app-old-mirror .table-wrap, .app-old-mirror .old-menu, .app-old-mirror .month-strip, .app-old-mirror .chart-bars').forEach((el) => {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      el.setAttribute('data-f360-scrollable', 'true');
      if (!el.getAttribute('aria-label')) {
        if (el.classList.contains('table-wrap')) el.setAttribute('aria-label', 'Tabla con desplazamiento');
        else if (el.classList.contains('old-menu')) el.setAttribute('aria-label', 'Menú principal desplazable');
        else if (el.classList.contains('month-strip')) el.setAttribute('aria-label', 'Selector de meses desplazable');
        else el.setAttribute('aria-label', 'Gráfica desplazable');
      }
    });
  }

  function improveFormInputs(scope = document) {
    const root = scope?.querySelectorAll ? scope : document;
    root.querySelectorAll('.app-old-mirror input[type="number"]').forEach((input) => {
      const name = String(input.name || input.id || '').toLowerCase();
      if (!input.getAttribute('inputmode')) {
        input.setAttribute('inputmode', name.includes('km') || name.includes('day') || name.includes('count') ? 'numeric' : 'decimal');
      }
    });

    root.querySelectorAll('.app-old-mirror input, .app-old-mirror select, .app-old-mirror textarea').forEach((control) => {
      if (!control.id && control.name) {
        const form = control.closest('form')?.id || 'field';
        control.id = `f360-${form}-${control.name}`.replace(/[^a-zA-Z0-9_-]/g, '-');
      }
      const label = control.closest('.field')?.querySelector('label');
      if (label && control.id && !label.getAttribute('for')) label.setAttribute('for', control.id);
    });
  }

  function markEmptyAndDenseCards(scope = document) {
    const root = scope?.querySelectorAll ? scope : document;
    root.querySelectorAll('.app-old-mirror .section-card').forEach((card) => {
      card.toggleAttribute('data-has-empty-state', Boolean(card.querySelector('.empty-state, .empty-mini')));
      const table = card.querySelector('table');
      if (table) card.setAttribute('data-card-kind', 'table');
      const form = card.querySelector('form');
      if (form) card.setAttribute('data-card-kind', 'form');
    });
  }

  function apply(scope = document) {
    normalizeActiveNavigation();
    improveScrollableSemantics(scope);
    improveFormInputs(scope);
    markEmptyAndDenseCards(scope);
    document.documentElement.classList.add('f360-ux-v28-ready');
  }

  function schedule(scope = document) {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      apply(scope);
    });
  }

  function init() {
    apply(document);
    window.setTimeout(() => apply(document), 120);
    window.setTimeout(() => apply(document), 450);
    if (window.MutationObserver) {
      const observer = new MutationObserver(() => schedule(document));
      observer.observe(rootApp(), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  window.addEventListener('resize', () => schedule(document), { passive: true });
  if (compactMq.addEventListener) compactMq.addEventListener('change', () => schedule(document));
})();

