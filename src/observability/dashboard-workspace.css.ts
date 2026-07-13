export function dashboardWorkspaceCss(): string {
  return `
    :root {
      color-scheme: light;
      --canvas: #ded9ce;
      --surface: #f5f2eb;
      --surface-2: #efebe2;
      --surface-3: #e4ded2;
      --ink: #292720;
      --ink-2: #49453d;
      --muted: #777168;
      --subtle: #948d82;
      --border: #d5d0c4;
      --hairline: #ddd7cc;
      --signal-blue: #586f78;
      --signal-blue-soft: #e3e9e8;
      --signal-green: #55705e;
      --signal-green-soft: #e3ebe2;
      --signal-amber: #946a35;
      --signal-amber-soft: #f0e5d2;
      --signal-red: #944b43;
      --signal-red-soft: #f0dfda;
      --signal-violet: #75677d;
      --signal-slate: #777168;
      --surface-hover: #faf7f0;
      --panel-highlight: #bac8bc;
      --ring-soft: 0 0 0 3px rgba(85, 112, 94, 0.16);
      --panel-glow: none;
      --elevation-card: 0 18px 55px rgba(57, 49, 37, 0.08);
      --elevation-hover: 0 20px 60px rgba(57, 49, 37, 0.12);
      --text: var(--ink);
      --main: var(--surface);
      --accent: var(--signal-green);
      --accent-2: var(--signal-blue);
      --warning: var(--signal-amber);
      --critical: var(--signal-red);
      --good: var(--signal-green);
      --info: var(--signal-blue);
      --code: #ebe6dc;
    }
    html, body { background: var(--canvas); color: var(--ink); }
    body { background: var(--canvas) !important; }
    main { max-width: none !important; margin: 0 !important; padding: 0 !important; }
    [data-dashboard-editorial-shell] {
      width: min(1380px, calc(100% - 36px));
      min-height: calc(100vh - 36px);
      margin: 18px auto;
      background: var(--surface);
      border: 1px solid #cbc4b7;
      box-shadow: 0 28px 90px rgba(54, 45, 31, 0.13);
    }
    .editorial-header {
      min-height: 68px;
      margin: 0;
      padding: 0 34px;
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      border-bottom: 1px solid var(--border);
    }
    .editorial-brand { font: 600 21px/1 Georgia, "Times New Roman", serif; letter-spacing: -0.035em; }
    .editorial-navigation { display: flex; align-items: center; gap: 28px; }
    .editorial-nav-button {
      appearance: none; border: 0; border-bottom: 1px solid transparent; padding: 24px 0 20px;
      background: transparent; color: var(--muted); cursor: pointer; font: 600 13px/1.2 Inter, system-ui, sans-serif;
    }
    .editorial-nav-button[aria-current="page"] { color: var(--ink); border-bottom-color: var(--ink); }
    .editorial-header-status { display: flex; justify-content: flex-end; align-items: center; gap: 12px; min-width: 0; }
    .editorial-sync { color: var(--signal-green); font-size: 12px; white-space: nowrap; }
    .editorial-shell-body { min-height: 620px; }
    [data-dashboard-view] { min-height: 620px; }
    [data-dashboard-view][hidden], [data-dashboard-drawer][hidden], [data-drawer-payload][hidden] { display: none !important; }
    .editorial-layout { display: grid; grid-template-columns: minmax(0, 1fr) 340px; }
    .editorial-reading-column { padding: 52px 62px 64px; min-width: 0; }
    .editorial-sidebar { padding: 48px 32px; border-left: 1px solid var(--border); background: var(--surface-2); }
    .editorial-eyebrow, .editorial-section-title {
      color: var(--muted); font: 650 11px/1.2 Inter, system-ui, sans-serif; letter-spacing: .13em; text-transform: uppercase;
    }
    .editorial-task-button { display: block; width: 100%; border: 0; padding: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
    .editorial-task {
      max-width: 820px; margin: 12px 0 15px; color: var(--ink);
      font: 500 clamp(40px, 5vw, 58px)/1.04 Georgia, "Times New Roman", serif; letter-spacing: -.048em;
    }
    .editorial-lead { max-width: 760px; color: #686259; font: 18px/1.65 Georgia, "Times New Roman", serif; }
    .editorial-context-meta { display: flex; flex-wrap: wrap; gap: 10px 20px; margin-top: 24px; color: var(--muted); font-size: 12px; }
    .editorial-conclusion {
      display: flex; gap: 14px; align-items: center; margin-top: 34px; padding: 20px 0;
      border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
    }
    .editorial-conclusion-mark { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 50%; background: var(--signal-green-soft); color: var(--signal-green); font-size: 18px; }
    .editorial-conclusion strong { display: block; font: 500 18px Georgia, "Times New Roman", serif; }
    .editorial-conclusion span { color: var(--muted); }
    .editorial-section { margin-top: 38px; }
    .editorial-section-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 20px; margin-bottom: 15px; }
    .editorial-section-heading p { margin: 0; color: var(--muted); font-size: 12px; }
    .editorial-memory-grid { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid var(--border); background: var(--border); gap: 1px; }
    .editorial-metric {
      appearance: none; border: 0; padding: 19px 18px; background: #f8f5ee; color: var(--ink); text-align: left; cursor: pointer;
    }
    .editorial-metric:hover, .editorial-metric:focus-visible, .editorial-event:hover, .editorial-important:hover { background: #fbf8f1; }
    .editorial-metric span { display: block; color: var(--muted); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
    .editorial-metric strong { display: block; margin-top: 7px; font: 500 24px Georgia, "Times New Roman", serif; }
    .editorial-event-list { border-top: 1px solid var(--border); }
    .editorial-event {
      appearance: none; width: 100%; display: grid; grid-template-columns: 82px minmax(0, 1fr) auto; gap: 18px;
      padding: 15px 0; border: 0; border-bottom: 1px solid var(--hairline); background: transparent; color: var(--ink); text-align: left; cursor: pointer;
    }
    .editorial-event time, .editorial-event small { color: var(--muted); }
    .editorial-event strong { font-weight: 540; overflow-wrap: anywhere; }
    .editorial-attention { padding: 20px 22px; border: 1px solid #d5b88f; background: #f3eadc; }
    .editorial-attention article + article { margin-top: 14px; padding-top: 14px; border-top: 1px solid #ddc9aa; }
    .editorial-sidebar-heading { margin-bottom: 20px; }
    .editorial-important {
      appearance: none; width: 100%; padding: 17px 0; border: 0; border-bottom: 1px solid var(--border);
      background: transparent; color: var(--ink); text-align: left; cursor: pointer;
    }
    .editorial-important strong { display: block; font-weight: 540; }
    .editorial-important p { margin: 5px 0 0; color: var(--muted); font-size: 12px; }
    .editorial-sync-card { margin-top: 30px; padding: 17px; border: 1px solid #c5d0c4; background: var(--signal-green-soft); color: #536b58; }
    .editorial-view-page { padding: 44px 50px 64px; }
    .editorial-view-page > header { margin: 0 0 30px; padding: 0; display: block; }
    .editorial-view-page h1 { font: 500 42px/1.05 Georgia, "Times New Roman", serif; letter-spacing: -.04em; }
    .editorial-compatibility { color: var(--ink); }
    .editorial-audit { padding: 0 50px 50px; }
    .editorial-audit > summary { border-top: 1px solid var(--border); }
    [data-dashboard-drawer] { position: fixed; inset: 0; z-index: 100; display: flex; justify-content: flex-end; background: rgba(42, 38, 31, .26); }
    .editorial-drawer-panel { width: min(540px, 94vw); height: 100%; overflow: auto; padding: 30px 34px 50px; background: #f8f5ee; border-left: 1px solid #c8c1b5; box-shadow: -24px 0 70px rgba(48, 40, 28, .18); }
    .editorial-drawer-head { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
    .editorial-drawer-close { appearance: none; border: 1px solid var(--border); background: transparent; padding: 8px 11px; color: var(--ink); cursor: pointer; }
    .editorial-drawer-title { margin: 30px 0 10px; font: 500 34px/1.08 Georgia, "Times New Roman", serif; letter-spacing: -.035em; }
    .editorial-drawer-summary { color: var(--ink-2); font: 16px/1.65 Georgia, "Times New Roman", serif; }
    .editorial-drawer-meta { margin-top: 28px; display: grid; gap: 0; }
    .editorial-drawer-meta div { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 14px; padding: 12px 0; border-bottom: 1px solid var(--hairline); }
    .editorial-drawer-meta dt { color: var(--muted); }
    .editorial-drawer-evidence { margin-top: 30px; overflow-wrap: anywhere; }
    .editorial-nav-button:focus-visible, button[data-drawer-target]:focus-visible, .editorial-drawer-close:focus-visible { outline: none; box-shadow: var(--ring-soft); }
    @media (max-width: 900px) {
      .editorial-header { grid-template-columns: 1fr auto; padding: 0 22px; }
      .editorial-navigation { order: 3; grid-column: 1 / -1; justify-content: center; border-top: 1px solid var(--border); }
      .editorial-header-status { grid-column: 2; grid-row: 1; }
      .editorial-layout { grid-template-columns: 1fr; }
      .editorial-sidebar { border-left: 0; border-top: 1px solid var(--border); }
      .editorial-reading-column { padding: 42px 36px; }
      .editorial-memory-grid { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 600px) {
      [data-dashboard-editorial-shell] { width: 100%; min-height: 100vh; margin: 0; border: 0; }
      .editorial-header { padding: 0 18px; }
      .editorial-header-status .language-toggle-label, .editorial-sync { display: none; }
      .editorial-navigation { gap: 22px; }
      .editorial-reading-column, .editorial-sidebar, .editorial-view-page { padding: 32px 22px; }
      .editorial-task { font-size: 39px; }
      .editorial-memory-grid { grid-template-columns: 1fr 1fr; }
      .editorial-event { grid-template-columns: 66px minmax(0, 1fr); }
      .editorial-event small { grid-column: 2; }
      .editorial-drawer-panel { width: 100%; min-height: 100dvh; border-left: 0; padding: 24px 22px 40px; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; }
    }
  `;
}
