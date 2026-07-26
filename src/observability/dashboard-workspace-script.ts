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
          const selector = section.dataset.dashboardView === 'preferences'
            ? '.editorial-view-page > header, [data-preferences-motion]'
            : '[data-editorial-section], .editorial-sidebar, .editorial-view-page > header, .editorial-view-page > .memory-search, .editorial-view-page > .history-timeline, .editorial-view-page > .v04-dashboard-sections';
          const targets = section.querySelectorAll(selector);
          targets.forEach((el, index) => {
            if (!(el instanceof HTMLElement)) return;
            if (typeof el.animate === 'function') {
              el.getAnimations().forEach((animation) => animation.cancel());
              el.animate(
                [
                  { opacity: 0, transform: 'translateY(24px)' },
                  { opacity: 1, transform: 'translateY(0)' }
                ],
                {
                  duration: 620,
                  delay: index * 80,
                  easing: 'cubic-bezier(.2,.7,.2,1)',
                  fill: 'both'
                }
              );
              return;
            }
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
          const restoredDrawer = state?.drawer ? openDrawer(state.drawer, null, { focus: true }) : false;
          if (!restoredDrawer) {
            document.documentElement.classList.remove('dashboard-drawer-open');
            document.body.style.top = '';
            window.scrollTo({ top: Number(state?.scrollY || 0), behavior: 'auto' });
          }
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
          const resultsContainer = container.querySelector('[data-memory-search-results]');
          const countEl = container.querySelector('[data-memory-search-count]');
          const noResults = container.querySelector('[data-memory-search-noresults]');
          const moreButton = container.querySelector('[data-memory-search-more]');
          const chips = Array.from(container.querySelectorAll('[data-memory-chip]'));
          if (!(input instanceof HTMLInputElement) || !(resultsContainer instanceof HTMLElement)) return;
          const endpoint = container.dataset.memorySearchEndpoint || '';
          const initialResultsHtml = resultsContainer.innerHTML;
          const initialTotal = Number(countEl?.dataset.total || container.querySelectorAll('[data-memory-result]').length);
          let activeKind = 'all';
          let searchSequence = 0;
          let remoteOffset = 0;
          let remoteDrawerSequence = 0;
          let debounceTimer = null;
          const remoteDrawerIds = new Map();

          const localizedNode = (tag, en, zh, className = '') => {
            const node = document.createElement(tag);
            if (className) node.className = className;
            node.dataset.i18nEn = en;
            node.dataset.i18nZh = zh;
            node.textContent = en;
            return node;
          };
          const kindCopy = (kind) => ({
            memory: { en: 'Memory', zh: '记忆' },
            skill: { en: 'Skill', zh: '技能' },
            soul: { en: 'Profile', zh: '个人设定' },
            session_summary: { en: 'Session note', zh: '会话记录' },
            agent_note: { en: 'Agent note', zh: 'Agent 记录' }
          })[kind] || { en: 'Saved item', zh: '已保存内容' };
          const stateCopy = (state) => ({
            canonical: { en: 'Ready to use', zh: '可直接使用' },
            candidate: { en: 'Saved for later', zh: '已保存，稍后整理' },
            raw: { en: 'Saved briefly', zh: '临时保存' },
            archived: { en: 'Archived', zh: '已归档' },
            quarantined: { en: 'Set aside', zh: '已放一边' }
          })[state] || { en: 'Set aside', zh: '已放一边' };
          const sourceCopy = (source) => {
            const client = String(source?.client || '').trim();
            const normalized = client.toLowerCase();
            if (normalized === 'codex') return { en: 'Codex', zh: 'Codex' };
            if (normalized === 'claude') return { en: 'Claude', zh: 'Claude' };
            if (normalized === 'user') return { en: 'you', zh: '用户' };
            if (normalized === 'moryn' || normalized === 'moryn-local') return { en: 'Moryn', zh: 'Moryn' };
            if (normalized === 'protected-history') return { en: 'a protected source', zh: '受保护来源' };
            return { en: client || 'unknown source', zh: client || '未知来源' };
          };
          const clippedText = (value, limit = 220) => {
            const text = String(value || '').replace(/\\s+/g, ' ').trim();
            return text.length <= limit ? text : text.slice(0, limit).replace(/\\s+\\S*$/, '').trim() + '…';
          };
          const drawerIdForRecord = (record) => {
            const recordId = String(record.id || 'unknown');
            const existing = remoteDrawerIds.get(recordId);
            if (existing) return existing;
            const generated = 'remote-record-' + String(++remoteDrawerSequence);
            remoteDrawerIds.set(recordId, generated);
            return generated;
          };
          const addMetadata = (list, labelEn, labelZh, value) => {
            const row = document.createElement('div');
            row.append(localizedNode('dt', labelEn, labelZh));
            const item = document.createElement('dd');
            item.textContent = String(value ?? '—');
            row.append(item);
            list.append(row);
          };
          const addCommand = (parent, labelEn, labelZh, command) => {
            if (!command) return;
            const row = document.createElement('div');
            row.className = 'editorial-drawer-cmd';
            row.append(localizedNode('span', labelEn, labelZh));
            const code = document.createElement('code');
            code.lang = 'en';
            code.textContent = command;
            row.append(code);
            parent.append(row);
          };
          const ensureRemoteDrawer = (record) => {
            const drawerId = drawerIdForRecord(record);
            const drawerPanel = drawer instanceof HTMLElement ? drawer.querySelector('.editorial-drawer-panel') : null;
            if (!(drawerPanel instanceof HTMLElement)) return drawerId;
            const existing = Array.from(drawerPanel.querySelectorAll('[data-drawer-payload]')).find((item) => item.dataset.drawerPayload === drawerId);
            if (existing) return drawerId;
            const kind = kindCopy(record.kind);
            const state = stateCopy(record.state);
            const source = sourceCopy(record.source);
            const section = document.createElement('section');
            section.dataset.drawerPayload = drawerId;
            section.hidden = true;
            section.append(localizedNode('div', kind.en, kind.zh, 'editorial-eyebrow'));
            section.append(localizedNode('h2', kind.en, kind.zh, 'editorial-drawer-title'));
            section.append(localizedNode(
              'p',
              kind.en + ' · ' + state.en + ' · saved by ' + source.en + '.',
              kind.zh + ' · ' + state.zh + ' · 保存来源：' + source.zh + '。',
              'editorial-drawer-summary'
            ));
            section.append(localizedNode('div', 'Current saved content', '当前保存的正文', 'editorial-drawer-body-label'));
            const body = document.createElement('div');
            body.className = 'editorial-drawer-body';
            body.textContent = String(record.text || '');
            section.append(body);

            const advanced = document.createElement('details');
            advanced.className = 'editorial-drawer-advanced';
            advanced.append(localizedNode('summary', 'Advanced details', '高级详情'));
            const advancedBody = document.createElement('div');
            advancedBody.className = 'editorial-drawer-advanced-body';
            addCommand(advancedBody, 'Timeline command', '时间线命令', record.citation?.timeline_command);
            addCommand(advancedBody, 'Record lookup command', '记录查找命令', record.citation?.recall_command);
            const metadata = document.createElement('dl');
            metadata.className = 'editorial-drawer-meta';
            addMetadata(metadata, 'Kind', '类别', record.kind);
            addMetadata(metadata, 'Type', '类型', record.type);
            addMetadata(metadata, 'State', '状态', record.state);
            addMetadata(metadata, 'Updated', '更新时间', record.updated_at);
            addMetadata(metadata, 'Record ID', '记录 ID', record.id);
            if (record.citation?.event_id) addMetadata(metadata, 'Event ID', '事件 ID', record.citation.event_id);
            advancedBody.append(metadata);
            advanced.append(advancedBody);
            section.append(advanced);
            drawerPanel.append(section);
            return drawerId;
          };
          const remoteResult = (record) => {
            const kind = kindCopy(record.kind);
            const state = stateCopy(record.state);
            const source = sourceCopy(record.source);
            const title = clippedText(record.text) || kind.en;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'memory-result';
            button.dataset.memoryResult = '';
            button.dataset.kind = record.kind;
            button.dataset.drawerTarget = ensureRemoteDrawer(record);
            button.setAttribute('aria-haspopup', 'dialog');
            const copy = document.createElement('span');
            copy.className = 'memory-result-copy';
            copy.append(localizedNode('span', title, title, 'memory-result-title'));
            copy.append(localizedNode(
              'span',
              kind.en + ' · from ' + source.en,
              kind.zh + ' · 来源：' + source.zh,
              'memory-result-meta'
            ));
            button.append(copy, localizedNode('span', state.en, state.zh, 'memory-result-state'));
            return button;
          };
          const updateCount = (shown, total, remote = false) => {
            if (!(countEl instanceof HTMLElement)) return;
            const en = remote
              ? shown + ' of ' + total + (total === 1 ? ' match' : ' matches')
              : shown + (shown === 1 ? ' memory' : ' memories');
            const zh = remote ? total + ' 条匹配中的 ' + shown + ' 条' : shown + ' 条记忆';
            countEl.dataset.i18nEn = en;
            countEl.dataset.i18nZh = zh;
            countEl.textContent = en;
            window.applyDashboardLanguage?.();
          };
          const applyLocal = () => {
            searchSequence += 1;
            resultsContainer.innerHTML = initialResultsHtml;
            const results = Array.from(resultsContainer.querySelectorAll('[data-memory-result]'));
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
            if (moreButton instanceof HTMLElement) moreButton.hidden = true;
            if (countEl instanceof HTMLElement) {
              const filtered = query !== '' || activeKind !== 'all';
              const en = filtered ? shown + ' of ' + initialTotal : initialTotal + (initialTotal === 1 ? ' memory' : ' memories');
              const zh = filtered ? initialTotal + ' 条中的 ' + shown + ' 条' : initialTotal + ' 条记忆';
              countEl.dataset.i18nEn = en;
              countEl.dataset.i18nZh = zh;
              countEl.textContent = en;
              window.applyDashboardLanguage?.();
            }
          };
          const runRemote = async (append = false) => {
            if (!endpoint) { applyLocal(); return; }
            const sequence = ++searchSequence;
            if (!append) {
              remoteOffset = 0;
              resultsContainer.replaceChildren();
              updateCount(0, 0, true);
            }
            if (noResults instanceof HTMLElement) noResults.hidden = true;
            if (moreButton instanceof HTMLElement) moreButton.hidden = true;
            try {
              const url = new URL(endpoint, window.location.href);
              url.searchParams.set('q', input.value.trim());
              if (activeKind !== 'all') url.searchParams.set('kind', activeKind);
              url.searchParams.set('offset', String(remoteOffset));
              url.searchParams.set('limit', '20');
              const response = await fetch(url, { cache: 'no-store' });
              if (!response.ok) throw new Error('search unavailable');
              const payload = await response.json();
              if (sequence !== searchSequence) return;
              const records = Array.isArray(payload.records) ? payload.records : [];
              records.forEach((record) => resultsContainer.append(remoteResult(record)));
              remoteOffset += records.length;
              const totalMatches = Number(payload.total_matches || 0);
              updateCount(remoteOffset, totalMatches, true);
              if (noResults instanceof HTMLElement) noResults.hidden = totalMatches !== 0;
              if (moreButton instanceof HTMLElement) moreButton.hidden = payload.has_more !== true;
              window.applyDashboardLanguage?.();
            } catch {
              if (sequence !== searchSequence) return;
              applyLocal();
              if (countEl instanceof HTMLElement) {
                countEl.dataset.i18nEn = 'Full search is temporarily unavailable; showing recent memories.';
                countEl.dataset.i18nZh = '完整搜索暂时不可用；当前显示最近的记忆。';
                window.applyDashboardLanguage?.();
              }
            }
          };
          const apply = () => {
            if (debounceTimer) {
              window.clearTimeout(debounceTimer);
              debounceTimer = null;
            }
            const needsFullSearch = endpoint && (input.value.trim() !== '' || activeKind !== 'all');
            if (!needsFullSearch) { applyLocal(); return; }
            debounceTimer = window.setTimeout(() => { void runRemote(false); }, 180);
          };
          chips.forEach((chip) => {
            chip.addEventListener('click', () => {
              activeKind = chip.dataset.chipKind || 'all';
              chips.forEach((other) => other.setAttribute('aria-pressed', other === chip ? 'true' : 'false'));
              apply();
            });
          });
          input.addEventListener('input', apply);
          if (moreButton instanceof HTMLButtonElement) moreButton.addEventListener('click', () => { void runRemote(true); });
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
