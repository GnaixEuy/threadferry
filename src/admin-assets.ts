// 管理台的样式表和前端脚本以字符串常量内联在 TS 里：tsc 不会把 .css/.js 资源拷进 dist，
// 而 npm 包只发布 dist/src，所以任何独立资源文件在安装后都会消失。常量则跟着编译产物走。
// 两个文件都由 /admin.css 与 /admin.js 同源提供，CSP 因此只需要放开 'self'，不必 unsafe-inline。

export const STYLESHEET = `:root{
  color-scheme:light;
  --bg:#f7f7f5;
  --sidebar:rgb(242 242 239 / .9);
  --surface:#ffffff;
  --surface-2:#f8f8f6;
  --field:#ffffff;
  --line:#e4e4df;
  --line-strong:#cecec7;
  --text:#45474b;
  --text-strong:#18191b;
  --muted:#73767c;
  --accent:#197056;
  --accent-fill:#236f5b;
  --link:#17664f;
  --ok:#17734f;
  --warn:#95620c;
  --danger:#b63546;
  --nav-hover:#ebebe7;
  --nav-active:#e2e3de;
  --badge-bg:#efefeb;
  --overlay:rgb(15 23 42 / .32);
  --success-bg:#eaf4ef;
  --success-text:#176044;
  --error-bg:#f9eded;
  --error-text:#a92f3f;
  --code:#59606a;
  --code-faint:#85898f;
  --org:#635b83;
  --org-bg:#efedf5;
  --picker-hover:#eceeea;
  --ghost:#4d5055;
  --danger-border:#d8a7ae;
  --danger-hover:#f8eeee;
  --button-hover:#185b49;
  --button-text:#ffffff;
  --brand-bg:#202220;
  --brand-text:#ffffff;
  --status-ring:rgb(23 115 79 / .09);
  --picker-shadow:0 16px 38px rgb(32 34 32 / .14);
  --card-top:rgb(255 255 255 / .72);
  --radius:11px;
  --radius-sm:8px;
  --control-height:36px;
  font:14px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei",sans-serif;
  color:var(--text);
  background:var(--bg);
}
:root[data-theme="dark"]{
  color-scheme:dark;
  --bg:#191a18;
  --sidebar:rgb(30 31 29 / .9);
  --surface:#232421;
  --surface-2:#1f201e;
  --field:#1b1c1a;
  --line:#363732;
  --line-strong:#4b4c46;
  --text:#d8d9d5;
  --text-strong:#f1f2ed;
  --muted:#9b9e98;
  --accent:#58b18f;
  --accent-fill:#347f66;
  --link:#73c4a4;
  --ok:#72c89e;
  --warn:#d4ad5d;
  --danger:#ef929e;
  --nav-hover:#292a27;
  --nav-active:#343631;
  --badge-bg:#373833;
  --overlay:rgb(6 8 12 / .68);
  --success-bg:#20382f;
  --success-text:#8cd2b3;
  --error-bg:#412529;
  --error-text:#f3a5ae;
  --code:#c1c5bd;
  --code-faint:#878b84;
  --org:#c2b9dd;
  --org-bg:#383440;
  --picker-hover:#30312d;
  --ghost:#d1d3cc;
  --danger-border:#754149;
  --danger-hover:#3a2528;
  --button-hover:#439476;
  --button-text:#ffffff;
  --brand-bg:#f1f2ed;
  --brand-text:#202220;
  --status-ring:rgb(114 200 158 / .1);
  --picker-shadow:0 18px 40px rgb(0 0 0 / .4);
  --card-top:rgb(255 255 255 / .02);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);font-optical-sizing:auto}
.app-shell{min-height:100vh;display:grid;grid-template-columns:216px minmax(0,1fr)}
.sidebar{position:sticky;top:0;height:100vh;padding:26px 13px 16px;background:var(--sidebar);border-right:1px solid var(--line);backdrop-filter:blur(24px) saturate(130%);display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:10px;padding:0 9px 25px;color:var(--text-strong);text-decoration:none}
.brand-mark{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:var(--brand-bg);color:var(--brand-text);font-size:10px;font-weight:750;letter-spacing:.04em}
.brand b,.brand small{display:block}.brand b{letter-spacing:.1px}.brand small{color:var(--muted);font-size:12px;font-weight:500;margin-top:1px}
.side-nav{display:grid;gap:3px}
.side-nav a{display:flex;align-items:center;color:var(--text);text-decoration:none;padding:8px 10px;border-radius:7px;font-weight:520;transition:background-color .14s,color .14s}
.side-nav a:hover{color:var(--text-strong);background:var(--nav-hover)}
.side-nav a.active{color:var(--text-strong);background:var(--nav-active);font-weight:650}
.sidebar-bottom{margin-top:auto;display:grid;gap:14px}
.hide-log-tracking [data-log-nav]{display:none}
.sidebar-foot{padding:14px 11px 0;border-top:1px solid var(--line);display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}
.status-dot{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px var(--status-ring)}
main{min-width:0;padding:40px clamp(28px,4.5vw,64px) 80px}
header.top{display:flex;justify-content:space-between;align-items:center;gap:24px;max-width:1180px;margin:0 auto 30px}
.eyebrow{color:var(--muted);font-size:12px;font-weight:650;letter-spacing:0;margin:0 0 3px}
h1{font-size:29px;line-height:1.15;margin:0;letter-spacing:-.025em;font-weight:680}
h2{margin:30px 0 12px;font-size:17px;letter-spacing:-.01em}
h2.flush{margin:0}
.section-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:32px}
.section-head h2{margin:0}
.section-head p{margin:3px 0 0}
.list-panel{overflow:hidden;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius)}
.group-row{display:grid;grid-template-columns:minmax(240px,1.5fr) minmax(160px,1fr) auto;align-items:center;gap:20px;padding:15px 18px;color:var(--text);text-decoration:none;border-top:1px solid var(--line)}
.group-row:first-child{border-top:0}
.group-row:hover{background:var(--nav-hover)}
.group-main{display:flex;align-items:center;gap:12px;min-width:0}
.group-main>span:last-child{display:grid;min-width:0}.group-main b{color:var(--text-strong);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.group-main code{font-size:12px}
.group-label .identity{max-width:100%}.group-label .identity>b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.group-avatar{flex:0 0 36px;width:36px;height:36px;display:grid;place-items:center;border-radius:10px;background:var(--nav-active);color:var(--accent);font-size:13px;font-weight:750}
.group-agents{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.group-state{display:flex;align-items:center;justify-content:flex-end;gap:12px}
.row-arrow{color:var(--muted);font-size:24px;line-height:1}
.empty-state{padding:22px;margin:0;color:var(--muted)}
.back-link{display:inline-block;color:var(--link);text-decoration:none;margin-bottom:14px}.back-link:hover{text-decoration:underline}
.detail-title{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:18px}.detail-title h2{margin:0;font-size:24px}.detail-title .eyebrow{margin-bottom:4px}.detail-title-actions{display:flex;align-items:center;gap:10px}
.group-detail{max-width:920px}.group-intro{margin-bottom:14px}
h3,h4,p{margin:0 0 10px}
.sub,.muted{color:var(--muted)}
.js .no-js{display:none}
.instance{display:grid;grid-template-columns:auto auto;align-items:baseline;column-gap:6px;padding:0;text-align:right}
.instance b{font-size:18px;font-weight:680}.instance span{color:var(--text)}.instance small{grid-column:1/-1;color:var(--muted);font-size:11px}
.page-content{max-width:1180px;margin:0 auto}
.settings-stack{display:grid;gap:16px;max-width:900px}
.settings-card .section-head{margin-top:0;padding-bottom:16px;border-bottom:1px solid var(--line)}
.setting-list{border:0;padding:0;margin:0}
.setting-list:disabled{opacity:.62}
.setting-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 2px;border-top:1px solid var(--line);color:var(--text);cursor:pointer}
.setting-row:first-child{border-top:0}
.setting-row[hidden]{display:none}
.setting-row>span{display:grid;gap:3px}
.setting-row b{color:var(--text-strong)}
.setting-row small{color:var(--muted);font-size:13px}
.setting-row select{min-width:150px}
.setting-row input[type=checkbox]{flex:0 0 auto;min-width:0;width:20px;height:20px;accent-color:var(--accent);cursor:pointer}
.settings-status{margin:10px 2px 0;color:var(--muted);font-size:13px}
.settings-status.ok{color:var(--ok)}
.settings-status.error{color:var(--danger)}

.trace-filter{display:grid;grid-template-columns:minmax(240px,1fr) 150px auto auto;gap:10px;align-items:center;padding:14px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius)}
.clear-filter{display:inline-grid;place-items:center;min-height:var(--control-height);text-decoration:none}
.trace-list{max-width:1080px}
.trace-row{display:grid;grid-template-columns:minmax(180px,.8fr) minmax(0,1.7fr) auto;align-items:center;gap:18px;padding:14px 18px;border-top:1px solid var(--line)}
.trace-row:first-child{border-top:0}
.trace-row>span{display:grid;gap:4px;min-width:0}
.trace-row small{color:var(--muted);font-size:12px;overflow-wrap:anywhere}

.toolbar{display:flex;justify-content:space-between;align-items:end;gap:16px;margin:0 0 16px}
.toolbar p{margin:6px 0 0}
.toolbar-actions{display:flex;align-items:center;gap:8px}.toolbar-actions form{margin:0}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:0;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.stat{display:block;min-width:0;background:transparent;border:0;border-right:1px solid var(--line);padding:15px 17px;text-decoration:none;color:inherit;transition:background-color .14s}
a.stat:hover{background:var(--nav-hover)}
.stat b{display:block;font-size:24px;line-height:1.2;margin-bottom:3px;font-weight:650;letter-spacing:-.02em}
.stat span{color:var(--muted);font-size:12.5px}

.overview-charts{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(280px,.7fr);gap:14px;margin-top:14px}
.chart-card{min-width:0}
.chart-heading{display:flex;align-items:start;justify-content:space-between;gap:16px;margin-bottom:12px}
.chart-heading h3{margin:0;color:var(--text-strong)}
.chart-heading p{margin:3px 0 0;font-size:12.5px}
.chart-key{display:flex;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:12px}
.chart-key span{display:flex;align-items:center;gap:5px}
.legend-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--line-strong)}
.legend-dot.handled{background:var(--ok)}.legend-dot.active{background:var(--accent)}.legend-dot.failed{background:var(--danger)}.legend-dot.stale{background:var(--warn)}
.trend-chart{display:block;width:100%;height:auto;min-height:180px}
.chart-grid{stroke:var(--line);stroke-width:1}
.chart-bar.handled{fill:var(--ok)}.chart-bar.failed{fill:var(--danger)}.chart-bar.stale{fill:var(--warn)}
.chart-label,.chart-value{fill:var(--muted);font:11px ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;text-anchor:middle}
.chart-value{fill:var(--text-strong);font-weight:700}
.chart-empty{min-height:180px;display:grid;place-items:center;color:var(--muted);font-size:13px;text-align:center}
.status-chart{min-height:180px;display:grid;grid-template-columns:minmax(130px,1fr) minmax(120px,1fr);align-items:center;gap:14px}
.donut-chart{display:block;width:min(180px,100%);height:auto;margin:auto}
.donut-base,.chart-segment{fill:none;stroke-width:16}
.donut-base{stroke:var(--line)}
.chart-segment{transform:rotate(-90deg);transform-origin:60px 60px}
.chart-segment.handled{stroke:var(--ok)}.chart-segment.active{stroke:var(--accent)}.chart-segment.failed{stroke:var(--danger)}.chart-segment.stale{stroke:var(--warn)}
.donut-value,.donut-label{fill:var(--text-strong);font:700 22px ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;text-anchor:middle}
.donut-label{fill:var(--muted);font-size:10px;font-weight:500}
.chart-legend{list-style:none;margin:0;padding:0}
.chart-legend li{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:7px 0;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
.chart-legend li:first-child{border-top:0}.chart-legend li>span{display:flex;align-items:center;gap:7px}.chart-legend b{color:var(--text-strong)}

.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr));gap:12px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px}
.row{display:flex;justify-content:space-between;gap:16px;align-items:start}
.badge,.owner{font-size:12px;border-radius:999px;padding:3px 9px;background:var(--badge-bg)}
.badge.ok{color:var(--ok)}
.badge.warning{color:var(--warn)}
.owner{color:var(--link);margin-left:8px}
/* 名称是主角；排障所需的内部 ID 只在悬停或键盘聚焦时出现。 */
.identity{position:relative;display:inline-flex;width:fit-content;align-items:center;border-bottom:1px dotted transparent;cursor:help}
.identity:hover,.identity:focus-visible{border-bottom-color:var(--code-faint)}
.identity-id{position:absolute;z-index:20;bottom:calc(100% + 6px);left:0;width:max-content;max-width:min(420px,calc(100vw - 32px));padding:6px 9px;border:1px solid var(--line-strong);border-radius:7px;background:var(--surface);box-shadow:var(--picker-shadow);color:var(--muted);font-size:11px;font-weight:500;line-height:1.4;opacity:0;visibility:hidden;transform:translateY(3px);pointer-events:none;transition:opacity .12s,transform .12s,visibility .12s}
.identity-id code{font-size:12px}
.identity:hover .identity-id,.identity:focus-visible .identity-id,a:focus-visible .identity-id{opacity:1;visibility:visible;transform:none}
/* 名单一行：姓名是主角，加密 userid 按需展示。 */
.person{display:flex;flex-direction:column;gap:2px;min-width:0}
.person b{font-weight:650}
code.faint{color:var(--code-faint);font-size:12px}
.badge.org{color:var(--org);background:var(--org-bg)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;color:var(--code)}

form{display:flex;gap:8px;align-items:end;margin-top:14px;flex-wrap:wrap}
label{color:var(--muted)}
input,select,button{font:inherit;min-height:var(--control-height);border-radius:var(--radius-sm);border:1px solid var(--line-strong);background:var(--field);color:var(--text-strong);padding:7px 11px}
input{min-width:190px;flex:1}
input::placeholder{color:#6b7280}
input:focus-visible,select:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button{display:inline-flex;align-items:center;justify-content:center;gap:7px;cursor:pointer;background:var(--accent-fill);border-color:var(--accent);color:var(--button-text);font-weight:620;white-space:nowrap;transition:background-color .14s,transform .1s}
button:hover{background:var(--button-hover)}
button:active{transform:scale(.98)}
button.ghost{background:transparent;border-color:var(--line-strong);color:var(--ghost)}
button.ghost:hover{background:var(--nav-hover)}
button.danger,a.button.danger{background:transparent;border-color:var(--danger-border);color:var(--danger)}
button.danger:hover,a.button.danger:hover{background:var(--danger-hover)}
a.button{display:inline-flex;min-height:var(--control-height);align-items:center;justify-content:center;gap:7px;background:var(--accent-fill);border:1px solid var(--accent);border-radius:var(--radius-sm);color:var(--button-text);padding:7px 11px;text-decoration:none;font-weight:620;white-space:nowrap;transition:background-color .14s,transform .1s}
a.button:hover{background:var(--button-hover)}
a.button:active{transform:scale(.98)}
a.button.ghost{background:transparent;border-color:var(--line-strong);color:var(--ghost)}
a.button.ghost:hover{background:var(--nav-hover)}

ul{list-style:none;padding:0;margin:8px 0}
li{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--line);padding:9px 0}
li form{margin:0}
ul.links li{border:none;padding:4px 0;justify-content:flex-start;gap:10px}
ul.links a{color:var(--link);text-decoration:none}
ul.links a:hover{text-decoration:underline}

.onboarding{padding:0;margin-bottom:20px;overflow:hidden}
.onboarding summary{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:17px 19px;cursor:pointer;list-style:none}
.onboarding summary::-webkit-details-marker{display:none}
.onboarding summary>span:first-child{display:grid;gap:2px}
.onboarding summary b{color:var(--text-strong);font-size:17px}
.onboarding summary small{color:var(--muted)}
.onboarding-toggle{color:var(--link);font-size:13px;font-weight:650}
.onboarding[open] summary{border-bottom:1px solid var(--line)}
.onboarding-list{list-style:none;margin:0;padding:4px 19px 12px}
.onboarding-list li{display:grid;grid-template-columns:30px minmax(0,1fr) auto;align-items:center;gap:12px;border-top:1px solid var(--line);padding:13px 0}
.onboarding-list li:first-child{border-top:0}
.onboarding-list li>span:nth-child(2){display:grid;gap:2px}
.onboarding-list b{color:var(--text-strong)}
.onboarding-list small{color:var(--muted);font-size:13px}
.onboarding-list a{color:var(--link);text-decoration:none;font-weight:650;white-space:nowrap}
.onboarding-list a:hover{text-decoration:underline}
.onboarding-mark{width:27px;height:27px;display:grid;place-items:center;border:1px solid var(--line-strong);border-radius:50%;color:var(--muted);font-size:12px;font-weight:750}
.onboarding-list .current .onboarding-mark{border-color:var(--accent);color:var(--accent);background:var(--nav-active)}
.onboarding-list .done .onboarding-mark{border-color:var(--ok);color:var(--ok);background:var(--success-bg)}

.tour-blocker{position:fixed;inset:0;z-index:38}
.tour-mask{position:fixed;z-index:39;pointer-events:none;border:2px solid var(--accent);border-radius:11px;box-shadow:0 0 0 9999px var(--overlay)}
.tour-mask.full{inset:0;border:0;border-radius:0;background:var(--overlay);box-shadow:none}
.tour-panel{position:fixed;z-index:41;width:min(340px,calc(100vw - 32px));padding:18px;background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--radius);box-shadow:0 24px 60px rgb(0 0 0 / .38)}
.tour-panel.center{left:50%;top:50%;transform:translate(-50%,-50%)}
.tour-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.tour-step{color:var(--muted);font-size:12px;font-weight:700;letter-spacing:.08em}
.tour-close{min-height:30px;width:30px;padding:0;background:transparent;border-color:transparent;color:var(--muted);font-size:20px}
.tour-close:hover{background:var(--nav-hover);color:var(--text-strong)}
.tour-panel h2{margin:0 0 7px;font-size:19px}
.tour-panel p{color:var(--muted);margin:0}
.tour-actions{display:flex;justify-content:space-between;gap:10px;margin-top:18px;padding-top:14px;border-top:1px solid var(--line)}
.tour-actions button{min-width:82px}

.notice{max-width:1180px;padding:10px 13px;border-radius:9px;margin:0 auto 18px;background:var(--success-bg);color:var(--success-text)}
.notice.error{background:var(--error-bg);color:var(--error-text)}
.mt{margin-top:14px}
/* 一个群里每台机器人一段：缩进一层，看得出「群 > 机器人」的层级。 */
.agent-block{border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-2);padding:14px;margin-top:12px}
.agent-block h4{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0;font-size:15px}
.agent-block form{margin:0}
.agent-heading{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:14px}
.agent-controls{display:grid;grid-template-columns:repeat(2,minmax(9.5em,1fr));gap:8px}
.agent-controls button{width:100%}
.agent-access{display:flex;align-items:center;gap:10px;margin-top:10px}.agent-access p{margin:0}
.member-list{margin:10px 0 0}.member-row{min-height:44px}.member-main{display:flex;align-items:center;gap:8px;min-width:0}.member-main .owner{margin-left:0}
.agent-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px solid var(--line);margin-top:12px;padding-top:12px}.agent-actions form{margin:0}.agent-actions .danger-action{margin-left:auto}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--line);margin-top:14px;padding-top:14px}
.actions form{margin:0}

dialog.modal{border:1px solid var(--line-strong);border-radius:var(--radius);background:var(--surface);color:var(--text);padding:0;width:min(540px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;box-shadow:0 24px 60px rgb(0 0 0 / .55)}
dialog.modal::backdrop{background:var(--overlay)}
dialog.modal:not(:modal){position:static;margin:0 auto 24px}
.modal form,.modal-body{display:block;margin:0;padding:22px}
.modal h3{margin:0;font-size:19px}
.modal .lede{margin:6px 0 18px;color:var(--muted);font-size:13.5px}
.modal-actions{display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:22px;padding-top:16px;border-top:1px solid var(--line)}

.fields{display:grid;gap:14px}
.field{display:grid;gap:6px}
.field>span,.field>label{color:var(--muted);font-size:13px}
.field input,.field select{width:100%;min-width:0}
.auth-options{display:grid;gap:9px;border:1px solid var(--line);border-radius:var(--radius-sm);padding:12px 14px;margin:0}
.auth-options legend{color:var(--muted);font-size:13px;padding:0 5px}
.auth-options>label{display:flex;align-items:center;gap:7px;color:var(--text);cursor:pointer}
.auth-options input[type=radio]{flex:0 0 auto;min-width:0;width:16px;height:16px;accent-color:var(--accent)}
.manual-auth-fields{display:grid;gap:10px;margin-top:4px}
.manual-auth-fields[hidden]{display:none}
.hint{margin:0;color:var(--muted);font-size:12.5px}
.hint a{color:var(--link)}
.picked{color:var(--ok);font-size:12.5px}

/* 绑定候选：一台机器人一行，勾几台绑几台。 */
.choices{display:grid;gap:6px;width:100%}
.choice{display:flex;align-items:center;gap:9px;padding:7px 10px;border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-2);color:var(--text);cursor:pointer}
.choice:hover{border-color:var(--line-strong)}
.choice input{flex:0 0 auto;min-width:0;width:16px;height:16px;accent-color:var(--accent);cursor:pointer}
.choice span{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.choice .badge{font-size:11.5px}

.picker{position:relative}
/* 面板按视口定位（位置由脚本贴到输入框上）：对话框在 Chrome 里是个 overflow:auto 的滚动盒，
   absolute 定位的浮层会被它裁掉一半。fixed 让面板脱出所有祖先的裁剪，空间不够时还能翻到输入框上方。 */
.picker-panel{position:fixed;z-index:30;display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line-strong);border-radius:var(--radius-sm);box-shadow:var(--picker-shadow);overflow:hidden}
/* 作者样式里的 display 会盖掉 [hidden] 自带的 display:none，收起状态必须自己写回来。 */
.picker-panel[hidden]{display:none}
.picker-head,.picker-foot{flex:0 0 auto;display:flex;gap:10px;align-items:center;justify-content:space-between;padding:8px 10px}
.picker-head{border-bottom:1px solid var(--line)}
.picker-head code{font-size:12.5px}
.picker-foot{border-top:1px solid var(--line);color:var(--muted);font-size:12.5px}
.picker-list{flex:1 1 auto;min-height:0;overflow:auto;padding:5px}
.picker-item{display:flex;width:100%;gap:12px;align-items:baseline;justify-content:space-between;text-align:left;background:transparent;border:0;border-radius:7px;color:var(--text);padding:7px 9px;font-weight:400}
.picker-item:hover,.picker-item.active{background:var(--picker-hover);color:var(--text-strong)}
.picker-label{overflow-wrap:anywhere}
.picker-hint{color:var(--muted);font-size:12.5px;white-space:nowrap}
.picker-empty{margin:6px 9px;color:var(--muted);font-size:13px}
.picker-action{min-height:32px;background:transparent;border:1px solid var(--line-strong);color:var(--ghost);padding:5px 9px;font-size:13px;font-weight:600;white-space:nowrap}
.picker-action:hover{background:var(--nav-hover)}
.picker-action.primary{background:var(--accent-fill);border-color:var(--accent);color:var(--button-text)}
.picker-action.primary:hover{background:var(--button-hover)}

@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{scroll-behavior:auto!important;transition-duration:.01ms!important}
}
@media(prefers-reduced-transparency:reduce){
  .sidebar{background:var(--bg);backdrop-filter:none}
}
@media(prefers-contrast:more){
  .sidebar,.card,.list-panel,.stats,.trace-filter,input,select,button,a.button{border-color:var(--text)}
}
@media(max-width:820px){
  .app-shell{display:block}
  .sidebar{position:relative;width:auto;height:auto;padding:14px 16px 0;border-right:0;border-bottom:1px solid var(--line)}
  .brand{padding:0 2px 13px}.brand small,.sidebar-foot{display:none}
  .sidebar-bottom{margin:3px 0 0;display:block}.utility-nav{border-top:1px solid var(--line)}
  .side-nav{display:flex;gap:3px;overflow-x:auto}.side-nav a{flex:0 0 auto;padding:9px 11px;border-radius:9px 9px 0 0}.side-nav a.active{box-shadow:inset 0 -2px var(--accent)}
  main{padding:22px 16px 60px}
  header.top{align-items:start;margin-bottom:20px;padding-bottom:18px}
  .toolbar{align-items:start;flex-direction:column}
  .overview-charts{grid-template-columns:1fr}
  .group-row{grid-template-columns:minmax(0,1fr) auto}.group-agents{display:none}
  .trace-filter{grid-template-columns:minmax(0,1fr) 140px auto}.clear-filter{grid-column:1/-1;justify-content:start}
}
@media(max-width:520px){.instance{display:none}.grid{grid-template-columns:1fr}.card{padding:16px}.onboarding{padding:0}.onboarding-list li{grid-template-columns:30px minmax(0,1fr)}.onboarding-list li>a{grid-column:2}.chart-heading{display:grid}.chart-key{gap:9px}.status-chart{grid-template-columns:1fr 1fr;gap:8px}.section-head,.detail-title{align-items:flex-start;flex-direction:column}.detail-title-actions{width:100%;justify-content:space-between}.group-row{padding:13px 14px}.group-state .badge{display:none}.agent-heading{grid-template-columns:1fr}.agent-controls{width:100%;grid-template-columns:1fr 1fr}.agent-access{align-items:flex-start;flex-direction:column}.agent-actions{display:grid;grid-template-columns:1fr 1fr}.agent-actions>a,.agent-actions form,.agent-actions button{width:100%}.agent-actions .danger-action{grid-column:1/-1;margin-left:0}.setting-row{align-items:center}.setting-row:has(select){align-items:flex-start;flex-direction:column}.setting-row select{width:100%}.trace-filter{grid-template-columns:1fr}.trace-row{grid-template-columns:1fr}.trace-row>.badge{justify-self:start}}
`;

export const CLIENT_SCRIPT = `"use strict";
// 这个脚本在 <head> 里同步加载：先给 <html> 打上 js 标记，无脚本回退的入口才不会闪一下。
document.documentElement.classList.add("js");

var savedTheme;
try { savedTheme = localStorage.getItem("threadferry-theme"); } catch (_) {}
var themePreference = savedTheme === "light" || savedTheme === "dark" ? savedTheme : "system";
var systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
applyThemePreference();
systemTheme.addEventListener("change", function () {
  if (themePreference === "system") applyThemePreference();
});

var showLogTracking = true;
try { showLogTracking = localStorage.getItem("threadferry-show-log-tracking") !== "false"; } catch (_) {}
document.documentElement.classList.toggle("hide-log-tracking", !showLogTracking);

var openPicker = null;

document.addEventListener("DOMContentLoaded", function () {
  setupThemePreference();
  setupInterfacePreferences();
  setupDesktopPreferences();
  setupUpdateCheck();
  each("[data-confirm]", function (form) {
    form.addEventListener("submit", function (event) {
      if (!window.confirm(form.getAttribute("data-confirm"))) event.preventDefault();
    });
  });
  setupDialogs();
  setupCapabilityPolling();
  setupOnboardingTour();
  each("[data-auth-form]", setupAuthMode);
  each("[data-picker]", attachPicker);
});

function setupCapabilityPolling() {
  if (!document.querySelector("[data-capability-pending]")) return;
  window.setTimeout(function () { window.location.reload(); }, 2000);
}

function setupOnboardingTour() {
  if (!document.querySelector("[data-onboarding]")) return;
  var forced = new URLSearchParams(window.location.search).get("tour") === "1";
  var completed = false;
  try { completed = localStorage.getItem("threadferry-onboarding-tour-v1") === "done"; } catch (_) {}
  if (completed && !forced) return;

  var steps = [
    { title: "一个 Agent 对应一个机器人", description: "每个机器人都有独立的 Owner、Workspace、Runtime、凭据和 Session。想使用哪个项目，就私聊对应的机器人。" },
    { target: "agents", title: "在这里管理机器人", description: "查看机器人授权、Owner、Runtime 和 Workspace；需要增加项目时，再添加一台机器人。" },
    { target: "groups", title: "群聊接入是可选的", description: "把机器人加入目标群并 @它一次，ThreadFerry 收到后会自动启用，不需要手动绑定。" },
  ];
  var index = 0;
  var target = null;
  var previousFocus = document.activeElement;
  var blocker = element("div", null, "tour-blocker");
  var mask = element("div", null, "tour-mask");
  var panel = element("section", null, "tour-panel");
  var head = element("div", null, "tour-head");
  var indicator = element("span", null, "tour-step");
  var close = element("button", "×", "tour-close");
  var title = element("h2");
  var description = element("p");
  var actions = element("div", null, "tour-actions");
  var skip = element("button", "跳过", "ghost");
  var next = element("button", "下一步");
  close.type = skip.type = next.type = "button";
  close.setAttribute("aria-label", "关闭使用引导");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "tour-title");
  title.id = "tour-title";
  head.appendChild(indicator);
  head.appendChild(close);
  actions.appendChild(skip);
  actions.appendChild(next);
  panel.appendChild(head);
  panel.appendChild(title);
  panel.appendChild(description);
  panel.appendChild(actions);
  document.body.appendChild(blocker);
  document.body.appendChild(mask);
  document.body.appendChild(panel);

  function finish() {
    try { localStorage.setItem("threadferry-onboarding-tour-v1", "done"); } catch (_) {}
    window.removeEventListener("resize", place);
    document.removeEventListener("keydown", onKeydown);
    blocker.remove();
    mask.remove();
    panel.remove();
    if (previousFocus && typeof previousFocus.focus === "function") previousFocus.focus();
  }

  function place() {
    var step = steps[index];
    panel.classList.toggle("center", !step.target);
    mask.classList.toggle("full", !step.target || !target);
    if (!step.target || !target) {
      panel.style.left = panel.style.top = panel.style.transform = "";
      mask.style.left = mask.style.top = mask.style.width = mask.style.height = "";
      return;
    }
    panel.style.transform = "none";
    var rect = target.getBoundingClientRect();
    mask.style.left = Math.max(4, rect.left - 5) + "px";
    mask.style.top = Math.max(4, rect.top - 5) + "px";
    mask.style.width = Math.min(window.innerWidth - 8, rect.width + 10) + "px";
    mask.style.height = Math.min(window.innerHeight - 8, rect.height + 10) + "px";
    var width = panel.offsetWidth;
    var height = panel.offsetHeight;
    var beside = window.innerWidth - rect.right >= width + 28;
    panel.style.left = Math.max(16, Math.min(beside ? rect.right + 16 : rect.left, window.innerWidth - width - 16)) + "px";
    panel.style.top = Math.max(16, Math.min(beside ? rect.top : rect.bottom + 12, window.innerHeight - height - 16)) + "px";
  }

  function render() {
    var step = steps[index];
    target = step.target ? document.querySelector('[data-tour-target="' + step.target + '"]') : null;
    indicator.textContent = String(index + 1) + " / " + String(steps.length);
    title.textContent = step.title;
    description.textContent = step.description;
    next.textContent = index === steps.length - 1 ? "完成" : "下一步";
    place();
    next.focus();
  }

  function onKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      finish();
      return;
    }
    if (event.key !== "Tab") return;
    var controls = [close, skip, next];
    var current = controls.indexOf(document.activeElement);
    if (event.shiftKey && current <= 0) {
      event.preventDefault();
      next.focus();
    } else if (!event.shiftKey && current === controls.length - 1) {
      event.preventDefault();
      close.focus();
    }
  }

  close.addEventListener("click", finish);
  skip.addEventListener("click", finish);
  next.addEventListener("click", function () {
    if (index === steps.length - 1) finish();
    else {
      index += 1;
      render();
    }
  });
  window.addEventListener("resize", place);
  document.addEventListener("keydown", onKeydown);
  render();
}

function setupThemePreference() {
  var select = document.querySelector("[data-theme-preference]");
  if (!select) return;
  select.value = themePreference;
  select.addEventListener("change", function () { saveThemePreference(select.value); });
}

function saveThemePreference(next) {
  themePreference = next === "light" || next === "dark" ? next : "system";
  try {
    if (themePreference === "system") localStorage.removeItem("threadferry-theme");
    else localStorage.setItem("threadferry-theme", themePreference);
  } catch (_) {}
  applyThemePreference();
}

function applyThemePreference() {
  var theme = themePreference === "system" ? (systemTheme.matches ? "dark" : "light") : themePreference;
  document.documentElement.setAttribute("data-theme", theme);
  var select = document.querySelector("[data-theme-preference]");
  if (select) select.value = themePreference;
}

function setupInterfacePreferences() {
  var input = document.querySelector('[data-interface-preference="showLogTracking"]');
  if (!input) return;
  input.checked = showLogTracking;
  input.addEventListener("change", function () {
    showLogTracking = input.checked;
    document.documentElement.classList.toggle("hide-log-tracking", !showLogTracking);
    try { localStorage.setItem("threadferry-show-log-tracking", String(showLogTracking)); } catch (_) {}
  });
}

function setupDesktopPreferences() {
  var root = document.querySelector("[data-desktop-settings]");
  if (!root) return;
  var fields = root.querySelector("[data-desktop-fields]");
  var status = root.querySelector("[data-desktop-status]");
  var platform = root.querySelector("[data-desktop-platform]");
  var bridge = window.threadferryDesktop;
  function message(text, kind) {
    status.textContent = text;
    status.className = "settings-status" + (kind ? " " + kind : "");
  }
  if (!bridge || typeof bridge.getPreferences !== "function" || typeof bridge.setPreferences !== "function") {
    if (platform) platform.textContent = "浏览器模式";
    message("桌面偏好请在 ThreadFerry 桌面应用的管理台中设置。", "");
    return;
  }
  function render(state) {
    var labels = { darwin: "macOS", win32: "Windows", linux: "Linux" };
    if (platform) platform.textContent = labels[state.platform] || state.platform;
    each("[data-capability]", function (row) {
      row.hidden = state.capabilities[row.getAttribute("data-capability")] !== true;
    });
    each("[data-desktop-preference]", function (input) {
      input.checked = state.preferences[input.getAttribute("data-desktop-preference")] === true;
    });
    fields.disabled = false;
  }
  function save() {
    var values = {};
    each("[data-desktop-preference]", function (input) {
      values[input.getAttribute("data-desktop-preference")] = input.checked;
    });
    fields.disabled = true;
    message("正在保存…", "");
    bridge.setPreferences(values).then(function (state) {
      render(state);
      message("偏好已保存。", "ok");
    }).catch(function (error) {
      fields.disabled = false;
      message("保存失败：" + (error && error.message ? error.message : "未知错误"), "error");
    });
  }
  fields.addEventListener("change", function (event) {
    var input = event.target.closest("[data-desktop-preference]");
    if (!input) return;
    var autoStart = fields.querySelector('[data-desktop-preference="autoStartService"]');
    var openManagement = fields.querySelector('[data-desktop-preference="openManagementOnLaunch"]');
    if (input === autoStart && !autoStart.checked) openManagement.checked = false;
    if (input === openManagement && openManagement.checked) autoStart.checked = true;
    save();
  });
  bridge.getPreferences().then(function (state) {
    render(state);
    message("偏好保存在当前设备。", "");
  }).catch(function (error) {
    message("无法读取桌面偏好：" + (error && error.message ? error.message : "未知错误"), "error");
  });
}

function setupUpdateCheck() {
  each("[data-update-check]", function (form) {
    var button = form.querySelector("button");
    var status = document.querySelector("[data-update-status]");
    var bridge = window.threadferryDesktop;
    if (bridge && typeof bridge.updateAndRestart === "function" && typeof bridge.onUpdateStatus === "function") {
      function render(update) {
        status.className = "settings-status";
        if (update.phase === "checking") {
          button.disabled = true;
          button.textContent = "检查中…";
          status.textContent = "正在检查新版本。";
        } else if (update.phase === "downloading") {
          button.disabled = true;
          button.textContent = "下载中…";
          status.textContent = "正在后台下载 ThreadFerry " + update.version + "（" + Math.round(update.percent || 0) + "%）。";
        } else if (update.phase === "waiting") {
          button.disabled = true;
          button.textContent = "准备重启…";
          status.textContent = "更新已下载，正在等待运行中的任务安全结束。";
        } else if (update.phase === "installing") {
          button.disabled = true;
          button.textContent = "正在重启…";
          status.textContent = "正在安装 ThreadFerry " + update.version + " 并自动重启。";
        } else if (update.phase === "current") {
          button.disabled = false;
          button.textContent = "再次检查";
          status.textContent = "ThreadFerry " + update.version + " 已是最新版本。";
          status.className += " ok";
        } else if (update.phase === "error") {
          button.disabled = false;
          button.textContent = "重试更新";
          status.textContent = "自动更新失败：" + (update.message || "未知错误");
          status.className += " error";
        }
      }
      button.textContent = "立即检查更新";
      status.textContent = "桌面应用会在后台自动检查、安装并重启。";
      bridge.onUpdateStatus(render);
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        render({ phase: "checking" });
        bridge.updateAndRestart().then(function (result) {
          if (result.status === "current") render({ phase: "current", version: result.version });
        }).catch(function (error) {
          render({ phase: "error", message: error && error.message ? error.message : "未知错误" });
        });
      });
      return;
    }
    form.addEventListener("submit", function () {
      button.disabled = true;
      button.textContent = "检查中…";
    });
  });
}

function each(selector, run) {
  var nodes = document.querySelectorAll(selector);
  for (var index = 0; index < nodes.length; index += 1) run(nodes[index]);
}

function setupDialogs() {
  each("[data-dialog]", function (trigger) {
    var dialog = document.getElementById(trigger.getAttribute("data-dialog"));
    if (!dialog) return;
    trigger.addEventListener("click", function (event) {
      event.preventDefault();
      showDialog(dialog);
    });
  });
  each("[data-close-dialog]", function (control) {
    control.addEventListener("click", function (event) {
      event.preventDefault();
      var dialog = control.closest("dialog");
      if (dialog) dialog.close();
    });
  });
  each("dialog", function (dialog) {
    // 选择菜单展开时按 Esc 只收起菜单，不要顺手把整个对话框关掉、让用户重填一遍。
    dialog.addEventListener("cancel", function (event) {
      if (!openPicker) return;
      event.preventDefault();
      openPicker.close();
    });
    // Esc 关对话框自己接一遍：浏览器的 close request 在个别环境里不触发，不能只靠它。
    dialog.addEventListener("keydown", function (event) {
      if (event.key !== "Escape" || openPicker) return;
      event.preventDefault();
      dialog.close();
    });
  });
  // 服务端为「无脚本回退」渲染成 open 的对话框（表单报错后带值回来时也走这里），升级为真模态。
  each("dialog[open]", function (dialog) {
    dialog.close();
    showDialog(dialog);
  });
}

function showDialog(dialog) {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  var first = dialog.querySelector("[autofocus]");
  if (first && typeof first.focus === "function") first.focus();
}

function setupAuthMode(root) {
  var fields = root.querySelector("[data-manual-fields]");
  var radios = root.querySelectorAll("input[name='authMode']");
  if (!fields || radios.length === 0) return;
  function update() {
    var selected = root.querySelector("input[name='authMode']:checked");
    var manual = selected && selected.value === "manual";
    fields.hidden = !manual;
    var inputs = fields.querySelectorAll("input");
    for (var index = 0; index < inputs.length; index += 1) inputs[index].required = Boolean(manual);
  }
  for (var index = 0; index < radios.length; index += 1) radios[index].addEventListener("change", update);
  update();
}

function element(tag, value, className) {
  var node = document.createElement(tag);
  if (value !== undefined && value !== null) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function actionButton(label, run, variant) {
  var node = element("button", label, "picker-action" + (variant ? " " + variant : ""));
  node.type = "button";
  node.addEventListener("click", function (event) {
    event.preventDefault();
    run();
  });
  return node;
}

// 一个输入框 + 一张贴在它下面的选择菜单：点输入框就展开，边打字边筛，↑↓ 选、回车确认、Esc 收起。
// 目录和通讯录两种数据源共用这套交互，差别只在拉什么接口、每行怎么渲染。
function attachPicker(input) {
  var kind = input.getAttribute("data-picker");
  var root = input.closest("[data-picker-root]") || input.parentElement;
  // 提示位按字段名在同一张表单里找：群卡片每个都有一个同名的 user 字段，全局查会全部写到第一个上。
  var note = (input.closest("form") || document).querySelector("[data-picker-note='" + input.getAttribute("name") + "']");
  var panel = element("div", null, "picker-panel");
  var items = [];
  var active = -1;
  var pending = 0;
  var timer = 0;
  var api = { close: close };

  panel.hidden = true;
  root.appendChild(panel);
  input.setAttribute("autocomplete", "off");
  input.setAttribute("aria-expanded", "false");
  input.addEventListener("focus", function () { load(0); });
  input.addEventListener("click", function () { load(0); });
  input.addEventListener("input", function () { load(180); });
  input.addEventListener("keydown", onKeydown);
  // 在菜单上按下鼠标时不要把焦点从输入框抢走，否则每选一次都要重新点回输入框。
  panel.addEventListener("pointerdown", function (event) { event.preventDefault(); });
  document.addEventListener("pointerdown", function (event) {
    if (openPicker === api && !root.contains(event.target) && !panel.contains(event.target)) close();
  });
  window.addEventListener("resize", function () { if (openPicker === api) place(); });
  window.addEventListener("scroll", function () { if (openPicker === api) place(); }, true);

  // 贴到输入框下沿；下方装不下就翻到上方，高度按视口剩余空间收，永远留得下页脚按钮。
  function place() {
    var rect = input.getBoundingClientRect();
    var below = window.innerHeight - rect.bottom - 14;
    var above = rect.top - 14;
    var downward = below >= 220 || below >= above;
    panel.style.left = Math.max(8, rect.left) + "px";
    panel.style.width = rect.width + "px";
    panel.style.maxHeight = Math.max(140, Math.min(320, downward ? below : above)) + "px";
    panel.style.top = downward ? rect.bottom + 6 + "px" : "auto";
    panel.style.bottom = downward ? "auto" : window.innerHeight - rect.top + 6 + "px";
  }

  function open() {
    if (openPicker && openPicker !== api) openPicker.close();
    panel.hidden = false;
    input.setAttribute("aria-expanded", "true");
    openPicker = api;
    place();
  }

  function close() {
    panel.hidden = true;
    input.setAttribute("aria-expanded", "false");
    active = -1;
    if (openPicker === api) openPicker = null;
  }

  function load(delay) {
    window.clearTimeout(timer);
    timer = window.setTimeout(run, delay);
  }

  function run() {
    var value = input.value.trim();
    var url = kind === "users"
      ? "/api/users?agent=" + encodeURIComponent(input.getAttribute("data-agent-id") || "") + "&q=" + encodeURIComponent(value)
      : "/api/dirs?path=" + encodeURIComponent(value);
    var ticket = (pending += 1);
    fetch(url, { headers: { accept: "application/json" } }).then(function (response) {
      return response.ok ? response.json() : null;
    }).then(function (data) {
      if (ticket !== pending) return; // 只认最后一次请求的结果，边打字边请求不会互相盖掉
      render(data ? (kind === "users" ? userView(data) : directoryView(data)) : { items: [], empty: "读取失败，请重试。" });
    }).catch(function () {
      if (ticket === pending) render({ items: [], empty: "读取失败，请重试。" });
    });
  }

  function drill(path) {
    input.value = path;
    input.focus();
    load(0);
  }

  function pick(value, label) {
    input.value = value;
    if (note) note.textContent = label || "";
    close();
  }

  function directoryView(data) {
    var head = element("div", null, "picker-head");
    head.appendChild(element("code", data.current));
    if (data.parent) head.appendChild(actionButton("↑ 上级", function () { drill(data.parent); }));
    var status = data.truncated ? "子目录过多，继续输入可缩小范围" : data.filter ? "筛选：" + data.filter : "点子目录继续进入";
    var foot = element("div", null, "picker-foot");
    foot.appendChild(element("span", data.note || status));
    foot.appendChild(actionButton("使用此目录", function () { pick(data.current); }, "primary"));
    return {
      head: head,
      foot: foot,
      items: (data.entries || []).map(function (entry) {
        return { label: entry.name + "/", choose: function () { drill(entry.path); } };
      }),
      empty: data.filter ? "没有名字匹配「" + data.filter + "」的子目录。" : "这里没有可进入的子目录。",
    };
  }

  function userView(data) {
    var foot = null;
    if (data.note) {
      foot = element("div", null, "picker-foot");
      foot.appendChild(element("span", data.note));
    }
    return {
      foot: foot,
      items: (data.users || []).map(function (user) {
        var extra = [user.alias, (user.departments || []).join(" / ")].filter(Boolean).join(" · ");
        return {
          label: user.name,
          hint: extra || user.id,
          choose: function () { pick("id:" + user.id, "已选择 " + user.name + "（" + user.id + "）"); },
        };
      }),
      empty: input.value.trim() ? "通讯录里没有匹配的人。" : "输入姓名或别名开始搜索。",
    };
  }

  function render(view) {
    panel.textContent = "";
    items = [];
    if (view.head) panel.appendChild(view.head);
    var list = element("div", null, "picker-list");
    list.setAttribute("role", "listbox");
    if (view.items.length === 0) list.appendChild(element("p", view.empty || "没有可选项。", "picker-empty"));
    view.items.forEach(function (item) {
      var node = element("button", null, "picker-item");
      node.type = "button";
      node.setAttribute("role", "option");
      node.appendChild(element("span", item.label, "picker-label"));
      if (item.hint) node.appendChild(element("span", item.hint, "picker-hint"));
      node.addEventListener("click", function (event) {
        event.preventDefault();
        item.choose();
      });
      list.appendChild(node);
      items.push({ node: node, choose: item.choose });
    });
    panel.appendChild(list);
    if (view.foot) panel.appendChild(view.foot);
    active = -1;
    open();
  }

  function move(step) {
    if (items.length === 0) return;
    active = (active + step + items.length) % items.length;
    for (var index = 0; index < items.length; index += 1) {
      var node = items[index].node;
      if (index !== active) node.classList.remove("active");
      else {
        node.classList.add("active");
        node.scrollIntoView({ block: "nearest" });
      }
    }
  }

  function onKeydown(event) {
    if (event.key === "Escape") {
      if (panel.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (panel.hidden) load(0);
      else move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter" && !panel.hidden && active >= 0) {
      event.preventDefault();
      items[active].choose();
      return;
    }
    if (event.key === "Tab") close();
  }
}
`;
