export function dashboardWorkspaceScript(): string {
  return `
  <script>
    (() => {
      const initialize = () => {
        const root = document.querySelector('[data-dashboard-editorial-shell]');
        if (!(root instanceof HTMLElement) || root.dataset.workspaceReady === "true") return;
        root.dataset.workspaceReady = "true";
        const drawer = root.querySelector('[data-dashboard-drawer]');
        let lastTrigger = null;

        const activateView = (view) => {
          root.querySelectorAll('[data-dashboard-view]').forEach((section) => {
            section.hidden = section.dataset.dashboardView !== view;
          });
          root.querySelectorAll('[data-dashboard-nav]').forEach((button) => {
            if (!(button instanceof HTMLElement)) return;
            const active = button.dataset.dashboardNav === view;
            if (active) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
          });
          window.applyDashboardLanguage?.();
        };

        const closeDrawer = ({ restoreFocus = true } = {}) => {
          if (!(drawer instanceof HTMLElement)) return;
          drawer.hidden = true;
          delete drawer.dataset.activeDrawer;
          drawer.querySelectorAll('[data-drawer-payload]').forEach((payload) => { payload.hidden = true; });
          if (restoreFocus && lastTrigger instanceof HTMLElement) lastTrigger.focus();
          lastTrigger = null;
        };

        const openDrawer = (id, trigger = null, options = {}) => {
          if (!(drawer instanceof HTMLElement)) return false;
          const payload = Array.from(drawer.querySelectorAll('[data-drawer-payload]')).find((item) => item.dataset.drawerPayload === id);
          if (!(payload instanceof HTMLElement)) return false;
          drawer.querySelectorAll('[data-drawer-payload]').forEach((item) => { item.hidden = item !== payload; });
          drawer.hidden = false;
          drawer.dataset.activeDrawer = id;
          if (trigger instanceof HTMLElement) lastTrigger = trigger;
          const focusTarget = drawer.querySelector('[data-dashboard-drawer-close]') || drawer.querySelector('[tabindex="-1"]');
          if (options.focus !== false && focusTarget instanceof HTMLElement) focusTarget.focus();
          window.applyDashboardLanguage?.();
          return true;
        };

        const capture = () => ({
          view: root.querySelector('[data-dashboard-nav][aria-current="page"]')?.dataset.dashboardNav || 'workspace',
          drawer: drawer instanceof HTMLElement && !drawer.hidden ? drawer.dataset.activeDrawer || null : null,
          scrollY: window.scrollY
        });

        const restore = (state) => {
          activateView(state?.view || 'workspace');
          if (state?.drawer) openDrawer(state.drawer, null, { focus: false });
          window.scrollTo({ top: Number(state?.scrollY || 0), behavior: 'auto' });
          window.applyDashboardLanguage?.();
        };

        root.addEventListener('click', (event) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          const nav = target.closest('[data-dashboard-nav]');
          if (nav instanceof HTMLElement) {
            activateView(nav.dataset.dashboardNav || 'workspace');
            return;
          }
          const trigger = target.closest('[data-drawer-target]');
          if (trigger instanceof HTMLElement) {
            openDrawer(trigger.dataset.drawerTarget || '', trigger);
            return;
          }
          if (target.closest('[data-dashboard-drawer-close]')) closeDrawer();
          else if (target === drawer) closeDrawer();
        });

        root.addEventListener('keydown', (event) => {
          if (event.key === 'Escape' && drawer instanceof HTMLElement && !drawer.hidden) {
            event.preventDefault();
            closeDrawer();
            return;
          }
          if (event.key !== 'Tab' || !(drawer instanceof HTMLElement) || drawer.hidden) return;
          const focusable = Array.from(drawer.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((item) => item instanceof HTMLElement && !item.hidden);
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        });

        window.dashboardWorkspaceState = { activateView, openDrawer, closeDrawer, capture, restore, initialize };
      };
      window.initializeDashboardWorkspace = initialize;
      initialize();
    })();
  </script>`;
}
