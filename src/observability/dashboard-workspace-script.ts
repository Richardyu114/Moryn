export function dashboardWorkspaceScript(): string {
  return `
  <script>
    (() => {
      const interactionQuietMs = 900;
      const closeDurationMs = 220;
      let lastInteractionAt = 0;
      const markInteraction = () => { lastInteractionAt = Date.now(); };
      const isInteractionActive = () => {
        const drawer = document.querySelector('[data-dashboard-drawer]');
        return Date.now() - lastInteractionAt < interactionQuietMs || (drawer instanceof HTMLElement && !drawer.hidden);
      };
      window.dashboardWorkspaceInteraction = { mark: markInteraction, isActive: isInteractionActive };

      const initialize = () => {
        const root = document.querySelector('[data-dashboard-editorial-shell]');
        if (!(root instanceof HTMLElement) || root.dataset.workspaceReady === "true") return;
        root.dataset.workspaceReady = "true";
        const drawer = root.querySelector('[data-dashboard-drawer]');
        let lastTrigger = null;
        let closeTimer = null;
        let lockedScrollY = 0;

        const lockPageScroll = () => {
          lockedScrollY = window.scrollY;
          document.documentElement.classList.add('dashboard-drawer-open');
          document.body.style.top = '-' + lockedScrollY + 'px';
        };

        const unlockPageScroll = () => {
          document.documentElement.classList.remove('dashboard-drawer-open');
          document.body.style.top = '';
          window.scrollTo({ top: lockedScrollY, behavior: 'auto' });
        };

        const activateView = (view) => {
          markInteraction();
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

        const finishClose = (restoreFocus) => {
          if (!(drawer instanceof HTMLElement)) return;
          drawer.hidden = true;
          delete drawer.dataset.drawerState;
          delete drawer.dataset.activeDrawer;
          drawer.querySelectorAll('[data-drawer-payload]').forEach((payload) => { payload.hidden = true; });
          unlockPageScroll();
          if (restoreFocus && lastTrigger instanceof HTMLElement) lastTrigger.focus();
          lastTrigger = null;
          closeTimer = null;
        };

        const closeDrawer = ({ restoreFocus = true, immediate = false } = {}) => {
          if (!(drawer instanceof HTMLElement) || drawer.hidden) return;
          markInteraction();
          if (closeTimer) window.clearTimeout(closeTimer);
          if (immediate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            finishClose(restoreFocus);
            return;
          }
          drawer.dataset.drawerState = "closing";
          closeTimer = window.setTimeout(() => finishClose(restoreFocus), closeDurationMs);
        };

        const openDrawer = (id, trigger = null, options = {}) => {
          if (!(drawer instanceof HTMLElement)) return false;
          const payload = Array.from(drawer.querySelectorAll('[data-drawer-payload]')).find((item) => item.dataset.drawerPayload === id);
          if (!(payload instanceof HTMLElement)) return false;
          markInteraction();
          if (closeTimer) { window.clearTimeout(closeTimer); closeTimer = null; }
          drawer.querySelectorAll('[data-drawer-payload]').forEach((item) => { item.hidden = item !== payload; });
          const wasHidden = drawer.hidden;
          if (wasHidden) lockPageScroll();
          drawer.hidden = false;
          drawer.dataset.activeDrawer = id;
          if (trigger instanceof HTMLElement) lastTrigger = trigger;
          if (wasHidden) {
            drawer.dataset.drawerState = "opening";
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(() => { if (!drawer.hidden) drawer.dataset.drawerState = "open"; });
            });
          } else {
            drawer.dataset.drawerState = "open";
          }
          const focusTarget = drawer.querySelector('[data-dashboard-drawer-close]') || drawer.querySelector('[tabindex="-1"]');
          if (options.focus !== false && focusTarget instanceof HTMLElement) focusTarget.focus({ preventScroll: true });
          window.applyDashboardLanguage?.();
          return true;
        };

        const capture = () => ({
          view: root.querySelector('[data-dashboard-nav][aria-current="page"]')?.dataset.dashboardNav || 'workspace',
          drawer: drawer instanceof HTMLElement && !drawer.hidden ? drawer.dataset.activeDrawer || null : null,
          scrollY: document.documentElement.classList.contains('dashboard-drawer-open') ? lockedScrollY : window.scrollY
        });

        const restore = (state) => {
          activateView(state?.view || 'workspace');
          if (state?.drawer) openDrawer(state.drawer, null, { focus: true });
          else window.scrollTo({ top: Number(state?.scrollY || 0), behavior: 'auto' });
          window.applyDashboardLanguage?.();
        };

        root.addEventListener('pointerdown', markInteraction, { passive: true });
        root.addEventListener('touchmove', markInteraction, { passive: true });
        root.addEventListener('wheel', markInteraction, { passive: true });
        root.addEventListener('focusin', markInteraction);
        window.addEventListener('scroll', markInteraction, { passive: true });

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
          markInteraction();
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
      window.restoreDashboardWorkspaceAfterFragment = (state) => {
        initialize();
        window.dashboardWorkspaceState?.restore(state);
      };
      initialize();
    })();
  </script>`;
}
