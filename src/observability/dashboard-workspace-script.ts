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

        const replayEntrance = (section) => {
          if (!(section instanceof HTMLElement)) return;
          if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
          const targets = section.querySelectorAll('[data-editorial-section], .editorial-sidebar, .editorial-view-page > header, .editorial-view-page > .memory-search, .editorial-view-page > .history-timeline');
          targets.forEach((el) => {
            if (!(el instanceof HTMLElement)) return;
            el.style.animation = 'none';
            void el.offsetWidth;
            el.style.animation = '';
          });
        };
        const activateView = (view) => {
          markInteraction();
          let shown = null;
          root.querySelectorAll('[data-dashboard-view]').forEach((section) => {
            const active = section.dataset.dashboardView === view;
            section.hidden = !active;
            if (active) shown = section;
          });
          root.querySelectorAll('[data-dashboard-nav]').forEach((button) => {
            if (!(button instanceof HTMLElement)) return;
            const active = button.dataset.dashboardNav === view;
            if (active) button.setAttribute('aria-current', 'page');
            else button.removeAttribute('aria-current');
          });
          replayEntrance(shown);
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

        const responseJson = async (response) => {
          const text = await response.text();
          if (!text) return {};
          try { return JSON.parse(text); } catch { return { ok: false, message: text }; }
        };
        const setDecisionStatus = (status, en, zh = en) => {
          if (!(status instanceof HTMLElement)) return;
          status.dataset.i18nEn = en;
          status.dataset.i18nZh = zh;
          status.textContent = window.currentDashboardLanguage?.() === "zh" ? zh : en;
        };
        const refreshDecisionFragment = async () => {
          const main = document.querySelector("main");
          if (!(main instanceof HTMLElement)) return;
          const workspaceState = window.dashboardWorkspaceState?.capture();
          const response = await fetch("fragment", { cache: "no-store" });
          if (!response.ok) return;
          main.innerHTML = await response.text();
          window.restoreDashboardMaintenanceDismissals?.();
          window.restoreDashboardWorkspaceAfterFragment?.(workspaceState);
          window.applyDashboardLanguage?.();
          window.restoreActionReceipt?.();
        };
        const setupDecisionCards = () => {
          root.addEventListener('click', async (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            const button = target.closest('[data-decision-action]');
            if (!(button instanceof HTMLButtonElement)) return;
            const endpoint = button.dataset.decisionEndpoint;
            if (!endpoint) return;
            markInteraction();
            const card = button.closest('[data-decision-card]');
            const status = card instanceof HTMLElement ? card.querySelector('[data-decision-status]') : null;
            const isReject = button.dataset.decisionAction === 'reject';
            const buttons = card instanceof HTMLElement ? card.querySelectorAll('[data-decision-action]') : [button];
            buttons.forEach((el) => { if (el instanceof HTMLButtonElement) el.disabled = true; });
            setDecisionStatus(
              status,
              isReject ? "Discarding..." : button.dataset.decisionLoadingEn || "Applying...",
              isReject ? "正在丢弃..." : button.dataset.decisionLoadingZh || "正在执行..."
            );
            let body = {};
            try { body = JSON.parse(button.dataset.decisionBody || "{}"); } catch { body = {}; }
            try {
              const response = await fetch(endpoint, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body)
              });
              const result = await responseJson(response);
              if (!response.ok || result.ok === false) {
                setDecisionStatus(status, result.message || "Action failed.", result.message || "操作失败。");
                buttons.forEach((el) => { if (el instanceof HTMLButtonElement) el.disabled = false; });
                return;
              }
              setDecisionStatus(status, isReject ? "Discarded. Refreshing..." : "Saved. Refreshing...", isReject ? "已丢弃，正在刷新..." : "已记住，正在刷新...");
              window.renderActionReceipt?.(result);
              await refreshDecisionFragment();
            } catch (error) {
              setDecisionStatus(status, error instanceof Error ? error.message : "Action failed.", error instanceof Error ? error.message : "操作失败。");
              buttons.forEach((el) => { if (el instanceof HTMLButtonElement) el.disabled = false; });
            }
          });
        };
        setupDecisionCards();

        const setupMemorySearch = () => {
          const container = root.querySelector('[data-memory-search]');
          if (!(container instanceof HTMLElement)) return;
          const input = container.querySelector('[data-memory-search-input]');
          const results = Array.from(container.querySelectorAll('[data-memory-result]'));
          const countEl = container.querySelector('[data-memory-search-count]');
          const noResults = container.querySelector('[data-memory-search-noresults]');
          const chips = Array.from(container.querySelectorAll('[data-memory-chip]'));
          if (!(input instanceof HTMLInputElement)) return;
          const total = Number(countEl?.dataset.total || results.length);
          let activeKind = 'all';
          const apply = () => {
            const query = input.value.trim().toLowerCase();
            let shown = 0;
            results.forEach((result) => {
              if (!(result instanceof HTMLElement)) return;
              const text = result.dataset.searchText || '';
              const kind = result.dataset.kind || '';
              const match = (query === '' || text.includes(query)) && (activeKind === 'all' || kind === activeKind);
              result.hidden = !match;
              if (match) shown += 1;
            });
            if (noResults instanceof HTMLElement) noResults.hidden = shown !== 0;
            if (countEl instanceof HTMLElement) {
              const filtered = query !== '' || activeKind !== 'all';
              const en = filtered ? shown + ' of ' + total : total + (total === 1 ? ' memory' : ' memories');
              const zh = filtered ? total + ' 条中的 ' + shown + ' 条' : total + ' 条记忆';
              countEl.dataset.i18nEn = en;
              countEl.dataset.i18nZh = zh;
              countEl.textContent = en;
              window.applyDashboardLanguage?.();
            }
          };
          chips.forEach((chip) => {
            chip.addEventListener('click', () => {
              activeKind = chip.dataset.chipKind || 'all';
              chips.forEach((other) => other.setAttribute('aria-pressed', other === chip ? 'true' : 'false'));
              apply();
            });
          });
          input.addEventListener('input', apply);
        };
        setupMemorySearch();

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
