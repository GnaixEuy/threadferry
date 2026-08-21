// 管理台的样式表和前端脚本以字符串常量内联在 TS 里：tsc 不会把 .css/.js 资源拷进 dist，
// 而 npm 包只发布 dist/src，所以任何独立资源文件在安装后都会消失。常量则跟着编译产物走。
// 两个文件都由 /admin.css 与 /admin.js 同源提供，CSP 因此只需要放开 'self'，不必 unsafe-inline。

export const STYLESHEET = `:root{
  color-scheme:light;
  --bg:#f5f7fb;
  --sidebar:#ffffff;
  --surface:#ffffff;
  --surface-2:#f8fafc;
  --field:#ffffff;
  --line:#e3e8f0;
  --line-strong:#cbd3df;
  --text:#344054;
  --text-strong:#101828;
  --muted:#667085;
  --accent:#2563eb;
  --accent-fill:#2563eb;
  --link:#245fce;
  --ok:#17803d;
  --warn:#a15c00;
  --danger:#c72c41;
  --nav-hover:#f4f6fa;
  --nav-active:#eaf1ff;
  --badge-bg:#edf1f7;
  --stat-end:#f9fbff;
  --card-shadow:0 1px 3px rgb(16 24 40 / .06),0 1px 2px rgb(16 24 40 / .03);
  --overlay:rgb(15 23 42 / .32);
  --success-bg:#eaf8ef;
  --success-text:#166534;
  --error-bg:#fff0f1;
  --error-text:#b42334;
  --code:#526078;
  --code-faint:#7d899d;
  --org:#6941c6;
  --org-bg:#f1edff;
  --picker-hover:#edf3ff;
  --ghost:#475467;
  --danger-border:#e7a6af;
  --danger-hover:#fff1f2;
  --button-hover:#1d4ed8;
  --button-text:#ffffff;
  --brand-shadow:0 8px 24px rgb(37 99 235 / .2);
  --status-ring:rgb(23 128 61 / .1);
  --picker-shadow:0 18px 40px rgb(15 23 42 / .16);
  --card-top:rgb(255 255 255 / .8);
  --radius:14px;
  --radius-sm:9px;
  --control-height:38px;
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  color:var(--text);
  background:var(--bg);
}
:root[data-theme="dark"]{
  color-scheme:dark;
  --bg:#0b0d12;
  --sidebar:#10131a;
  --surface:#151922;
  --surface-2:#11151d;
  --field:#0e1118;
  --line:#252b37;
  --line-strong:#343c4c;
  --text:#e7e9ee;
  --text-strong:#eef1f6;
  --muted:#9ca3af;
  --accent:#3975eb;
  --accent-fill:#2f67d8;
  --link:#8cb4ff;
  --ok:#7ee787;
  --warn:#f2cc60;
  --danger:#ff9aa7;
  --nav-hover:#181d27;
  --nav-active:#20283a;
  --badge-bg:#2b3140;
  --stat-end:#12161e;
  --card-shadow:0 1px 0 rgb(255 255 255 / .02);
  --overlay:rgb(6 8 12 / .68);
  --success-bg:#143321;
  --success-text:#8de6a9;
  --error-bg:#3b171d;
  --error-text:#ffabb4;
  --code:#b8c2d9;
  --code-faint:#7c869e;
  --org:#c4b5fd;
  --org-bg:#2c2a45;
  --picker-hover:#1d2331;
  --ghost:#cdd5e4;
  --danger-border:#7f3340;
  --danger-hover:#2a161b;
  --button-hover:#3872e6;
  --button-text:#ffffff;
  --brand-shadow:0 8px 24px rgb(44 102 220 / .28);
  --status-ring:rgb(126 231 135 / .1);
  --picker-shadow:0 18px 40px rgb(0 0 0 / .5);
  --card-top:rgb(255 255 255 / .02);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg)}
.app-shell{min-height:100vh;display:grid;grid-template-columns:240px minmax(0,1fr)}
.sidebar{position:sticky;top:0;height:100vh;padding:22px 14px 18px;background:var(--sidebar);border-right:1px solid var(--line);display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:11px;padding:0 10px 24px;color:var(--text-strong);text-decoration:none}
.brand-mark{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:linear-gradient(145deg,#4d84f5,#285cc2);color:white;font-size:12px;font-weight:800;box-shadow:var(--brand-shadow)}
.brand b,.brand small{display:block}.brand b{letter-spacing:.1px}.brand small{color:var(--muted);font-size:12px;font-weight:500;margin-top:1px}
.side-nav{display:grid;gap:5px}
.side-nav a{display:flex;align-items:center;gap:11px;color:var(--muted);text-decoration:none;padding:10px 12px;border-radius:9px;font-weight:600}
.side-nav a:hover{color:var(--text);background:var(--nav-hover)}
.side-nav a.active{color:var(--text-strong);background:var(--nav-active);box-shadow:inset 3px 0 var(--accent)}
.nav-icon{width:20px;text-align:center;font-size:17px;color:#8994aa}
.side-nav a.active .nav-icon{color:var(--link)}
.sidebar-bottom{margin-top:auto;display:grid;gap:14px}
.sidebar-foot{padding:14px 11px 0;border-top:1px solid var(--line);display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}
.status-dot{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px var(--status-ring)}
main{min-width:0;padding:30px clamp(24px,4vw,56px) 80px}
header.top{display:flex;justify-content:space-between;align-items:center;gap:24px;max-width:1320px;margin:0 auto 26px;padding-bottom:22px;border-bottom:1px solid var(--line)}
.eyebrow{color:var(--muted);font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;margin:0 0 3px}
h1{font-size:28px;line-height:1.2;margin:0;letter-spacing:-.02em}
h2{margin:32px 0 14px;font-size:18px}
h2.flush{margin:0}
.section-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:32px}
.section-head h2{margin:0}
.section-head p{margin:3px 0 0}
.list-panel{overflow:hidden;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--card-shadow)}
.group-row{display:grid;grid-template-columns:minmax(240px,1.5fr) minmax(160px,1fr) auto;align-items:center;gap:20px;padding:15px 18px;color:var(--text);text-decoration:none;border-top:1px solid var(--line)}
.group-row:first-child{border-top:0}
.group-row:hover{background:var(--nav-hover)}
.group-main{display:flex;align-items:center;gap:12px;min-width:0}
.group-main>span:last-child{display:grid;min-width:0}.group-main b{color:var(--text-strong);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.group-main code{font-size:12px}
.group-avatar{flex:0 0 36px;width:36px;height:36px;display:grid;place-items:center;border-radius:10px;background:var(--nav-active);color:var(--accent);font-size:13px;font-weight:750}
.group-agents{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.group-state{display:flex;align-items:center;justify-content:flex-end;gap:12px}
.row-arrow{color:var(--muted);font-size:24px;line-height:1}
.empty-state{padding:22px;margin:0;color:var(--muted)}
.back-link{display:inline-block;color:var(--link);text-decoration:none;margin-bottom:14px}.back-link:hover{text-decoration:underline}
.detail-title{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:18px}.detail-title h2{margin:0 0 3px;font-size:24px}.detail-title .eyebrow{margin-bottom:4px}
.group-detail{max-width:920px}.group-detail>.row{margin-bottom:6px}
h3,h4,p{margin:0 0 10px}
.sub,.muted{color:var(--muted)}
.js .no-js{display:none}
.theme-toggle{display:flex;width:100%;align-items:center;justify-content:flex-start;gap:9px;color:var(--text);font-weight:600}
.theme-toggle:hover{background:var(--nav-hover)}
.instance{display:grid;grid-template-columns:auto auto;align-items:baseline;column-gap:7px;padding:10px 14px;border:1px solid var(--line);border-radius:11px;background:var(--surface)}
.instance b{font-size:20px}.instance span{color:var(--text)}.instance small{grid-column:1/-1;color:var(--muted);font-size:11px}
.page-content{max-width:1320px;margin:0 auto}

.toolbar{display:flex;justify-content:space-between;align-items:end;gap:16px;margin:0 0 16px}
.toolbar p{margin:6px 0 0}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat{display:block;background:linear-gradient(145deg,var(--surface),var(--stat-end));border:1px solid var(--line);border-radius:var(--radius);padding:17px 18px;text-decoration:none;color:inherit;box-shadow:var(--card-shadow);transition:border-color .16s,transform .16s}
a.stat:hover{border-color:#46536a;transform:translateY(-1px)}
.stat b{display:block;font-size:28px;line-height:1.2;margin-bottom:4px}
.stat span{color:var(--muted);font-size:13px}

.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr));gap:14px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:19px;box-shadow:var(--card-shadow)}
.row{display:flex;justify-content:space-between;gap:16px;align-items:start}
.badge,.owner{font-size:12px;border-radius:999px;padding:3px 9px;background:var(--badge-bg)}
.badge.ok{color:var(--ok)}
.badge.warning{color:var(--warn)}
.owner{color:var(--link);margin-left:8px}
/* 名单一行：姓名是主角，加密 userid 退成次要信息。 */
.person{display:flex;flex-direction:column;gap:2px;min-width:0}
.person b{font-weight:650}
code.faint{color:var(--code-faint);font-size:12px}
.badge.org{color:var(--org);background:var(--org-bg)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;color:var(--code)}

form{display:flex;gap:8px;align-items:end;margin-top:14px;flex-wrap:wrap}
label{color:var(--muted)}
input,select,button{font:inherit;min-height:var(--control-height);border-radius:var(--radius-sm);border:1px solid var(--line-strong);background:var(--field);color:var(--text-strong);padding:8px 12px}
input{min-width:190px;flex:1}
input::placeholder{color:#6b7280}
input:focus-visible,select:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button{display:inline-flex;align-items:center;justify-content:center;gap:7px;cursor:pointer;background:var(--accent-fill);border-color:var(--accent);color:var(--button-text);font-weight:650;white-space:nowrap}
button:hover{background:var(--button-hover)}
button.ghost{background:transparent;border-color:var(--line-strong);color:var(--ghost)}
button.ghost:hover{background:var(--nav-hover)}
button.danger{background:transparent;border-color:var(--danger-border);color:var(--danger)}
button.danger:hover{background:var(--danger-hover)}
a.button{display:inline-flex;min-height:var(--control-height);align-items:center;justify-content:center;gap:7px;background:var(--accent-fill);border:1px solid var(--accent);border-radius:var(--radius-sm);color:var(--button-text);padding:8px 12px;text-decoration:none;font-weight:650;white-space:nowrap}
a.button:hover{background:var(--button-hover)}
a.button.ghost{background:transparent;border-color:var(--line-strong);color:var(--ghost)}
a.button.ghost:hover{background:var(--nav-hover)}

ul{list-style:none;padding:0;margin:8px 0}
li{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--line);padding:9px 0}
li form{margin:0}
ul.links li{border:none;padding:4px 0;justify-content:flex-start;gap:10px}
ul.links a{color:var(--link);text-decoration:none}
ul.links a:hover{text-decoration:underline}

.notice{max-width:1320px;padding:11px 14px;border-radius:10px;margin:0 auto 18px;background:var(--success-bg);color:var(--success-text)}
.notice.error{background:var(--error-bg);color:var(--error-text)}
.mt{margin-top:14px}
/* 一个群里每台机器人一段：缩进一层，看得出「群 > 机器人」的层级。 */
.agent-block{border:1px solid var(--line);border-radius:var(--radius-sm);background:var(--surface-2);padding:12px 14px;margin-top:12px}
.agent-block h4{margin:0;font-size:15px}
.agent-block .row{align-items:center;gap:10px;flex-wrap:wrap}
.agent-block form{margin:0}
.agent-block ul{margin:10px 0 0}
.agent-block .actions{margin-top:12px;padding-top:12px}
.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--line);margin-top:14px;padding-top:14px}
.actions form{margin:0}

dialog.modal{border:1px solid var(--line-strong);border-radius:var(--radius);background:var(--surface);color:var(--text);padding:0;width:min(540px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;box-shadow:0 24px 60px rgb(0 0 0 / .55)}
dialog.modal::backdrop{background:var(--overlay)}
dialog.modal:not(:modal){position:static;margin:0 auto 24px}
.modal form{display:block;margin:0;padding:22px}
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

@media(max-width:820px){
  .app-shell{display:block}
  .sidebar{position:relative;width:auto;height:auto;padding:14px 16px 0;border-right:0;border-bottom:1px solid var(--line)}
  .brand{padding:0 2px 13px}.brand small,.sidebar-foot{display:none}
  .sidebar-bottom{position:absolute;top:14px;right:16px;margin:0}.theme-toggle{width:auto}
  .side-nav{display:flex;gap:3px;overflow-x:auto}.side-nav a{flex:0 0 auto;padding:9px 11px;border-radius:9px 9px 0 0}.side-nav a.active{box-shadow:inset 0 -2px var(--accent)}
  main{padding:22px 16px 60px}
  header.top{align-items:start;margin-bottom:20px;padding-bottom:18px}
  .toolbar{align-items:start;flex-direction:column}
  .group-row{grid-template-columns:minmax(0,1fr) auto}.group-agents{display:none}
}
@media(max-width:520px){.instance{display:none}.theme-toggle [data-theme-label]{display:none}.nav-icon{display:none}.grid{grid-template-columns:1fr}.card{padding:16px}.section-head,.detail-title{align-items:flex-start;flex-direction:column}.group-row{padding:13px 14px}.group-state .badge{display:none}}
`;

export const CLIENT_SCRIPT = `"use strict";
// 这个脚本在 <head> 里同步加载：先给 <html> 打上 js 标记，无脚本回退的入口才不会闪一下。
document.documentElement.classList.add("js");

var savedTheme;
try { savedTheme = localStorage.getItem("threadferry-theme"); } catch (_) {}
var theme = savedTheme === "light" || savedTheme === "dark"
  ? savedTheme
  : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
document.documentElement.setAttribute("data-theme", theme);

var openPicker = null;

document.addEventListener("DOMContentLoaded", function () {
  setupThemeToggle();
  setupDialogs();
  each("[data-auth-form]", setupAuthMode);
  each("[data-picker]", attachPicker);
});

function setupThemeToggle() {
  var button = document.querySelector("[data-theme-toggle]");
  if (!button) return;
  var icon = button.querySelector("[data-theme-icon]");
  var label = button.querySelector("[data-theme-label]");
  function update() {
    var dark = document.documentElement.getAttribute("data-theme") === "dark";
    if (icon) icon.textContent = dark ? "☀" : "☾";
    if (label) label.textContent = dark ? "亮色主题" : "暗色主题";
    button.setAttribute("aria-label", dark ? "切换到亮色主题" : "切换到暗色主题");
  }
  button.addEventListener("click", function () {
    var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("threadferry-theme", next); } catch (_) {}
    update();
  });
  update();
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
      ? "/api/users?q=" + encodeURIComponent(value)
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
