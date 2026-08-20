// 管理台的样式表和前端脚本以字符串常量内联在 TS 里：tsc 不会把 .css/.js 资源拷进 dist，
// 而 npm 包只发布 dist/src，所以任何独立资源文件在安装后都会消失。常量则跟着编译产物走。
// 两个文件都由 /admin.css 与 /admin.js 同源提供，CSP 因此只需要放开 'self'，不必 unsafe-inline。

export const STYLESHEET = `:root{
  color-scheme:dark;
  --bg:#0c0e13;
  --surface:#151821;
  --surface-2:#11141c;
  --field:#0f1218;
  --line:#272b36;
  --line-strong:#343a49;
  --text:#e7e9ee;
  --text-strong:#eef1f6;
  --muted:#9ca3af;
  --accent:#3975eb;
  --accent-fill:#2f67d8;
  --link:#8cb4ff;
  --ok:#7ee787;
  --warn:#f2cc60;
  --danger:#ff9aa7;
  --radius:14px;
  --radius-sm:9px;
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  color:var(--text);
  background:var(--bg);
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg)}
main{width:min(1080px,calc(100% - 32px));margin:28px auto 80px}
header.top{display:flex;justify-content:space-between;align-items:end;gap:16px;margin-bottom:18px}
h1{font-size:30px;margin:0}
h2{margin:30px 0 14px;font-size:20px}
h2.flush{margin:0}
h3,h4,p{margin:0 0 10px}
.sub,.muted{color:var(--muted)}
.js .no-js{display:none}

.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:24px}
.tabs a{color:var(--muted);text-decoration:none;padding:10px 14px;border-bottom:2px solid transparent;margin-bottom:-1px;font-weight:650}
.tabs a:hover{color:var(--text)}
.tabs a.active{color:var(--text-strong);border-bottom-color:var(--accent)}

.toolbar{display:flex;justify-content:space-between;align-items:end;gap:16px;margin:0 0 16px}
.toolbar p{margin:6px 0 0}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat{display:block;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;text-decoration:none;color:inherit}
.stat b{display:block;font-size:26px;margin-bottom:2px}
.stat span{color:var(--muted);font-size:13px}

.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:18px}
.row{display:flex;justify-content:space-between;gap:16px;align-items:start}
.badge,.owner{font-size:12px;border-radius:999px;padding:3px 9px;background:#2b3140}
.badge.ok{color:var(--ok)}
.badge.warning{color:var(--warn)}
.owner{color:var(--link);margin-left:8px}
/* 名单一行：姓名是主角，加密 userid 退成次要信息。 */
.person{display:flex;flex-direction:column;gap:2px;min-width:0}
.person b{font-weight:650}
code.faint{color:#7c869e;font-size:12px}
.badge.org{color:#c4b5fd;background:#2c2a45}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;color:#b8c2d9}

form{display:flex;gap:8px;align-items:end;margin-top:14px;flex-wrap:wrap}
label{color:var(--muted)}
input,select,button{font:inherit;border-radius:var(--radius-sm);border:1px solid var(--line-strong);background:var(--field);color:var(--text-strong);padding:9px 11px}
input{min-width:190px;flex:1}
input::placeholder{color:#6b7280}
input:focus-visible,select:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button{cursor:pointer;background:var(--accent-fill);border-color:var(--accent);font-weight:650}
button:hover{background:#3872e6}
button.ghost{background:transparent;border-color:var(--line-strong);color:#cdd5e4}
button.ghost:hover{background:#1b1f2a}
button.danger{background:transparent;border-color:#7f3340;color:var(--danger)}
button.danger:hover{background:#2a161b}
li button.danger{padding:4px 8px}
a.button{display:inline-block;background:var(--accent-fill);border:1px solid var(--accent);border-radius:var(--radius-sm);color:var(--text-strong);padding:9px 14px;text-decoration:none;font-weight:650;white-space:nowrap}
a.button:hover{background:#3872e6}
a.button.ghost{background:transparent;border-color:var(--line-strong);color:#cdd5e4}
a.button.ghost:hover{background:#1b1f2a}

ul{list-style:none;padding:0;margin:8px 0}
li{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid var(--line);padding:9px 0}
li form{margin:0}
ul.links li{border:none;padding:4px 0;justify-content:flex-start;gap:10px}
ul.links a{color:var(--link);text-decoration:none}
ul.links a:hover{text-decoration:underline}

.notice{padding:11px 14px;border-radius:10px;margin:0 0 16px;background:#143321;color:#8de6a9}
.notice.error{background:#3b171d;color:#ffabb4}
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

dialog.modal{border:1px solid var(--line-strong);border-radius:var(--radius);background:var(--surface);color:var(--text);padding:0;width:min(540px,calc(100vw - 32px));box-shadow:0 24px 60px rgb(0 0 0 / .55)}
dialog.modal::backdrop{background:rgb(6 8 12 / .68)}
dialog.modal:not(:modal){position:static;margin:0 auto 24px}
.modal form{display:block;margin:0;padding:22px}
.modal h3{margin:0;font-size:19px}
.modal .lede{margin:6px 0 18px;color:var(--muted);font-size:13.5px}
.modal-actions{display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:22px;padding-top:16px;border-top:1px solid var(--line)}

.fields{display:grid;gap:14px}
.field{display:grid;gap:6px}
.field>span,.field>label{color:var(--muted);font-size:13px}
.field input,.field select{width:100%;min-width:0}
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
.picker-panel{position:fixed;z-index:30;display:flex;flex-direction:column;background:var(--surface-2);border:1px solid var(--line-strong);border-radius:var(--radius-sm);box-shadow:0 18px 40px rgb(0 0 0 / .5);overflow:hidden}
/* 作者样式里的 display 会盖掉 [hidden] 自带的 display:none，收起状态必须自己写回来。 */
.picker-panel[hidden]{display:none}
.picker-head,.picker-foot{flex:0 0 auto;display:flex;gap:10px;align-items:center;justify-content:space-between;padding:8px 10px}
.picker-head{border-bottom:1px solid var(--line)}
.picker-head code{font-size:12.5px}
.picker-foot{border-top:1px solid var(--line);color:var(--muted);font-size:12.5px}
.picker-list{flex:1 1 auto;min-height:0;overflow:auto;padding:5px}
.picker-item{display:flex;width:100%;gap:12px;align-items:baseline;justify-content:space-between;text-align:left;background:transparent;border:0;border-radius:7px;color:var(--text);padding:7px 9px;font-weight:400}
.picker-item:hover,.picker-item.active{background:#1d2331;color:var(--text-strong)}
.picker-label{overflow-wrap:anywhere}
.picker-hint{color:var(--muted);font-size:12.5px;white-space:nowrap}
.picker-empty{margin:6px 9px;color:var(--muted);font-size:13px}
.picker-action{background:transparent;border:1px solid var(--line-strong);color:#cdd5e4;padding:5px 9px;font-size:13px;font-weight:600;white-space:nowrap}
.picker-action:hover{background:#1b1f2a}
.picker-action.primary{background:var(--accent-fill);border-color:var(--accent);color:var(--text-strong)}
.picker-action.primary:hover{background:#3872e6}

@media(max-width:760px){
  header.top{align-items:start;flex-direction:column}
  .toolbar{align-items:start;flex-direction:column}
}
`;

export const CLIENT_SCRIPT = `"use strict";
// 这个脚本在 <head> 里同步加载：先给 <html> 打上 js 标记，无脚本回退的入口才不会闪一下。
document.documentElement.classList.add("js");

var openPicker = null;

document.addEventListener("DOMContentLoaded", function () {
  setupDialogs();
  each("[data-picker]", attachPicker);
});

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
