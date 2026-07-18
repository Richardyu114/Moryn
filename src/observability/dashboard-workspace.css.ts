import { dashboardFontFaceCss, dashboardFontStack } from "./dashboard-fonts.js";

export function dashboardWorkspaceCss(): string {
  return `
    ${dashboardFontFaceCss()}
    :root {
      color-scheme: light;
      --canvas: #e6e0d4;
      --surface: #f7f4ed;
      --surface-2: #f1ede4;
      --surface-3: #e8e2d6;
      --ink: #26241d;
      --ink-2: #4a463d;
      --muted: #7a746a;
      --subtle: #9a9388;
      --border: #d8d2c6;
      --hairline: #e0dacf;
      --accent: #5c6f5f;
      --accent-soft: #e4ebe3;
      --amber: #93672f;
      --amber-soft: #f0e4d0;
      --brand: #c0632b;
      --brand-soft: #f0dcc4;
      --brand-ink: #8a4a22;
      --red: #92483f;
      --red-soft: #f0dcd7;
      --chart-fill: #7d8a6f;
      --chart-track: #e7e1d5;
      --swatch-canonical: #5c6f5f;
      --swatch-candidate: #6d7f8a;
      --swatch-raw: #a98a4f;
      --swatch-archived: #a39a8c;
      --swatch-quarantined: #a05b50;
      --font: ${dashboardFontStack};
      --mono: ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", "Courier New", monospace;
      --shadow-soft: 0 1px 2px rgba(46, 38, 24, 0.04);
      --ring: 0 0 0 3px rgba(92, 111, 95, 0.18);
    }

    html, body { background: var(--surface); color: var(--ink); }
    body { background: var(--surface) !important; font-family: var(--font); }
    [data-dashboard-editorial-shell], [data-dashboard-editorial-shell] * { font-family: var(--font); }
    main { max-width: none !important; margin: 0 !important; padding: 0 !important; }

    /* Full-bleed: no card, no backdrop — content fills the viewport */
    [data-dashboard-editorial-shell] {
      width: 100%;
      min-height: 100vh;
      margin: 0;
      background: var(--surface);
      border: 0;
      border-top: 2px solid var(--brand);
      box-shadow: none;
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
      overflow-x: clip;
    }
    [data-dashboard-editorial-shell] * { min-width: 0; }

    /* Animated film grain overlay */
    body::after {
      content: ""; position: fixed; inset: -50%; z-index: 9999; pointer-events: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
      opacity: 0.11; mix-blend-mode: multiply; animation: grainshift 0.5s steps(1) infinite;
    }
    @keyframes grainshift {
      0%{transform:translate(0,0)} 20%{transform:translate(-3%,2%)} 40%{transform:translate(2%,-3%)}
      60%{transform:translate(-2%,-2%)} 80%{transform:translate(3%,2%)} 100%{transform:translate(0,0)}
    }
    [data-dashboard-editorial-shell] p,
    [data-dashboard-editorial-shell] h1,
    [data-dashboard-editorial-shell] h2,
    [data-dashboard-editorial-shell] strong,
    [data-dashboard-editorial-shell] span { overflow-wrap: anywhere; }

    /* ---- Header ---- */
    .editorial-header {
      display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 20px;
      min-height: 72px; padding: 0 clamp(24px, 4vw, 64px); border-bottom: 1px solid var(--border);
    }
    .editorial-brand { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
    .editorial-navigation { display: flex; align-items: center; justify-content: center; gap: 30px; }
    .editorial-nav-button {
      appearance: none; border: 0; padding: 26px 0 23px; background: transparent;
      color: var(--muted); cursor: pointer; font-family: var(--font);
      font-size: 16px; font-weight: 500; border-bottom: 2px solid transparent;
      transition: color 140ms ease;
    }
    .editorial-nav-button:hover { color: var(--ink-2); }
    .editorial-nav-button[aria-current="page"] { color: var(--ink); border-bottom-color: var(--ink); }
    .editorial-header-status { display: flex; justify-content: flex-end; align-items: center; gap: 12px; min-width: 0; }
    .editorial-sync { color: var(--accent); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
    @media (max-width: 1080px) { .editorial-sync { display: none; } }
    .editorial-refresh {
      appearance: none; display: inline-flex; align-items: center; gap: 7px;
      border: 1px solid var(--border); border-radius: 999px; padding: 6px 14px;
      background: transparent; color: var(--ink-2); cursor: pointer;
      font-family: var(--font); font-size: 13px; font-weight: 500; transition: background 140ms ease, color 140ms ease;
    }
    .editorial-refresh:hover { background: var(--surface-3); color: var(--ink); }
    .editorial-refresh[data-refreshing="true"] { opacity: 0.55; pointer-events: none; }

    /* ---- Language switch (serif, unified) ---- */
    .editorial-language-switch {
      display: inline-flex; align-items: center; gap: 8px; padding: 3px 4px;
      border: 1px solid var(--border); border-radius: 999px; background: transparent;
    }
    .editorial-language-label { display: none; }
    .editorial-language-options { display: inline-flex; gap: 2px; }
    .editorial-language-switch .language-option {
      appearance: none; min-width: 40px; border: 0; border-radius: 999px; padding: 4px 12px;
      background: transparent; color: var(--muted); cursor: pointer;
      font-family: var(--font); font-size: 13px; font-weight: 500;
      transition: color 140ms ease, background 140ms ease;
    }
    .editorial-language-switch .language-option.active { background: var(--ink); color: var(--surface); }
    .editorial-language-switch .language-option:hover:not(.active) { color: var(--ink); }

    /* ---- Body / layout ---- */
    .editorial-shell-body { min-height: 620px; }
    [data-dashboard-view] { min-height: 620px; }
    [data-dashboard-view][hidden], [data-dashboard-drawer][hidden], [data-drawer-payload][hidden] { display: none !important; }
    .editorial-layout { display: grid; grid-template-columns: minmax(0, 1fr) 360px; }
    .editorial-reading-column { padding: 72px clamp(40px, 7vw, 120px) 84px; min-width: 0; }
    .editorial-sidebar { padding: 72px clamp(28px, 3vw, 44px); border-left: 1px solid var(--border); background: var(--surface-2); }

    /* ---- Type: eyebrows & section titles (serif, spaced small caps feel) ---- */
    .editorial-eyebrow, .editorial-section-title {
      color: var(--subtle); font-size: 12px; font-weight: 600;
      letter-spacing: 0.14em; text-transform: uppercase;
    }

    /* ---- Current context / hero ---- */
    [data-editorial-section="current-context"] .editorial-eyebrow { color: var(--brand); letter-spacing: 0.22em; }
    .editorial-task-button { display: block; width: 100%; border: 0; padding: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
    .editorial-task {
      max-width: 14ch; margin: 16px 0 18px; color: var(--ink);
      font-size: clamp(48px, 6.5vw, 92px); font-weight: 500; line-height: 0.98; letter-spacing: -0.035em;
    }
    .editorial-task-button:hover .editorial-task { color: var(--ink-2); }
    .editorial-lead { max-width: 760px; margin: 0; color: var(--ink-2); font-size: 21px; line-height: 1.6; }
    .editorial-context-meta { display: flex; flex-wrap: wrap; gap: 8px 22px; margin-top: 28px; color: var(--muted); font-size: 14px; }
    .editorial-conclusion {
      display: flex; gap: 15px; align-items: center; margin-top: 36px; padding: 22px 0;
      border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
    }
    .editorial-conclusion-mark { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: var(--brand-soft); color: var(--brand); font-size: 18px; flex: none; animation: markpulse 2.8s ease-in-out infinite; }
    @keyframes markpulse { 0%,100%{box-shadow:0 0 0 0 rgba(192,99,43,.34)} 50%{box-shadow:0 0 0 8px rgba(192,99,43,0)} }
    .editorial-conclusion strong { display: block; font-size: 18px; font-weight: 600; }
    .editorial-conclusion span { color: var(--muted); font-size: 15px; }

    /* ---- Sections ---- */
    .editorial-section { margin-top: 44px; }
    .editorial-section-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 20px; margin-bottom: 18px; }
    .editorial-section-heading p { margin: 0; color: var(--muted); font-size: 14px; }

    /* ---- Memory state metrics (quiet, hairline-separated, no card lift) ---- */
    .editorial-memory-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; border-top: 1px solid var(--border); }
    .editorial-metric {
      appearance: none; border: 0; border-bottom: 1px solid var(--border); border-right: 1px solid var(--border);
      padding: 20px 20px 22px; background: transparent; color: var(--ink); text-align: left; cursor: pointer;
      transition: background 220ms ease, transform 220ms cubic-bezier(.2,.7,.2,1), box-shadow 220ms ease; position: relative;
    }
    .editorial-metric:last-child { border-right: 0; }
    .editorial-metric:hover, .editorial-metric:focus-visible { background: #fffdf8; transform: translateY(-4px); box-shadow: 0 14px 30px rgba(60,45,25,.12); z-index: 2; }
    .editorial-metric span { display: block; color: var(--muted); font-size: 13px; letter-spacing: 0.02em; }
    .editorial-metric strong { display: block; margin-top: 9px; font-size: 30px; font-weight: 500; letter-spacing: -0.01em; transition: color 220ms ease; }
    .editorial-metric:hover strong { color: var(--brand); }

    /* ---- What changed (event list) ---- */
    .editorial-event-list { border-top: 1px solid var(--border); }
    .editorial-event {
      appearance: none; width: 100%; display: grid; grid-template-columns: 88px minmax(0, 1fr) auto; gap: 18px;
      padding: 16px 0; border: 0; border-bottom: 1px solid var(--hairline); background: transparent;
      color: var(--ink); text-align: left; cursor: pointer; transition: background 200ms ease, transform 200ms ease; position: relative;
    }
    .editorial-event::before { content: ""; position: absolute; left: -16px; top: 0; bottom: 0; width: 2px; background: var(--brand); transform: scaleY(0); transform-origin: top; transition: transform 240ms cubic-bezier(.2,.7,.2,1); }
    .editorial-event:hover { background: #fffdf8; transform: translateX(6px); }
    .editorial-event:hover::before { transform: scaleY(1); }
    .editorial-event time, .editorial-event small { color: var(--muted); font-size: 14px; }
    .editorial-event strong { font-size: 16px; font-weight: 500; overflow-wrap: anywhere; }

    /* ---- Glance charts ---- */
    .glance-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; background: var(--border); border: 1px solid var(--border); }
    .glance-card { padding: 20px 22px; background: var(--surface); transition: box-shadow 220ms ease; }
    .glance-card:hover { box-shadow: 0 14px 34px rgba(60,45,25,.10); }
    .glance-card-title { color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 16px; }
    .glance-stack { display: flex; width: 100%; height: 12px; border-radius: 999px; overflow: hidden; background: var(--chart-track); }
    .glance-bar-seg { display: block; height: 100%; animation: growx 900ms cubic-bezier(.2,.7,.2,1) both; transform-origin: left; }
    @keyframes growx { from { transform: scaleX(0); } to { transform: scaleX(1); } }
    @keyframes growy { from { transform: scaleY(0); } to { transform: scaleY(1); } }
    .glance-legend { list-style: none; margin: 16px 0 0; padding: 0; display: grid; gap: 9px; }
    .glance-legend li { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px; }
    .glance-dot { width: 9px; height: 9px; border-radius: 50%; }
    .glance-legend-label { color: var(--ink-2); font-size: 14px; }
    .glance-legend-value { color: var(--ink); font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .swatch-canonical { background: var(--swatch-canonical); }
    .swatch-candidate { background: var(--swatch-candidate); }
    .swatch-raw { background: var(--swatch-raw); }
    .swatch-archived { background: var(--swatch-archived); }
    .swatch-quarantined { background: var(--swatch-quarantined); }
    .glance-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
    .glance-row { display: grid; grid-template-columns: minmax(0, 88px) 1fr auto; align-items: center; gap: 12px; }
    .glance-row-label { color: var(--ink-2); font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .glance-row-track { height: 8px; border-radius: 999px; background: var(--chart-track); overflow: hidden; }
    .glance-row-fill { display: block; height: 100%; background: var(--chart-fill); border-radius: 999px; animation: growx 900ms cubic-bezier(.2,.7,.2,1) both; transform-origin: left; }
    .glance-row-value { color: var(--ink); font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .glance-trend { display: flex; align-items: flex-end; gap: 4px; height: 68px; }
    .glance-trend-bar { flex: 1; min-width: 0; background: var(--chart-fill); border-radius: 2px 2px 0 0; animation: growy 800ms cubic-bezier(.2,.7,.2,1) both; transform-origin: bottom; transition: background 200ms ease; }
    .glance-trend-bar:hover { background: var(--brand); }
    .glance-trend-caption { display: flex; justify-content: space-between; align-items: baseline; margin-top: 12px; color: var(--muted); font-size: 13px; }

    /* ---- Attention ---- */
    .editorial-attention { margin-top: 36px; }
    .editorial-attention .editorial-section-title { color: var(--brand); }
    .editorial-decision-card {
      margin-top: 14px; padding: 20px 22px; border: 1px solid var(--brand); border-left: 3px solid var(--brand);
      border-radius: 4px; background: var(--brand-soft); box-shadow: var(--shadow-soft);
      transition: transform 220ms ease, box-shadow 220ms ease;
    }
    .editorial-decision-card:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(138, 74, 34, 0.14); }
    .editorial-decision-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
    .editorial-decision-head strong { font-size: 17px; font-weight: 600; color: var(--ink); }
    .editorial-decision-source { color: var(--brand-ink); font-size: 13px; }
    .editorial-decision-summary { margin: 10px 0 0; color: var(--ink-2); font-size: 15px; line-height: 1.55; max-width: 760px; }
    .editorial-decision-note { margin: 8px 0 0; color: var(--muted); font-size: 13px; }
    .editorial-decision-context { margin-top: 18px; border-top: 1px solid rgba(199, 103, 42, 0.22); padding-top: 18px; }
    .editorial-decision-label { display: block; color: var(--brand-ink); font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .editorial-decision-reason p { margin: 7px 0 0; max-width: 920px; color: var(--ink-2); font-size: 15px; line-height: 1.55; }
    .editorial-decision-scope { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; margin: 18px 0; border-block: 1px solid rgba(199, 103, 42, 0.18); }
    .editorial-decision-scope div { padding: 14px 18px 14px 0; }
    .editorial-decision-scope div + div { border-left: 1px solid rgba(199, 103, 42, 0.18); padding-left: 18px; }
    .editorial-decision-scope dt { color: var(--muted); font-size: 12px; font-weight: 600; text-transform: uppercase; }
    .editorial-decision-scope dd { margin: 6px 0 0; color: var(--ink); font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
    .editorial-decision-examples > ul { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 0; border-top: 1px solid rgba(199, 103, 42, 0.18); }
    .editorial-decision-example { padding: 12px 0; border-bottom: 1px solid rgba(199, 103, 42, 0.18); }
    .editorial-decision-example > div { display: flex; justify-content: space-between; gap: 12px; color: var(--muted); font-size: 12px; }
    .editorial-decision-example p { margin: 5px 0; color: var(--ink-2); font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
    .editorial-decision-example code { color: var(--subtle); font-size: 11px; overflow-wrap: anywhere; }
    .editorial-decision-evidence { margin-top: 14px; }
    .editorial-decision-evidence summary { cursor: pointer; color: var(--brand-ink); font-size: 13px; font-weight: 600; }
    .editorial-decision-evidence > p { margin: 10px 0; color: var(--ink-2); font-size: 13px; line-height: 1.5; }
    .editorial-decision-checks { list-style: none; margin: 10px 0; padding: 0; display: grid; gap: 6px; color: var(--ink-2); font-size: 13px; }
    .editorial-decision-checks li { display: flex; align-items: baseline; gap: 8px; }
    .editorial-decision-checks li span:first-child { color: var(--green); font-weight: 700; }
    .editorial-decision-record-ids { display: flex; flex-wrap: wrap; gap: 6px; }
    .editorial-decision-record-ids code, .editorial-decision-record-ids span { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
    .editorial-decision-guard { color: var(--muted) !important; }
    .editorial-decision-actions { display: flex; align-items: center; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
    .editorial-decision-button {
      appearance: none; cursor: pointer; font-family: var(--font); font-size: 14px; font-weight: 600;
      border-radius: 999px; padding: 8px 20px; transition: background 160ms ease, color 160ms ease, border-color 160ms ease;
    }
    .editorial-decision-button.primary { border: 1px solid var(--brand); background: var(--brand); color: var(--surface); }
    .editorial-decision-button.primary:hover:not(:disabled) { background: var(--brand-ink); border-color: var(--brand-ink); }
    .editorial-decision-button.ghost { border: 1px solid var(--border); background: transparent; color: var(--ink-2); }
    .editorial-decision-button.ghost:hover:not(:disabled) { border-color: var(--ink-2); color: var(--ink); }
    .editorial-decision-button:disabled { opacity: 0.55; cursor: default; }
    .editorial-decision-status { color: var(--brand-ink); font-size: 13px; }
    .editorial-decision-notice { margin-top: 14px; padding: 16px 18px; border: 1px solid var(--amber); border-radius: 4px; background: var(--amber-soft); }
    .editorial-decision-notice strong { font-size: 15px; font-weight: 600; color: var(--ink); }
    .editorial-decision-notice p { margin: 4px 0 0; color: var(--ink-2); font-size: 14px; }

    /* ---- Sidebar / important now ---- */
    .editorial-sidebar-heading { margin-bottom: 22px; }
    .editorial-important {
      appearance: none; width: 100%; padding: 18px 0; border: 0; border-bottom: 1px solid var(--border);
      background: transparent; color: var(--ink); text-align: left; cursor: pointer; transition: background 200ms ease, transform 200ms ease; position: relative;
    }
    .editorial-important::before { content: ""; position: absolute; left: -16px; top: 0; bottom: 0; width: 2px; background: var(--brand); transform: scaleY(0); transform-origin: top; transition: transform 240ms cubic-bezier(.2,.7,.2,1); }
    .editorial-important:hover { background: #fffdf8; transform: translateX(6px); }
    .editorial-important:hover::before { transform: scaleY(1); }
    .editorial-important strong { display: block; font-size: 16px; font-weight: 500; }
    .editorial-important p { margin: 6px 0 0; color: var(--muted); font-size: 14px; }
    .editorial-sync-card { margin-top: 32px; padding: 16px 18px; border: 1px solid #e0c39d; border-radius: 4px; background: var(--brand-soft); color: var(--brand-ink); font-size: 14px; }

    /* ---- Section entrance (staggered rise) ---- */
    [data-dashboard-view="workspace"] [data-editorial-section],
    [data-dashboard-view="workspace"] .editorial-sidebar { animation: rise 700ms cubic-bezier(.2,.7,.2,1) both; }
    [data-dashboard-view="workspace"] [data-editorial-section]:nth-child(1) { animation-delay: .02s; }
    [data-dashboard-view="workspace"] [data-editorial-section]:nth-child(2) { animation-delay: .10s; }
    [data-dashboard-view="workspace"] [data-editorial-section]:nth-child(3) { animation-delay: .18s; }
    [data-dashboard-view="workspace"] [data-editorial-section]:nth-child(4) { animation-delay: .26s; }
    [data-dashboard-view="workspace"] .editorial-sidebar { animation-delay: .30s; }
    .editorial-view-page > header { animation: rise 700ms cubic-bezier(.2,.7,.2,1) both; animation-delay: .02s; }
    .editorial-view-page > .memory-search,
    .editorial-view-page > .history-timeline { animation: rise 700ms cubic-bezier(.2,.7,.2,1) both; animation-delay: .12s; }
    @keyframes rise { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: none; } }

    /* ---- View pages (Memory / History) ---- */
    .editorial-view-page { padding: 72px clamp(40px, 7vw, 120px) 84px; }
    .editorial-view-page > header { margin: 0 0 34px; padding: 0; display: block; }
    .editorial-view-page h1 { margin: 14px 0 12px; font-size: clamp(42px, 5vw, 68px); font-weight: 500; line-height: 1.0; letter-spacing: -0.03em; }
    .editorial-view-page > header .editorial-eyebrow { color: var(--brand); letter-spacing: 0.22em; }
    .editorial-view-page > header p { margin: 0; max-width: 640px; color: var(--muted); font-size: 16px; line-height: 1.55; }

    /* ---- Memory search (editorial, unified) ---- */
    .memory-search { max-width: 760px; }
    .memory-search-field { position: relative; margin-bottom: 6px; }
    .memory-search-field input {
      width: 100%; box-sizing: border-box; padding: 15px 18px; border: 1px solid var(--border); border-radius: 6px;
      background: var(--surface); color: var(--ink); font-family: var(--font); font-size: 17px;
      transition: border-color 140ms ease, box-shadow 140ms ease;
    }
    .memory-search-field input::placeholder { color: var(--subtle); }
    .memory-search-field input:focus { outline: none; border-color: var(--accent); box-shadow: var(--ring); }
    .memory-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .memory-chip {
      appearance: none; display: inline-flex; align-items: center; gap: 7px; padding: 6px 13px;
      border: 1px solid var(--border); border-radius: 999px; background: transparent; color: var(--ink-2);
      cursor: pointer; font-family: var(--font); font-size: 14px; transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
    }
    .memory-chip:hover { background: var(--surface-2); }
    .memory-chip[aria-pressed="true"] { background: var(--ink); border-color: var(--ink); color: var(--surface); }
    .memory-chip-count { font-size: 12px; color: var(--subtle); font-variant-numeric: tabular-nums; }
    .memory-chip[aria-pressed="true"] .memory-chip-count { color: var(--surface); opacity: 0.7; }
    .memory-chip:focus-visible { outline: none; box-shadow: var(--ring); }
    .memory-search-count { margin: 16px 0 6px; color: var(--muted); font-size: 14px; }
    .memory-search-capped { margin: 0 0 10px; padding: 8px 12px; border-left: 2px solid var(--brand); background: var(--brand-soft); color: var(--brand-ink); font-size: 13px; line-height: 1.5; }
    .ms-results { border-top: 1px solid var(--border); }
    .memory-result {
      appearance: none; width: 100%; display: block; padding: 18px 0; border: 0; border-bottom: 1px solid var(--hairline);
      background: transparent; color: var(--ink); text-align: left; cursor: pointer; transition: background 200ms ease, transform 200ms ease; position: relative;
    }
    .memory-result::before { content: ""; position: absolute; left: -16px; top: 0; bottom: 0; width: 2px; background: var(--brand); transform: scaleY(0); transform-origin: top; transition: transform 240ms cubic-bezier(.2,.7,.2,1); }
    .memory-result:hover, .memory-result:focus-visible { background: #fffdf8; transform: translateX(6px); outline: none; }
    .memory-result:hover::before, .memory-result:focus-visible::before { transform: scaleY(1); }
    .memory-result-title { display: block; font-size: 17px; font-weight: 500; line-height: 1.4; overflow-wrap: anywhere; }
    .memory-result-meta { display: block; margin-top: 6px; color: var(--muted); font-size: 13px; }
    .memory-search-empty { padding: 26px 0; color: var(--muted); font-size: 16px; }

    /* ---- History timeline ---- */
    .history-timeline { max-width: 720px; }
    .history-timeline .history-list { list-style: none; margin: 0; padding: 0; }
    .history-timeline .history-row {
      display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 22px; align-items: baseline;
      padding: 17px 16px 17px 0; border-bottom: 1px solid var(--hairline);
      transition: background 200ms ease, transform 200ms ease; position: relative;
    }
    .history-timeline .history-row::before { content: ""; position: absolute; left: -16px; top: 0; bottom: 0; width: 2px; background: var(--brand); transform: scaleY(0); transform-origin: top; transition: transform 240ms cubic-bezier(.2,.7,.2,1); }
    .history-timeline .history-row:hover { background: #fffdf8; transform: translateX(6px); }
    .history-timeline .history-row:hover::before { transform: scaleY(1); }
    .history-timeline .history-when { color: var(--muted); font-size: 14px; white-space: nowrap; }
    .history-timeline .history-what { color: var(--ink); font-size: 17px; line-height: 1.5; overflow-wrap: anywhere; }
    .history-timeline .history-what { transition: color 200ms ease; }
    .history-timeline .history-row:hover .history-what { color: var(--brand-ink); }
    .history-timeline .history-empty { color: var(--muted); font-size: 17px; line-height: 1.6; }

    /* ---- Drawer ---- */
    html.dashboard-drawer-open { overflow: hidden; scrollbar-gutter: stable; }
    html.dashboard-drawer-open body { position: fixed; left: 0; right: 0; width: 100%; overflow: hidden; }
    [data-dashboard-drawer] {
      position: fixed; inset: 0; z-index: 100; display: flex; justify-content: flex-end;
      background: rgba(38, 32, 20, 0.32); opacity: 0; transition: opacity 220ms ease;
      overscroll-behavior: contain; touch-action: pan-y;
    }
    .editorial-drawer-panel {
      width: min(540px, 94vw); height: 100%; overflow: auto; padding: 32px 36px 52px; background: var(--surface);
      border-left: 1px solid var(--border); box-shadow: -24px 0 70px rgba(40, 32, 18, 0.16);
      transform: translate3d(100%, 0, 0); transition: transform 240ms cubic-bezier(.22, .72, .2, 1);
      overscroll-behavior: contain; touch-action: pan-y; -webkit-overflow-scrolling: touch; will-change: transform;
    }
    [data-dashboard-drawer][data-drawer-state="open"] { opacity: 1; }
    [data-dashboard-drawer][data-drawer-state="open"] .editorial-drawer-panel { transform: translate3d(0, 0, 0); }
    [data-dashboard-drawer][data-drawer-state="closing"] { opacity: 0; }
    [data-dashboard-drawer][data-drawer-state="closing"] .editorial-drawer-panel { transform: translate3d(100%, 0, 0); }
    .editorial-drawer-head { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding-bottom: 22px; border-bottom: 1px solid var(--border); }
    .editorial-drawer-close { appearance: none; border: 1px solid var(--border); border-radius: 4px; background: transparent; padding: 8px 13px; color: var(--ink); cursor: pointer; font-family: var(--font); font-size: 14px; font-weight: 500; transition: background 140ms ease; }
    .editorial-drawer-close:hover { background: var(--surface-3); }
    .editorial-drawer-title { margin: 32px 0 12px; font-size: 30px; font-weight: 500; line-height: 1.12; letter-spacing: -0.015em; overflow-wrap: anywhere; }
    .editorial-drawer-summary { color: var(--muted); font-size: 14px; line-height: 1.6; }
    .editorial-drawer-body { margin-top: 20px; color: var(--ink); font-size: 17px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
    .editorial-drawer-truncated { margin: 12px 0 0; color: var(--amber); font-size: 14px; }
    .editorial-drawer-source { margin-top: 26px; padding: 18px 20px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface-2); }
    .editorial-drawer-source .editorial-section-title { margin-bottom: 12px; }
    .editorial-drawer-link { display: inline-block; color: var(--accent); font-size: 16px; text-decoration: underline; text-underline-offset: 3px; }
    .editorial-drawer-hint { display: block; margin-top: 5px; color: var(--muted); font-size: 13px; }
    .editorial-drawer-cmd { margin-top: 14px; }
    .editorial-drawer-cmd span { display: block; color: var(--muted); font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 5px; }
    .editorial-drawer-cmd code { display: block; padding: 8px 10px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); color: var(--ink-2); font-family: var(--mono); font-size: 13px; overflow-wrap: anywhere; }
    .editorial-drawer-meta { margin-top: 30px; display: grid; gap: 0; }
    .editorial-drawer-meta div { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 14px; padding: 13px 0; border-bottom: 1px solid var(--hairline); }
    .editorial-drawer-meta dt { color: var(--muted); font-size: 14px; }
    .editorial-drawer-meta dd { font-size: 15px; overflow-wrap: anywhere; }
    .editorial-drawer-evidence { margin-top: 30px; overflow-wrap: anywhere; }
    .editorial-drawer-evidence code {
      display: inline-block; margin: 4px 6px 0 0; padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px;
      background: var(--surface-2); color: var(--ink-2); font-family: var(--mono); font-size: 13px;
    }

    .editorial-nav-button:focus-visible, button[data-drawer-target]:focus-visible, .editorial-drawer-close:focus-visible, .editorial-refresh:focus-visible { outline: none; box-shadow: var(--ring); }

    @media (max-width: 900px) {
      .editorial-header { grid-template-columns: 1fr auto; padding: 0 24px; }
      .editorial-navigation { order: 3; grid-column: 1 / -1; justify-content: center; border-top: 1px solid var(--border); }
      .editorial-header-status { grid-column: 2; grid-row: 1; }
      .editorial-layout { grid-template-columns: 1fr; }
      .editorial-sidebar { border-left: 0; border-top: 1px solid var(--border); }
      .editorial-reading-column, .editorial-view-page { padding: 44px 34px; }
      .editorial-memory-grid { grid-template-columns: repeat(2, 1fr); }
      .editorial-metric:nth-child(2) { border-right: 0; }
      .editorial-decision-scope { grid-template-columns: 1fr; }
      .editorial-decision-scope div { padding: 12px 0; }
      .editorial-decision-scope div + div { border-left: 0; border-top: 1px solid rgba(199, 103, 42, 0.18); padding-left: 0; }
    }
    @media (max-width: 600px) {
      [data-dashboard-editorial-shell] { width: 100%; min-height: 100vh; margin: 0; border: 0; }
      .editorial-header { padding: 0 18px; }
      .editorial-sync { display: none; }
      .editorial-navigation { gap: 24px; }
      .editorial-reading-column, .editorial-sidebar, .editorial-view-page { padding: 34px 22px; }
      .editorial-task { font-size: 34px; }
      .editorial-memory-grid { grid-template-columns: 1fr 1fr; }
      .glance-grid { grid-template-columns: 1fr; }
      .editorial-event { grid-template-columns: 70px minmax(0, 1fr); }
      .editorial-event small { grid-column: 2; }
      .history-timeline .history-row { grid-template-columns: 1fr; gap: 4px; }
      [data-dashboard-drawer] { align-items: flex-end; }
      .editorial-drawer-panel {
        width: 100%; height: min(92dvh, 820px); border-left: 0; border-top: 1px solid var(--border);
        border-radius: 16px 16px 0 0; padding: 26px 22px 40px; transform: translate3d(0, 100%, 0);
      }
      [data-dashboard-drawer][data-drawer-state="open"] .editorial-drawer-panel { transform: translate3d(0, 0, 0); }
      [data-dashboard-drawer][data-drawer-state="closing"] .editorial-drawer-panel { transform: translate3d(0, 100%, 0); }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; }
    }
  `;
}
