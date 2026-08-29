//#region src/ui/panel.html?raw
var e = [
	[
		"single",
		"单人",
		"围绕一位角色，建立清晰的关系档案。"
	],
	[
		"multi",
		"多人",
		"记录群像关系与多角色互动。"
	],
	[
		"open_world",
		"大世界",
		"让角色档案连接到更大的世界。"
	],
	[
		"simulator",
		"模拟器",
		"用于测试关系变化与叙事走向。"
	]
];
function t({ formal: t, people: n, settings: r, apiTools: i, loadState: a, initialRelations: o, reviewActions: s, onPluginEnabledChange: c, onClose: l } = {}) {
	let u = document.createElement("div");
	u.id = "qqj-panel-host", u.hidden = !0, u.setAttribute("aria-hidden", "true");
	let d = u.attachShadow({ mode: "open" });
	d.innerHTML = "<style>:host{--panel:#fbfcfe;--panel-2:#f1f4f9;--ink:#23262d;--soft:#6a7079;--faint:#a2a8b2;--line:#23262d1a;--crimson:#b23a48;--u:#3e6b8c;--c:#b0784a;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif;display:block}*{box-sizing:border-box}.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;width:500px;max-width:100vw;animation:.35s both in;overflow:hidden;box-shadow:0 24px 70px #23262d2e,0 4px 14px #23262d12}.topbar{align-items:center;gap:14px;padding:15px 18px 0;display:flex}.brand{align-items:baseline;gap:7px;display:flex}.mark,.tab,.empty h2,.choice strong,.module b{font-family:宋体,Songti SC,SimSun,serif}.mark{letter-spacing:.06em;font-size:17px;font-weight:700}.em{color:var(--crimson)}.sub{color:var(--faint);letter-spacing:.22em;font:10px ui-monospace,monospace}.close{color:var(--soft);cursor:pointer;background:0 0;border:0;width:28px;height:28px;margin-left:auto;font-size:24px;line-height:1}.close:focus-visible,.tab:focus-visible,.choice:focus-visible,.init:focus-visible,.person-action:focus-visible,summary:focus-visible{outline:2px solid var(--crimson);outline-offset:2px}.tabs{border-bottom:1px solid var(--line);gap:2px;margin-top:8px;padding:6px 12px 0 14px;display:flex}.tab{color:var(--faint);cursor:pointer;background:0 0;border:0;padding:8px 12px 12px;font-size:14px;position:relative}.tab.active{color:var(--ink);font-weight:600}.tab.active:after{content:\"\";background:linear-gradient(var(--crimson),transparent);width:2px;height:12px;position:absolute;bottom:-1px;left:50%;transform:translate(-50%)}.body{max-height:74vh;padding:16px 18px 20px;overflow:auto}.status-line{color:var(--soft);align-items:center;gap:7px;min-height:18px;font-size:11px;display:flex}.status-dot{background:var(--faint);border-radius:50%;width:7px;height:7px}.status-dot.ready{background:#5b8c6e}.status-dot.warn{background:var(--crimson)}.status-meta{color:var(--faint);margin-left:auto;font:10px ui-monospace,monospace}.view{padding-top:10px}.empty{text-align:center;border-top:1px solid var(--line);margin-top:8px;padding:30px 8px 24px}.empty h2{margin:5px 0 8px;font-size:19px}.empty p{color:var(--soft);max-width:340px;margin:0 auto;font-size:12px;line-height:1.7}.eyebrow{letter-spacing:.12em;color:var(--crimson);font:10px ui-monospace,monospace}.choices{grid-template-columns:1fr 1fr;gap:8px;margin:20px 0 14px;display:grid}.choice{text-align:left;border:1px solid var(--line);background:var(--panel-2);cursor:pointer;color:var(--ink);border-radius:9px;padding:13px 12px;position:relative}.choice:hover,.choice.selected{background:#b23a480f;border-color:#b23a4873}.choice input{opacity:0;position:absolute}.choice strong{margin-bottom:4px;font-size:14px;display:block}.choice span{color:var(--soft);font-size:10.5px;line-height:1.5;display:block}.init{border:1px solid var(--crimson);background:var(--crimson);color:#fff;cursor:pointer;border-radius:8px;padding:8px 15px;font-size:12px}.init:disabled{opacity:.45;cursor:not-allowed}.people-list{text-align:left;gap:8px;margin-top:18px;display:grid}.people-list h3{color:var(--soft);margin:0 0 2px;font-size:12px;font-weight:600}.person-card{padding:12px 13px}.person-actions{flex-wrap:wrap;gap:6px;margin-top:10px;display:flex}.person-action{border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer;border-radius:7px;padding:5px 9px;font-size:11px}.person-action:hover{color:var(--crimson);border-color:#b23a4873}.shelved-people{text-align:left;border-top:1px solid var(--line);margin-top:18px;padding-top:12px}.shelved-people summary{cursor:pointer;color:var(--soft);font-size:12px}.modules{grid-template-columns:1fr 1fr;gap:9px;margin-top:15px;display:grid}.module{border:1px solid var(--line);background:linear-gradient(#b23a480a,#0000);border-radius:10px;padding:15px 13px}.module b{font-size:14px}.module small{color:var(--faint);margin-top:7px;font-size:10.5px;display:block}.footer{border-top:1px solid var(--line);background:var(--panel-2);align-items:center;gap:12px;padding:11px 18px;display:flex}.legend{color:var(--faint);gap:10px;font-size:10px;display:flex}.legend span{align-items:center;gap:3px;display:inline-flex}.legend i{border-radius:2px;width:7px;height:7px}.u{background:var(--u)}.c{background:var(--c)}.crimson{background:var(--crimson)}.foot-note{color:var(--faint);margin-left:auto;font-size:10px}@keyframes in{0%{opacity:0}to{opacity:1}}@media (width<=540px){.panel{border-radius:14px;min-height:0;box-shadow:0 15px 45px #23262d2e}.body{max-height:none}.choices,.modules{grid-template-columns:1fr}}@media (prefers-reduced-motion:reduce){*,:before,:after{transition-duration:.01ms!important;animation-duration:.01ms!important}}:host{--success:#3f7356;--field:#fff}.settings-btn{width:36px;height:36px;color:var(--soft);cursor:pointer;background:0 0;border:1px solid #0000;border-radius:50%;flex:0 0 36px;margin:-7px -8px -7px 0;font-size:16px;line-height:1}.settings-btn:hover{color:var(--crimson);background:#b23a4812;border-color:#b23a4824}.settings-btn:focus-visible,.open-settings:focus-visible,.settings-view button:focus-visible,.settings-view input:focus-visible,.settings-view select:focus-visible,.settings-view textarea:focus-visible{outline:2px solid var(--crimson);outline-offset:2px}.open-settings{border:1px solid var(--crimson);color:var(--crimson);cursor:pointer;background:0 0;border-radius:8px;margin-top:18px;padding:8px 15px;font-size:12px}.settings-view{text-align:left;padding:10px 2px 4px}.settings-heading{justify-content:space-between;align-items:flex-start;gap:14px;padding:4px 2px 14px;display:flex}.settings-heading h2{margin:4px 0 0;font:700 19px 宋体,Songti SC,SimSun,serif}.master-switch{border:1px solid var(--line);background:var(--panel-2);min-height:36px;color:var(--soft);white-space:nowrap;cursor:pointer;border-radius:18px;align-items:center;gap:7px;padding:7px 10px;font-size:11px;display:flex}.master-switch input,.check-field input{accent-color:var(--crimson)}.api-source-card{background:linear-gradient(105deg,#b23a4814,#3e6b8c09);border:1px solid #b23a482e;border-radius:10px;gap:4px;margin-bottom:14px;padding:13px 14px 13px 17px;display:grid;position:relative}.api-source-card:before{content:\"\";background:var(--crimson);border-radius:0 3px 3px 0;width:3px;position:absolute;top:12px;bottom:12px;left:0}.api-source-card span{color:var(--soft);font-size:10px}.api-source-card strong{font-size:13px}.api-source-card small{color:var(--faint);font-size:10px;line-height:1.5}.settings-section{border:1px solid var(--line);background:var(--panel-2);border-radius:11px;gap:10px;margin-top:14px;padding:14px;display:grid}.section-title{justify-content:space-between;align-items:start;gap:10px;display:flex}.section-title b{font-size:12px;display:block}.section-title small{color:var(--faint);margin-top:3px;font-size:10px;line-height:1.45;display:block}.field{color:var(--soft);gap:5px;font-size:10.5px;display:grid}.field input,.field select,.field textarea{border:1px solid var(--line);background:var(--field);width:100%;min-width:0;color:var(--ink);border-radius:7px;padding:8px 9px;font:12px -apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif}.field textarea{resize:vertical;line-height:1.5}.key-row,.model-row{grid-template-columns:minmax(0,1fr) auto auto;gap:6px;display:grid}.model-row{grid-template-columns:minmax(0,1fr) auto}.key-row button,.model-row button,.preset-actions button,.model-results button,.secondary-action,.primary-action{border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer;border-radius:7px;padding:7px 9px;font-size:10.5px}.preset-actions{flex-wrap:wrap;gap:6px;margin-top:-3px;display:flex}.preset-actions button{padding:5px 8px}.advanced{border-top:1px solid var(--line);padding-top:9px}.advanced summary{cursor:pointer;color:var(--soft);font-size:11px}.advanced[open] summary{margin-bottom:10px}.advanced-row{grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:10px;margin-top:9px;display:grid}.check-field{min-height:34px;color:var(--soft);align-items:center;gap:6px;font-size:11px;display:flex}.settings-actions{grid-template-columns:1fr 1.35fr;gap:8px;margin-top:14px;display:grid}.secondary-action,.primary-action{min-height:36px;font-size:12px}.primary-action{border-color:var(--crimson);background:var(--crimson);color:#fff}.settings-view button:disabled{opacity:.5;cursor:wait}.settings-result{min-height:18px;color:var(--soft);margin:8px 2px 0;font-size:10.5px;line-height:1.5}.settings-result.success{color:var(--success)}.settings-result.error{color:var(--crimson)}.model-results{flex-wrap:wrap;gap:5px;max-height:140px;display:flex;overflow:auto}.model-results[hidden]{display:none}.model-results button{text-overflow:ellipsis;white-space:nowrap;max-width:100%;overflow:hidden}@media (width<=540px){.footer{padding-bottom:max(11px,env(safe-area-inset-bottom,0px))}.legend{display:none}.foot-note{margin-left:auto}.settings-view{padding-bottom:4px}.settings-heading{align-items:center}.settings-section{padding:12px}.advanced-row{grid-template-columns:1fr}.check-field{min-height:auto}.key-row{grid-template-columns:minmax(0,1fr) auto}.key-row [data-action=key-clear]{grid-column:2}.settings-actions{background:linear-gradient(transparent,var(--panel) 30%);padding-top:8px;position:sticky;bottom:0}}.people-page{text-align:left;gap:13px;display:grid}.generation-banner{border:1px solid #b23a4833;border-left:2px solid var(--crimson);background:var(--panel-2);border-radius:0 9px 9px 0;padding:13px 14px 13px 17px;position:relative}.generation-banner h3{margin:0;font:700 14px 宋体,Songti SC,SimSun,serif}.generation-banner p{color:var(--soft);margin:5px 0 0;font-size:11px;line-height:1.6}.generation-banner .generation-hint{color:var(--crimson)}.generation-actions{flex-wrap:wrap;gap:7px;margin-top:10px;display:flex}.generation-actions button{min-height:32px;padding:6px 10px}.generation-banner .source-change-summary{color:var(--ink);font-weight:600}.profile-switcher{overscroll-behavior-inline:contain;scrollbar-width:thin;gap:7px;min-width:0;padding:2px 0 5px;display:flex;overflow-x:auto}.profile-tab{border:1px solid var(--line);background:var(--panel);min-height:34px;color:var(--soft);cursor:pointer;border-radius:8px;flex:none;align-items:center;gap:6px;padding:6px 10px;font-size:11px;display:inline-flex}.profile-tab.active{color:var(--ink);background:#b23a480e;border-color:#b23a4857}.profile-tab:focus-visible,.pending-actions button:focus-visible,.people-pool>summary:focus-visible,.basic-info button:focus-visible,.basic-info input:focus-visible,.basic-info textarea:focus-visible{outline:2px solid var(--crimson);outline-offset:2px}.subject-tag{border-radius:5px;justify-content:center;align-items:center;min-width:22px;height:20px;padding:0 5px;font:700 10px ui-monospace,monospace;display:inline-flex}.tag-u{color:var(--u);background:#3e6b8c1c}.tag-c{color:var(--c);background:#b0784a1f}.dossier-card{border-left:2px solid var(--crimson);gap:11px;padding-left:13px;display:grid}.profile-summary{align-items:flex-start;gap:9px;padding:3px 1px 1px;display:flex}.profile-summary h2{margin:0;font:700 18px 宋体,Songti SC,SimSun,serif}.profile-summary p{color:var(--soft);margin:3px 0 0;font-size:10.5px;line-height:1.5}.profile-layer{border:1px solid var(--line);background:var(--panel);border-radius:9px;padding:12px}.profile-layer.facts{background:#6a707909}.profile-layer.interpretations{background:#3e6b8c09}.profile-layer-head{border-bottom:1px solid var(--line);align-items:baseline;gap:7px;padding-bottom:8px;display:flex}.profile-layer-head h3,.section-heading h3{margin:0;font:700 13px 宋体,Songti SC,SimSun,serif}.profile-layer-head p{color:var(--faint);margin:0;font-size:9.5px;line-height:1.4}.fact-item{border-bottom:1px solid var(--line);padding:9px 0}.fact-item:last-child{border-bottom:0;padding-bottom:1px}.fact-value,.pending-value{color:var(--ink);overflow-wrap:anywhere;margin:0;font-size:12px;line-height:1.65}.fact-source,.fact-target{color:var(--faint);margin:5px 7px 0 0;font:9.5px ui-monospace,monospace;display:inline-block}.fact-target{color:var(--soft)}.layer-empty,.pool-empty{color:var(--soft);margin:9px 0 1px;font-size:11px;line-height:1.6}.pending-section{gap:8px;display:grid}.section-heading{align-items:baseline;gap:7px;display:flex}.section-heading span{color:var(--faint);font-size:9.5px}.pending-card{border:1px solid #b23a482e;border-left:2px solid var(--crimson);background:var(--panel);border-radius:0 9px 9px 0;padding:12px 12px 12px 14px}.pending-reason{color:var(--soft);overflow-wrap:anywhere;margin:6px 0 0;font-size:10.5px;line-height:1.55}.pending-meta{color:var(--faint);flex-wrap:wrap;gap:5px 9px;margin-top:8px;font:9.5px ui-monospace,monospace;display:flex}.pending-actions{gap:7px;margin-top:10px;display:flex}.pending-actions button{min-height:32px;padding:6px 10px}.pending-card[data-busy=true]{opacity:.72}.review-error{margin:0}.people-pool{border-top:1px solid var(--line);padding-top:11px}.people-pool>summary{cursor:pointer;color:var(--soft);font:600 12px 宋体,Songti SC,SimSun,serif}.people-pool[open]>summary{color:var(--ink)}.pool-intro{color:var(--soft);margin:8px 0 0;font-size:10.5px;line-height:1.6}.people-pool .people-list{margin-top:12px}.people-pool .person-card{background:var(--panel-2)}.basic-info{border:1px solid var(--line);background:linear-gradient(145deg,#b0784a0f,#0000);border-radius:9px;gap:11px;padding:12px;display:grid}.basic-info-head{justify-content:space-between;align-items:flex-start;gap:10px;display:flex}.basic-info-head h3{margin:0;font:700 13px 宋体,Songti SC,SimSun,serif}.basic-info-head p{color:var(--soft);margin:4px 0 0;font-size:9.5px;line-height:1.5}.basic-info-actions,.basic-edit-actions{flex-wrap:wrap;gap:6px;display:flex}.basic-info-actions{justify-content:flex-end}.basic-fields,.basic-row{gap:8px;min-width:0;max-width:100%;display:grid}.basic-row-three{grid-template-columns:repeat(3,minmax(0,1fr))}.basic-row-two{grid-template-columns:repeat(2,minmax(0,1fr))}.basic-row-one{grid-template-columns:minmax(0,1fr)}.basic-field{border:1px solid var(--line);background:var(--panel);overflow-wrap:anywhere;border-radius:7px;min-width:0;max-width:100%;padding:8px 9px;overflow:hidden}.basic-label{color:var(--soft);overflow-wrap:anywhere;margin-bottom:4px;font-size:9.5px;display:block}.basic-value{overflow-wrap:anywhere;margin:0;font-size:11.5px;line-height:1.55}.basic-value.missing{color:var(--faint)}.basic-source{color:var(--faint);overflow-wrap:anywhere;margin-top:5px;font-size:9px;line-height:1.4;display:block}.basic-field input,.basic-field textarea{border:1px solid var(--line);background:var(--field);width:100%;min-width:0;max-width:100%;color:var(--ink);border-radius:6px;padding:7px 8px;font:11.5px -apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif;display:block}.basic-field textarea{resize:vertical;min-height:64px;line-height:1.5}.basic-message{color:var(--soft);margin:0;font-size:10.5px;line-height:1.5}.basic-message.success{color:var(--success)}.basic-message.error{color:var(--crimson)}@media (width<=390px){.body{padding-left:14px;padding-right:14px}.dossier-card{padding-left:10px}.profile-layer{padding:10px}.pending-actions,.generation-actions{grid-template-columns:1fr;display:grid}.pending-actions button,.generation-actions button{width:100%}.profile-layer-head,.section-heading{gap:3px;display:grid}.basic-info{padding:10px}.basic-info-head{display:grid}.basic-info-actions,.basic-edit-actions{grid-template-columns:1fr;width:100%;display:grid}.basic-info-actions button,.basic-edit-actions button{width:100%}.basic-fields,.basic-row{gap:5px}.basic-field{padding:7px 6px}.basic-label{font-size:9px}.basic-value,.basic-field input,.basic-field textarea{font-size:10.5px}}:host{position:fixed;inset:0;z-index:1001;width:100dvw;height:100dvh;pointer-events:none;background:transparent}:host([hidden]){display:none!important;pointer-events:none!important}.panel{position:fixed;top:80px;right:20px;width:360px;max-width:calc(100vw - 40px);max-height:85vh;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;pointer-events:auto}.body{min-height:0;max-height:none;overflow-y:auto}.tabs{min-width:0;overflow-x:auto;flex-wrap:nowrap}.tab{flex:0 0 auto}@media(max-width:640px){.panel{top:calc(20px + env(safe-area-inset-top,0px));left:50%;right:auto;bottom:auto;transform:translateX(-50%);width:calc(100dvw - 20px);max-width:calc(100dvw - 20px);height:calc(100dvh - 40px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));max-height:calc(100dvh - 40px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));min-height:0;border-radius:14px}.body{min-height:0;overflow-y:auto}.choices{grid-template-columns:1fr}.tab{padding-left:9px;padding-right:9px}}</style><section class=\"panel\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"qqj-dialog-title\">\n<header class=\"topbar\"><div class=\"brand\"><span class=\"mark\" id=\"qqj-dialog-title\">千<span class=\"em\">千</span>结</span><span class=\"sub\">QIANQIANJIE</span></div><button class=\"icon-btn close\" type=\"button\" aria-label=\"关闭\">×</button></header>\n<nav class=\"tabs\" role=\"tablist\" aria-label=\"档案模块\"><button class=\"tab active\" role=\"tab\" aria-selected=\"true\" data-tab=\"people\">千人</button><button class=\"tab\" role=\"tab\" aria-selected=\"false\" data-tab=\"bonds\">双丝网</button><button class=\"tab\" role=\"tab\" aria-selected=\"false\" data-tab=\"milestones\">千事</button><button class=\"tab\" role=\"tab\" aria-selected=\"false\" data-tab=\"knots\">千结</button></nav>\n<main class=\"body\"><div class=\"status-line\"><span class=\"status-dot\"></span><span class=\"status-label\">正在读取当前聊天</span><span class=\"status-meta\"></span></div><div class=\"view\"></div></main>\n<footer class=\"footer\"><span class=\"legend\"><span><i class=\"u\"></i>你</span><span><i class=\"c\"></i>角色</span><span><i class=\"crimson\"></i>关系档案</span></span><span class=\"source-badge source-formal\">FORMAL</span><span class=\"foot-note\">本地界面 · 正式状态</span><button class=\"settings-btn\" type=\"button\" aria-label=\"打开千千结设置\" title=\"设置\">⚙</button></footer>\n</section>\n";
	let f = d.querySelector(".view"), p = d.querySelector(".status-label"), m = d.querySelector(".status-meta"), h = d.querySelector(".status-dot"), g = { status: "loading" }, _ = null, v = null, y = !1, b = null, x = "people", S = "people", C = "", w = 0, T = 0, E = null, D = !1, O = !1, k = null, A = () => [...d.querySelectorAll("button,input,select,textarea,[href],[tabindex]:not([tabindex=\"-1\"])")].filter((e) => !e.disabled && e.offsetParent !== null), j = () => {
		T += 1, u.hidden = !0, u.setAttribute("aria-hidden", "true");
		let e = b;
		b = null, l?.(), e?.focus?.();
	}, M = (e) => ({
		QQJ_CONFIG: "API 配置不完整，请检查 URL 和 Key。",
		QQJ_TIMEOUT: "连接超时，请检查网络或调高超时时间。",
		QQJ_AUTH: "认证失败，请检查 Key 和模型权限。",
		QQJ_NOT_FOUND: "接口地址不存在，请检查 Base URL。",
		QQJ_RATE_LIMIT: "请求过于频繁，请稍后再试。",
		QQJ_SERVER: "API 服务暂时异常，请稍后再试。",
		QQJ_NETWORK: "无法连接 API，请检查地址和网络。",
		QQJ_EMPTY: "模型没有返回内容，请更换模型或检查配置。",
		QQJ_FORMAT: "模型没有按约定返回测试结果。",
		QQJ_MODELS: "接口没有返回可用模型。",
		QQJ_TAVERN: "当前走酒馆创作预设，无法独立测试；请选择构画或千千结本地 API。",
		QQJ_DISABLED: "千千结已关闭；启用并保存后才能测试连接。"
	})[String(e?.code || "")] || "连接失败，请检查 API 配置后重试。", N = (e, t, n) => {
		let r = document.createElement("option");
		return r.value = t, r.textContent = n, e?.append?.(r), r;
	}, P = () => {
		let e = Number(f.querySelector?.("[data-setting=\"timeout\"]")?.value);
		return {
			url: f.querySelector?.("[data-setting=\"url\"]")?.value?.trim?.() || "",
			key: C,
			model: f.querySelector?.("[data-setting=\"model\"]")?.value?.trim?.() || "",
			excludeParams: f.querySelector?.("[data-setting=\"exclude\"]")?.value || "",
			timeoutSec: e,
			stream: f.querySelector?.("[data-setting=\"stream\"]")?.checked === !0
		};
	}, F = () => {
		let e = f.querySelector?.("[data-setting=\"source\"]")?.value || "auto";
		return e.startsWith("seven:") ? {
			apiMode: "seven-preset",
			selectedSevenDaysPresetId: e.slice(6)
		} : e === "local" ? {
			apiMode: "local",
			selectedSevenDaysPresetId: "",
			localConfig: P()
		} : e === "tavern" ? {
			apiMode: "tavern",
			selectedSevenDaysPresetId: ""
		} : {
			apiMode: "auto",
			selectedSevenDaysPresetId: ""
		};
	}, I = (e, t = "") => {
		let n = f.querySelector?.(".settings-result");
		n && (n.textContent = e, n.className = `settings-result ${t}`.trim());
	}, L = (e) => {
		let t = f.querySelector?.("[data-setting=\"url\"]"), n = f.querySelector?.("[data-setting=\"model\"]"), r = f.querySelector?.("[data-setting=\"exclude\"]"), i = f.querySelector?.("[data-setting=\"timeout\"]"), a = f.querySelector?.("[data-setting=\"stream\"]"), o = f.querySelector?.("[data-setting=\"key\"]");
		t && (t.value = e?.url || ""), n && (n.value = e?.model || ""), r && (r.value = (e?.excludeParams || []).join("\n")), i && (i.value = String(e?.timeoutSec || 180)), a && (a.checked = e?.stream === !0), C = e?.key || "", o && (o.value = "", o.placeholder = C ? "已保存（输入新值可替换）" : "输入 API Key", o.type = "password");
	}, R = () => {
		let e = ++w;
		if (!r?.get) {
			I("设置存储暂不可用。", "error");
			return;
		}
		x = "settings", d.querySelectorAll(".tab").forEach((e) => {
			e.classList.toggle("active", !1), e.setAttribute("aria-selected", "false");
		});
		let t = r.get(), n = r.localConfig(), a = i?.describe?.() || {
			sourceLabel: "尚未解析",
			sevenDaysPresets: []
		};
		p.textContent = "千千结设置", m.textContent = "LOCAL", h.className = `status-dot ${t.pluginEnabled === !1 ? "warn" : "ready"}`, f.innerHTML = "<section class=\"settings-view\"><div class=\"settings-heading\"><div><div class=\"eyebrow\">THREAD CONTROL</div><h2>连接与总开关</h2></div><label class=\"master-switch\"><input data-setting=\"enabled\" type=\"checkbox\"><span>启用千千结</span></label></div><div class=\"api-source-card\"><span>当前请求来源</span><strong class=\"api-source-label\"></strong><small>构画配置只读继承，密钥不会复制到千千结。</small></div><label class=\"field\"><span>API 来源</span><select data-setting=\"source\"></select></label><section class=\"settings-section\"><div class=\"section-title\"><div><b>千千结本地 API</b><small>构画不可用时自动接力，也可手动选择。</small></div></div><label class=\"field\"><span>本地预设</span><select data-setting=\"local-preset\"></select></label><div class=\"preset-actions\"><button type=\"button\" data-action=\"preset-new\">新增</button><button type=\"button\" data-action=\"preset-update\">更新</button><button type=\"button\" data-action=\"preset-rename\">改名</button><button type=\"button\" data-action=\"preset-delete\">删除</button></div><label class=\"field\"><span>Base URL</span><input data-setting=\"url\" type=\"url\" autocomplete=\"off\" placeholder=\"https://api.example.com/v1\"></label><label class=\"field\"><span>API Key</span><span class=\"key-row\"><input data-setting=\"key\" type=\"password\" autocomplete=\"new-password\"><button type=\"button\" data-action=\"key-toggle\" aria-label=\"显示或隐藏 Key\">显示</button><button type=\"button\" data-action=\"key-clear\">清除</button></span></label><label class=\"field\"><span>模型</span><span class=\"model-row\"><input data-setting=\"model\" type=\"text\" autocomplete=\"off\" placeholder=\"gpt-4o-mini\"><button type=\"button\" data-action=\"models\">拉取模型</button></span></label><div class=\"model-results\" hidden></div><details class=\"advanced\"><summary>高级设置</summary><label class=\"field\"><span>剔除参数（每行一个）</span><textarea data-setting=\"exclude\" rows=\"3\" placeholder=\"frequency_penalty\"></textarea></label><div class=\"advanced-row\"><label class=\"field\"><span>超时（5–600 秒）</span><input data-setting=\"timeout\" type=\"number\" min=\"5\" max=\"600\"></label><label class=\"check-field\"><input data-setting=\"stream\" type=\"checkbox\"><span>流式响应</span></label></div></details></section><div class=\"settings-actions\"><button class=\"secondary-action\" type=\"button\" data-action=\"test\">测试连接</button><button class=\"primary-action\" type=\"button\" data-action=\"save\">保存设置</button></div><p class=\"settings-result\" role=\"status\" aria-live=\"polite\"></p></section>";
		let o = f.querySelector("[data-setting=\"enabled\"]");
		o && (o.checked = t.pluginEnabled !== !1);
		let s = f.querySelector(".api-source-label");
		s && (s.textContent = a.sourceLabel);
		let l = f.querySelector("[data-setting=\"source\"]");
		N(l, "auto", "自动继承构画");
		for (let e of a.sevenDaysPresets || []) N(l, `seven:${e.id}`, `构画预设 · ${e.name}`);
		N(l, "local", "千千结本地 API"), N(l, "tavern", "酒馆当前模型"), l && (l.value = t.apiMode === "seven-preset" ? `seven:${t.selectedSevenDaysPresetId}` : t.apiMode || "auto");
		let u = f.querySelector("[data-setting=\"local-preset\"]");
		N(u, "", "当前本地配置");
		for (let e of r.presets()) N(u, e.id, e.name);
		u && (u.value = t.apiPresetActiveId || "");
		let g = r.presets().find((e) => e.id === t.apiPresetActiveId);
		L(g || n);
		let _ = t.pluginEnabled !== !1, v = f.querySelector("[data-action=\"test\"]"), y = f.querySelector("[data-action=\"models\"]");
		v && (v.disabled = !_), y && (y.disabled = !_), u?.addEventListener("change", () => {
			let e = r.presets().find((e) => e.id === u.value);
			L(e || r.localConfig());
		}), f.querySelector("[data-setting=\"key\"]")?.addEventListener("input", (e) => {
			C = e.target.value;
		}), f.querySelector("[data-action=\"key-toggle\"]")?.addEventListener("click", (e) => {
			let t = f.querySelector("[data-setting=\"key\"]");
			t && (t.type === "password" ? (!t.value && C && (t.value = C), t.type = "text", e.currentTarget.textContent = "隐藏") : (C = t.value, t.value = "", t.type = "password", t.placeholder = C ? "已保存（输入新值可替换）" : "输入 API Key", e.currentTarget.textContent = "显示"));
		}), f.querySelector("[data-action=\"key-clear\"]")?.addEventListener("click", () => {
			C = "";
			let e = f.querySelector("[data-setting=\"key\"]");
			e && (e.value = "", e.placeholder = "输入 API Key"), I("保存后会清除千千结本地 Key。");
		}), f.querySelector("[data-action=\"preset-new\"]")?.addEventListener("click", () => {
			let e = globalThis.prompt?.("新预设名称", "新预设")?.trim();
			if (!e) return;
			let t = r.upsertPreset(e, P());
			r.update({ apiPresetActiveId: t }), R(), I(`已新增本地预设「${e}」。`, "success");
		}), f.querySelector("[data-action=\"preset-update\"]")?.addEventListener("click", () => {
			let e = f.querySelector("[data-setting=\"local-preset\"]")?.value, t = r.presets().find((t) => t.id === e);
			if (!t) return I("请先选择要更新的本地预设。", "error");
			r.upsertPreset(t.name, P(), e), R(), I(`已更新本地预设「${t.name}」。`, "success");
		}), f.querySelector("[data-action=\"preset-rename\"]")?.addEventListener("click", () => {
			let e = f.querySelector("[data-setting=\"local-preset\"]")?.value, t = r.presets().find((t) => t.id === e);
			if (!t) return I("请先选择要改名的本地预设。", "error");
			let n = globalThis.prompt?.("新的预设名称", t.name)?.trim();
			n && (r.renamePreset(e, n), R(), I(`已改名为「${n}」。`, "success"));
		}), f.querySelector("[data-action=\"preset-delete\"]")?.addEventListener("click", () => {
			let e = f.querySelector("[data-setting=\"local-preset\"]")?.value, t = r.presets().find((t) => t.id === e);
			if (!t) return I("请先选择要删除的本地预设。", "error");
			globalThis.confirm?.(`删除本地预设「${t.name}」？`) && (r.deletePreset(e), R(), I("本地预设已删除。", "success"));
		}), f.querySelector("[data-action=\"save\"]")?.addEventListener("click", async () => {
			let e = P();
			if (!Number.isInteger(e.timeoutSec) || e.timeoutSec < 5 || e.timeoutSec > 600) return I("超时时间必须是 5–600 秒的整数。", "error");
			let t = F(), n = r.isEnabled();
			r.update({
				...t,
				pluginEnabled: o?.checked !== !1,
				apiUrl: e.url,
				apiKey: e.key,
				apiModel: e.model,
				apiExcludeParams: e.excludeParams,
				apiTimeoutSec: e.timeoutSec,
				apiStream: e.stream,
				apiPresetActiveId: f.querySelector("[data-setting=\"local-preset\"]")?.value || ""
			});
			let i = r.isEnabled();
			n !== i && await c?.(i), R(), I("设置已保存。", "success");
		}), f.querySelector("[data-action=\"test\"]")?.addEventListener("click", async (t) => {
			if (!r.isEnabled()) {
				I("千千结已关闭；启用并保存后才能测试连接。", "error");
				return;
			}
			let n = F();
			t.currentTarget.disabled = !0, I("正在发送不含聊天与人物数据的短测试…");
			try {
				let t = await i?.testConnection?.(n);
				e === w && r.isEnabled() && I(`连接成功 · ${t?.model || "当前模型"}`, "success");
			} catch (t) {
				e === w && r.isEnabled() && I(M(t), "error");
			} finally {
				e === w && r.isEnabled() && (t.currentTarget.disabled = !1);
			}
		}), f.querySelector("[data-action=\"models\"]")?.addEventListener("click", async (t) => {
			if (!r.isEnabled()) {
				I("千千结已关闭；启用并保存后才能读取模型列表。", "error");
				return;
			}
			let n = F();
			t.currentTarget.disabled = !0, I("正在读取模型列表…");
			try {
				let t = await i?.fetchModels?.(n), a = f.querySelector(".model-results");
				if (!a || e !== w || !r.isEnabled()) return;
				a.replaceChildren(), a.hidden = !1;
				for (let e of t || []) {
					let t = document.createElement("button");
					t.type = "button", t.textContent = e, t.addEventListener("click", () => {
						let t = f.querySelector("[data-setting=\"model\"]");
						t && (t.value = e);
					}), a.append(t);
				}
				I(`已读取 ${t?.length || 0} 个模型。`, "success");
			} catch (t) {
				e === w && r.isEnabled() && I(M(t), "error");
			} finally {
				e === w && r.isEnabled() && (t.currentTarget.disabled = !1);
			}
		});
	}, z = () => {
		f.innerHTML = "<div class=\"empty\"><div class=\"eyebrow\">FIRST THREAD</div><h2>先为这段关系选一种形状</h2><p>选择只决定档案的起始方式，之后仍可以在正式数据中继续补充。</p><div class=\"choices\">" + e.map((e) => "<label class=\"choice\"><input type=\"radio\" name=\"qqj-card-type\" value=\"" + e[0] + "\"><strong>" + e[1] + "</strong><span>" + e[2] + "</span></label>").join("") + "</div><button class=\"init\" type=\"button\" disabled>初始化档案</button></div>", f.querySelectorAll("input").forEach((e) => e.addEventListener("change", () => {
			_ = e.value, f.querySelectorAll(".choice").forEach((e) => e.classList.toggle("selected", e.querySelector("input").checked)), f.querySelector(".init").disabled = !1;
		})), f.querySelector(".init").addEventListener("click", async () => {
			if (!(y || !_)) {
				y = !0, f.querySelector(".init").disabled = !0, p.textContent = "正在写入正式档案";
				try {
					Q(await t.initializeCard({ cardType: _ }));
				} catch {
					Q({ status: "error" });
				} finally {
					y = !1;
				}
			}
		});
	}, B = (e, t, n) => {
		let r = document.createElement("button");
		return r.type = "button", r.className = "person-action", r.dataset[t] = n, r.textContent = e, r;
	}, V = (e, t, n) => {
		let r = document.createElement(e);
		return t && (r.className = t), n !== void 0 && (r.textContent = n), r;
	}, H = (e) => {
		e.querySelectorAll("[data-edit]").forEach((e) => e.addEventListener("click", async () => {
			let t = Array.isArray(g.people?.confirmed) ? g.people.confirmed : [], r = globalThis.prompt?.("新的显示名", t.find((t) => t.identityId === e.dataset.edit)?.displayName ?? "");
			r?.trim() && n?.editDisplayName && await $(() => n.editDisplayName({
				identityId: e.dataset.edit,
				displayName: r
			}));
		})), e.querySelectorAll("[data-select]").forEach((e) => e.addEventListener("click", () => $(() => n.select({ identityId: e.dataset.select })))), e.querySelectorAll("[data-unselect]").forEach((e) => e.addEventListener("click", () => $(() => n.unselect({ identityId: e.dataset.unselect })))), e.querySelectorAll("[data-shelve]").forEach((e) => e.addEventListener("click", async () => {
			globalThis.confirm?.("搁置后人物会从主列表隐藏，但可随时恢复。继续吗？") && n?.shelve && await $(() => n.shelve({ identityId: e.dataset.shelve }));
		})), e.querySelectorAll("[data-restore]").forEach((e) => e.addEventListener("click", () => $(() => n.restore({ identityId: e.dataset.restore }))));
	}, U = (e) => {
		let t = Array.isArray(g.people?.confirmed) ? g.people.confirmed : [], n = Array.isArray(g.people?.candidate) ? g.people.candidate : [], r = Array.isArray(g.people?.shelved) ? g.people.shelved : [], i = Array.isArray(g.people?.warnings) ? g.people.warnings : [], a = i.some((e) => String(e?.code || "").startsWith("NORMALIZATION_")), o = i.some((e) => !String(e?.code || "").startsWith("NORMALIZATION_"));
		if (o && e.append(V("p", "error", "部分原设来源当前不可用，已按其余来源继续。")), a && e.append(V("p", "error", "部分人物格式已自动修正或跳过。")), g.peopleError && e.append(V("p", "error", g.peopleError)), t.length) {
			let n = document.createElement("section");
			n.className = "people-list";
			let r = document.createElement("h3");
			r.textContent = "明确人物", n.append(r), t.forEach((e) => {
				let t = document.createElement("article");
				t.className = "module person-card";
				let r = document.createElement("b");
				r.textContent = e.displayName ?? "";
				let i = e.selection?.status === "selected", a = document.createElement("small");
				a.textContent = i ? "当前关注 · 不代表已经恋爱" : "尚未选择 · 人物仍会长期保留";
				let o = document.createElement("div");
				o.className = "person-actions", o.append(B(i ? "取消选择" : "选择", i ? "unselect" : "select", e.identityId), B("改名", "edit", e.identityId), B("搁置", "shelve", e.identityId)), t.append(r, a, o), n.append(t);
			}), e.append(n);
		} else !o && !g.peopleError && e.append(V("p", "pool-empty", "当前来源尚未登记明确人物。"));
		if (n.length) {
			let t = document.createElement("section");
			t.className = "people-list";
			let r = document.createElement("h3");
			r.textContent = "待判断人物", t.append(r), n.forEach((e) => {
				let n = document.createElement("article");
				n.className = "module person-card";
				let r = document.createElement("b");
				r.textContent = e.name ?? "";
				let i = document.createElement("small");
				i.textContent = "身份或重要性仍需判断 · 未选择", n.append(r, i), t.append(n);
			}), e.append(t);
		}
		if (r.length) {
			let t = document.createElement("details");
			t.className = "shelved-people";
			let n = document.createElement("summary");
			n.textContent = `已搁置人物（${r.length}）`, t.append(n);
			let i = document.createElement("div");
			i.className = "people-list", r.forEach((e) => {
				let t = document.createElement("article");
				t.className = "module person-card";
				let n = document.createElement("b");
				n.textContent = e.displayName ?? "";
				let r = document.createElement("small");
				r.textContent = "已保留身份、改名和用户事实";
				let a = document.createElement("div");
				a.className = "person-actions", a.append(B("恢复", "restore", e.identityId)), t.append(n, r, a), i.append(t);
			}), t.append(i), e.append(t);
		}
		H(e);
	}, W = (e) => ({
		uninitialized: ["生成首次档案", "读取当前 Persona、已选择人物、作者设定与稳定聊天，整理出有来源的关系档案。"],
		generating: ["正在整理人物与关系", "正在生成首次档案；人物骨架和已保存内容不会被清空。"],
		applying: ["正在保存关系档案", "正在把已生成内容安全写入人物档案；继续时不会重复调用 AI。"],
		cancelled: ["已停止", "人物骨架和已保存进度都还在，可以稍后继续。"],
		failed_retryable: ["这次没有生成完成", "已有档案保持原样，可以重新尝试。"],
		storage_error: ["保存暂时失败", "已保存的部分仍在，可以重新加载后继续。"],
		conflict: ["档案刚刚发生变化", "请重新加载最新档案，再决定下一步。"],
		stale: ["当前页面已经过期", "聊天、Persona 或来源发生了变化，请重新加载。"],
		blocked_source_changed: ["作者来源已经变化", "可采用当前开场白与激活世界书；重新读取状态本身不会更新作者来源。"],
		adopted_sources: ["作者来源已更新", "当前开场白与世界书已经重新锚定；确认无误后，可生成首次档案。"],
		adopting_sources: ["正在采用当前作者来源", "正在重新锚定当前开场白与激活世界书，不会调用 AI。"],
		requires_rebuild: ["已有首次档案", "当前档案已经写入首次内容，不能直接换来源；需要另行重算。"],
		input_too_large: ["当前材料太长", "本次没有截断或生成内容；请先缩小来源范围。"],
		mismatch: ["身份需要确认", "当前聊天、角色或 Persona 与档案绑定不一致，本页保持只读。"],
		future_schema_readonly: ["档案来自更新版本", "当前版本只读显示，不会覆盖数据。"]
	})[e] || ["首次档案尚未完成", "重新加载后再试。"], G = (e) => {
		let t = [...new Set((Array.isArray(e?.sourceRefs) ? e.sourceRefs : []).map((e) => ({
			persona: "Persona",
			card: "角色卡",
			greeting: "开场白",
			worldbook: "世界书",
			chat: "稳定聊天"
		})[e?.kind]).filter(Boolean))];
		return t.length ? t.join(" · ") : "来源未标注";
	}, K = (e, t) => e?.relationToIdentityId && t.has(e.relationToIdentityId) ? `关系对象：${t.get(e.relationToIdentityId)}` : "", q = (e, t, n, r, i, { initialGenerated: a = !0, canonCount: o = null } = {}) => {
		let s = V("section", `profile-layer ${t === "sourceFacts" ? "facts" : "interpretations"}`), c = V("div", "profile-layer-head");
		c.append(V("h3", "", n), V("p", "", r)), s.append(c);
		let l = Array.isArray(e?.[t]) ? e[t] : [];
		l.length || s.append(V("p", "layer-empty", a ? t === "sourceFacts" ? "当前作者来源没有可展示的明确事实。" : o === 0 ? "当前没有稳定聊天可供归纳。" : "当前稳定聊天没有可展示的 AI 归纳。" : "首次档案尚未生成。"));
		for (let e of l) {
			let t = V("article", "fact-item");
			t.append(V("p", "fact-value", e?.value ?? ""), V("span", "fact-source", G(e)));
			let n = K(e, i);
			n && t.append(V("span", "fact-target", n)), s.append(t);
		}
		return s;
	}, J = async (e) => {
		if (y || !o?.[e]) return;
		y = !0, E = e === "resume" ? "applying" : e === "adoptCurrentSources" ? "adopting_sources" : "generating";
		let t = ++T;
		Z();
		try {
			if (await o[e](), t !== T || u.hidden) return;
			E = null, y = !1, await a?.();
		} finally {
			t === T && (y = !1, E && (E = null, Z()));
		}
	}, ee = () => {
		o?.cancel && (T += 1, o.cancel(), y = !1, E = "cancelled", Z());
	}, Y = async (e, t, n, r, i) => {
		if (r.dataset.busy === "true" || !s?.resolvePendingReview || !s?.itemDigest) return;
		r.dataset.busy = "true", r.querySelectorAll("button").forEach((e) => {
			e.disabled = !0;
		});
		let o = ++T;
		try {
			let r = await s.itemDigest(t), c = await s.resolvePendingReview({
				identityId: e.identityId,
				pendingItemId: t.id,
				decision: n,
				expectedItemDigest: r
			});
			if (o !== T || u.hidden || (await a?.(), u.hidden)) return;
			c?.status !== "ready" && (g = {
				...g,
				reviewError: c?.status === "conflict" ? "这条建议已经变化，请重新加载后再处理。" : "当前档案已变化，本次没有操作。"
			}, Z()), (d.querySelector(".profile-tab.active") || i)?.focus?.();
		} catch {
			o === T && (g = {
				...g,
				reviewError: "当前无法处理这条建议，原档案保持不变。"
			}, Z());
		}
	}, te = (e, t) => {
		let n = V("section", "pending-section"), r = V("div", "section-heading");
		r.append(V("h3", "", "需要确认"), V("span", "", "只在你确认后加入正式档案")), n.append(r);
		let i = Array.isArray(e?.pendingReview) ? e.pendingReview : [];
		i.length || n.append(V("p", "layer-empty", "当前没有需要你确认的内容。"));
		for (let r of i) {
			let i = V("article", "pending-card");
			i.append(V("p", "pending-value", r?.value ?? ""), V("p", "pending-reason", r?.reason ? `为什么需要确认：${r.reason}` : "这条内容需要你判断。"));
			let a = V("div", "pending-meta");
			a.append(V("span", "", r?.proposedLayer === "sourceFacts" ? "拟加入：来源事实" : "拟加入：AI 归纳"), V("span", "", G(r)));
			let o = K(r, t);
			o && a.append(V("span", "", o)), i.append(a);
			let s = V("div", "pending-actions"), c = V("button", "primary-action", "确认加入"), l = V("button", "secondary-action", "拒绝");
			c.type = l.type = "button", s.append(c, l), i.append(s), n.append(i), c.addEventListener("click", () => Y(e, r, "accept", i, n)), l.addEventListener("click", () => Y(e, r, "reject", i, n));
		}
		return n;
	}, X = [
		["name", "姓名"],
		["gender", "性别"],
		["age", "年龄"],
		["appearance", "外貌"],
		["personality", "性格"],
		["identity", "身份"],
		["nsfwPreferences", "NSFW 喜好"],
		["abilities", "能力"],
		["likes", "喜好"],
		["dislikes", "厌恶"],
		["principles", "原则"],
		["relationships", "人际关系"]
	], ne = [
		[
			"name",
			"gender",
			"age"
		],
		[
			"appearance",
			"personality",
			"identity"
		],
		[
			"abilities",
			"principles",
			"nsfwPreferences"
		],
		["likes", "dislikes"],
		["relationships"]
	], re = async (e) => {
		if (y || O || !o?.extractBasicInfo) return;
		O = !0, k = {
			kind: "",
			text: "正在提取基础信息…"
		}, Z();
		let t = ++T;
		try {
			let n = await o.extractBasicInfo({ identityId: e.identityId });
			if (t !== T || u.hidden) return;
			if (n?.status === "ready") {
				let e = Number(n.acceptedFields) || 0, t = Number(n.rejectedFields) || 0;
				k = e === 0 && t > 0 ? {
					kind: "error",
					text: `AI 返回了 ${t} 项，但格式未能采用；原有基础信息保持不变。`
				} : {
					kind: "success",
					text: n.emptyResult ? "提取完成，没有发现可可靠填写的新信息。" : `提取完成，采用了 ${e} 项。`
				}, O = !1, await a?.();
			} else k = {
				kind: "error",
				text: n?.status === "conflict" ? "档案刚刚发生变化，请重新加载后再试。" : n?.status === "no_selected_character" ? "当前没有已选择人物，请先到人物池选择 C。" : "提取失败，原有基础信息保持不变。"
			};
		} catch {
			t === T && (k = {
				kind: "error",
				text: "提取失败，原有基础信息保持不变。"
			});
		} finally {
			t === T && (O = !1, Z());
		}
	}, ie = async (e, t, r) => {
		if (y || O) return;
		let i = new Map([...r.querySelectorAll("[data-basic-field]")].map((e) => [e.dataset.basicField, e]));
		O = !0, k = {
			kind: "",
			text: "正在保存基础信息…"
		}, Z();
		let s = ++T;
		try {
			let r = i.get("name")?.value?.trim?.() || "";
			if (!r) throw Error("姓名不能为空");
			if (r !== t) {
				let t = await n?.editDisplayName?.({
					identityId: e.identityId,
					displayName: r
				});
				if (t?.status === "conflict" || t?.status === "future_schema_readonly") throw Error("姓名保存冲突");
			}
			for (let [t] of X.slice(1)) {
				let n = i.get(t)?.value ?? "", r = e.basicFields?.[t]?.value ?? "";
				if (String(n).replace(/\r\n?/g, "\n").trim() !== String(r).replace(/\r\n?/g, "\n").trim() && (await o?.saveBasicField?.({
					identityId: e.identityId,
					field: t,
					value: n
				}))?.status !== "ready") throw Error("字段保存冲突");
			}
			if (s !== T || u.hidden) return;
			D = !1, k = {
				kind: "success",
				text: "基础信息已保存；用户填写内容不会被重新提取覆盖。"
			}, O = !1, await a?.();
		} catch (e) {
			s === T && (k = {
				kind: "error",
				text: e?.message === "姓名不能为空" ? "姓名不能为空。" : "保存未全部完成；部分已成功字段可能已保存，请重新加载确认。"
			});
		} finally {
			s === T && (O = !1, Z());
		}
	}, ae = (e, t) => {
		let n = V("section", "basic-info"), r = V("div", "basic-info-head"), i = V("div");
		i.append(V("h3", "", "基础信息"), V("p", "", "只记录稳定且有依据的角色信息；缺失不会猜测。")), r.append(i);
		let a = V("div", "basic-info-actions");
		if (!D) {
			let t = Object.values(e.basicFields || {}).some((e) => e?.value), n = V("button", "secondary-action", O ? "正在提取…" : t ? "重新提取" : "提取基础信息");
			n.type = "button", n.disabled = O, n.addEventListener("click", () => re(e));
			let r = V("button", "secondary-action", "编辑");
			r.type = "button", r.disabled = O, r.addEventListener("click", () => {
				D = !0, k = null, Z();
			}), a.append(n, r);
		}
		r.append(a), n.append(r);
		let o = V("div", "basic-fields"), s = ([n, r]) => {
			let i = V("div", "basic-field");
			i.append(V("span", "basic-label", r));
			let a = n === "name" ? t : e.basicFields?.[n]?.value;
			if (D) {
				let e = document.createElement(n === "name" || ["gender", "age"].includes(n) ? "input" : "textarea");
				e.dataset.basicField = n, e.value = a || "", e.maxLength = n === "name" ? 120 : 2400, e.setAttribute("aria-label", r), i.append(e);
			} else i.append(V("p", `basic-value ${a ? "" : "missing"}`.trim(), a || "未提及")), n !== "name" && a && i.append(V("small", "basic-source", e.basicFields?.[n]?.provenance === "user" ? "用户填写" : G(e.basicFields?.[n])));
			return i;
		}, c = new Map(X.map((e) => [e[0], e]));
		for (let e of ne) {
			let t = e.length === 3 ? "basic-row-three" : e.length === 2 ? "basic-row-two basic-preference-row" : "basic-row-one basic-relationships-row", n = V("div", `basic-row ${t}`);
			for (let t of e) n.append(s(c.get(t)));
			o.append(n);
		}
		if (n.append(o), D) {
			let r = V("div", "basic-edit-actions"), i = V("button", "primary-action", O ? "正在保存…" : "保存基础信息"), a = V("button", "secondary-action", "取消");
			i.type = a.type = "button", i.disabled = a.disabled = O, i.addEventListener("click", () => ie(e, t, n)), a.addEventListener("click", () => {
				D = !1, k = null, Z();
			}), r.append(i, a), n.append(r);
		}
		return k && n.append(V("p", `basic-message ${k.kind}`.trim(), k.text)), n;
	}, oe = (e, t) => {
		let n = g.initialRelations || g.peopleFoundation?.state?.initialGeneration || {
			status: "uninitialized",
			completedMemberIds: []
		}, r = n.lastAttempt || g.peopleFoundation?.state?.lastAttempt, i = r?.action === "adopt_current_sources" && r?.status === "ready", o = E || (i && ["blocked_source_changed", "uninitialized"].includes(n.status) ? "adopted_sources" : n.status) || "uninitialized", s = new Set(n.completedMemberIds || []), c = e.some((e) => !s.has(e)), l = r?.emptyResult === !0;
		if (o === "ready" && !c && !l) return null;
		let u = V("section", "generation-banner");
		u.setAttribute("aria-live", "polite"), u.setAttribute("aria-busy", String(["generating", "applying"].includes(o)));
		let [d, f] = o === "ready" && !c && l ? ["首次整理已完成", "没有可靠结果；人物骨架和用户内容保持不变。"] : o === "ready" && c ? ["有新人物等待补充", "只会为尚未完成的已选择人物生成首次档案。"] : W(o);
		if (u.append(V("h3", "", d), V("p", "", f)), n.status === "blocked_source_changed" && r?.sourceDiagnostics) {
			let e = r.sourceDiagnostics, t = e.greeting === "changed" ? "开场白已变化" : e.greeting === "unavailable" ? "开场白暂时无法读取" : "开场白未变化", n = Number(e.worldbookUnreadable) || 0, i = n > 0 ? `，暂时无法读取 ${n} 条` : "";
			u.append(V("p", "source-change-summary", `${t}；世界书 ${Number(e.worldbookChanged) || 0} 条变化，${Number(e.worldbookMissing) || 0} 条缺失${i}。`));
		}
		let p = V("div", "generation-actions");
		if (["generating", "applying"].includes(o)) {
			let e = V("button", "secondary-action", "停止，稍后继续");
			e.type = "button", e.addEventListener("click", ee), p.append(e);
		} else if (o === "blocked_source_changed") {
			let e = V("button", "primary-action", "采用当前作者来源");
			e.type = "button", e.disabled = y, e.addEventListener("click", () => J("adoptCurrentSources")), p.append(e);
		} else if (!(o === "ready" && !c) && ![
			"mismatch",
			"future_schema_readonly",
			"input_too_large",
			"requires_rebuild"
		].includes(o)) {
			let e = V("button", "primary-action", o === "ready" && c ? "为新人物补充档案" : o === "cancelled" ? "继续整理档案" : "生成首次档案");
			e.type = "button", e.disabled = y, e.addEventListener("click", () => J(n.status === "applying" ? "resume" : "start")), p.append(e);
		}
		if (!["generating", "applying"].includes(o)) {
			let e = V("button", "secondary-action", o === "blocked_source_changed" ? "重新读取状态" : "重新加载");
			e.type = "button", e.addEventListener("click", () => a?.({ announceLoading: !0 })), p.append(e);
		}
		return !t && o === "uninitialized" && u.append(V("p", "generation-hint", "还没有选择 C；可以先到“管理人物池”选择人物。")), (p.children?.length || p.childNodes?.length) && u.append(p), u;
	}, Z = () => {
		f.replaceChildren();
		let e = g.peopleFoundation;
		if (e?.status !== "ready" || !Array.isArray(e.profiles)) {
			let e = V("div", "empty");
			e.append(V("div", "eyebrow", "PEOPLE / POOL"), V("h2", "", "先管理当前人物"), V("p", "", "选择只表示你当前想关注这位人物，不代表已经恋爱或发生关系。关系档案骨架尚未就绪时，人物池仍可查看和管理。")), U(e), f.append(e);
			return;
		}
		let t = (Array.isArray(g.people?.confirmed) ? g.people.confirmed : []).filter((e) => e.selection?.status === "selected"), n = new Set(t.map((e) => e.identityId)), r = new Map(t.map((e) => [e.identityId, e.displayName || "未命名人物"])), i = [...n], a = e.profiles.filter((e) => e.subject === "character" && n.has(e.identityId)), o = new Map(a.map((e) => [e.identityId, e]));
		(!v || !o.has(v)) && (v = a[0]?.identityId || null);
		let s = o.get(v), c = g.initialRelations || e.state?.initialGeneration || {
			status: "uninitialized",
			completedMemberIds: []
		}, l = new Set(c.completedMemberIds || []), u = Number.isInteger(c.lastAttempt?.canonCount) ? c.lastAttempt.canonCount : Number.isInteger(e.state?.lastAttempt?.canonCount) ? e.state.lastAttempt.canonCount : Number.isInteger(e.state?.canonRef?.canonLength) ? e.state.canonRef.canonLength : null, d = new Map([[e.state?.personaId, "我"], ...a.map((e) => [e.identityId, r.get(e.identityId) || e.displayName || "未命名人物"])]), p = V("div", "people-page"), m = oe(i, a.length > 0);
		m && p.append(m);
		let h = V("div", "profile-switcher");
		h.setAttribute("role", "tablist"), h.setAttribute("aria-label", "切换人物档案");
		for (let e of a) {
			let t = V("button", `profile-tab ${e.identityId === v ? "active" : ""}`.trim());
			t.type = "button", t.setAttribute("role", "tab"), t.setAttribute("aria-selected", String(e.identityId === v)), t.append(V("span", "subject-tag tag-c", "C"), V("span", "", d.get(e.identityId))), t.addEventListener("click", () => {
				v = e.identityId, D = !1, k = null, Z();
			}), h.append(t);
		}
		if (p.append(h), !s) p.append(V("p", "layer-empty", "还没有已选择的 C。请展开“管理人物池”并选择一位人物。"));
		else {
			let e = V("section", "dossier-card"), t = V("header", "profile-summary");
			t.append(V("span", "subject-tag tag-c", "C"));
			let n = V("div");
			n.append(V("h2", "", d.get(s.identityId)), V("p", "", "当前已选择人物的稳定关系档案")), t.append(n), e.append(t), e.append(ae(s, d.get(s.identityId)));
			let r = {
				initialGenerated: l.has(s.identityId),
				canonCount: u
			};
			e.append(q(s, "sourceFacts", "来源事实", "来自 Persona、角色卡、开场白或世界书的明确内容", d, r)), e.append(q(s, "interpretations", "AI 归纳", "只根据稳定聊天整理，不覆盖来源事实", d, r)), g.reviewError && e.append(V("p", "error review-error", g.reviewError)), e.append(te(s, d)), p.append(e);
		}
		let _ = V("details", "people-pool"), y = V("summary", "", "管理人物池");
		_.append(y);
		let b = V("p", "pool-intro", "选择、取消选择、改名、搁置或恢复人物。这里的选择只表示当前关注，不代表关系已经成立。");
		_.append(b), U(_), p.append(_), f.append(p);
	}, se = () => {
		let e = {
			bonds: "双丝网",
			milestones: "千事",
			knots: "千结"
		}, t = V("div", "empty");
		t.append(V("div", "eyebrow", "COMING LATER"), V("h2", "", e[S] || "此模块"), V("p", "", "尚未接入业务数据。本次只完成千人关系档案。")), f.replaceChildren(t);
	}, Q = (e) => {
		if (E === "cancelled" && e?.status === "stale" && ["ready", "route_ready"].includes(g?.status)) {
			y = !1, Z();
			return;
		}
		if (T += 1, y = !1, E = null, g = e || { status: "error" }, x === "settings") return;
		if (S !== "people") return se();
		let t = g.status, n = ["ready", "route_ready"].includes(t) && g.peopleRecognitionFailed, r = Array.isArray(g.people?.warnings) && g.people.warnings.some((e) => String(e?.code || "").startsWith("NORMALIZATION_"));
		if (p.textContent = n ? "人物识别失败，已保留旧列表" : {
			disabled: "千千结已关闭",
			loading: "正在读取当前聊天",
			reading_sources: "正在读取路线来源",
			waiting_ai: "正在等待 AI 识别",
			saving_people: "正在写入人物档案",
			preparing: "正在恢复档案",
			renaming: "正在恢复人物改名",
			awaiting_card_type: "档案尚未初始化",
			migrated: "档案已迁移，等待选择类型",
			route_ready: "来源已锚定，正式档案已就绪",
			ready: "来源已锚定，正式档案已就绪",
			route_unavailable: "路线来源扫描不可用",
			route_mismatch: "路线来源发生变化，需要处理",
			mismatch: "当前身份或路线不一致",
			offline: "暂时无法连接正式存储",
			stopped: "当前聊天暂不可用",
			error: "正式状态读取失败",
			conflict: "档案发生冲突"
		}[t] || t, m.textContent = t === "route_unavailable" ? [
			"GREETING_INVALID",
			"SCANNER_UNAVAILABLE",
			"SCAN_FAILED",
			"SCAN_RESULT_INVALID",
			"ENTRY_INVALID",
			"ROUTE_INVALID",
			"UNKNOWN"
		].includes(g.diagnosticCode) ? g.diagnosticCode : "UNKNOWN" : g.cardType || "", h.className = "status-dot " + (n || r || [
			"disabled",
			"mismatch",
			"route_mismatch",
			"route_unavailable",
			"error",
			"conflict"
		].includes(t) ? "warn" : ["ready", "route_ready"].includes(t) ? "ready" : ""), t === "awaiting_card_type" || t === "migrated") return z();
		if (["ready", "route_ready"].includes(t)) return Z();
		let i = t === "disabled" ? ["千千结现在是关闭的", "不会读取聊天、扫描来源、调用 AI 或写入档案。已有数据保持原样。"] : t === "route_mismatch" ? ["路线来源需要确认", "当前路线已锁定，来源诊断仅作提示，不影响人物识别。"] : t === "route_unavailable" ? ["来源扫描不可用", "当前世界书无法进行安全的 dry-run 扫描，请稍后重试。"] : t === "mismatch" ? ["身份需要确认", "当前角色、Persona 或正式档案绑定不一致。为保护已有数据，本次只读。"] : t === "offline" ? ["暂时离线", "正式存储暂时不可用，恢复连接后可重新打开。"] : t === "stopped" ? ["还没有可用聊天", "请先打开一个单人聊天，再打开千千结。"] : t === "preparing" ? ["正在恢复档案", "请稍候，档案恢复完成前不能操作人物。"] : t === "renaming" ? ["正在恢复人物改名", "上次改名尚未完成，正在核对人物档案与列表。"] : ["正在准备档案", "正式状态尚未就绪，请稍后重试。"], a = V("div", "empty");
		if (a.append(V("div", "eyebrow", "QIANQIANJIE"), V("h2", "", i[0]), V("p", "", i[1])), t === "disabled") {
			let e = V("button", "open-settings", "打开设置");
			e.type = "button", e.addEventListener("click", R), a.append(e);
		}
		f.replaceChildren(a);
	}, $ = async (e) => {
		if (!y) {
			y = !0;
			try {
				let t = await e();
				if (t?.status === "conflict" || t?.status === "error") {
					Q({
						...g,
						status: ["ready", "route_ready"].includes(g.status) ? g.status : t.status,
						people: g.people,
						peopleError: "档案发生冲突，请稍后重试"
					});
					return;
				}
				if (typeof a == "function") {
					await a();
					return;
				}
				let r = n?.getPeople ? await n.getPeople() : t;
				Q(g.peopleRecognitionFailed ? {
					...g,
					people: r
				} : {
					...g,
					people: r,
					peopleError: null
				});
			} catch {
				Q({
					...g,
					status: ["ready", "route_ready"].includes(g.status) ? g.status : "error",
					people: g.people,
					peopleError: "操作失败，原人物列表已保留"
				});
			} finally {
				y = !1;
			}
		}
	};
	return d.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			e.preventDefault(), j();
			return;
		}
		if (e.key !== "Tab") return;
		let t = A();
		if (!t.length) return;
		let n = t[0], r = t[t.length - 1];
		e.shiftKey && d.activeElement === n ? (e.preventDefault(), r.focus()) : !e.shiftKey && d.activeElement === r && (e.preventDefault(), n.focus());
	}), d.querySelector(".close").addEventListener("click", j), d.querySelector(".settings-btn")?.addEventListener("click", () => {
		x === "settings" ? (w += 1, x = "people", S = "people", d.querySelectorAll(".tab").forEach((e, t) => {
			e.classList.toggle("active", t === 0), e.setAttribute("aria-selected", String(t === 0));
		}), Q(g)) : R();
	}), d.querySelectorAll(".tab").forEach((e) => e.addEventListener("click", () => {
		w += 1, x = "people", S = e.dataset.tab || "people", d.querySelectorAll(".tab").forEach((t) => {
			let n = t === e;
			t.classList.toggle("active", n), t.setAttribute("aria-selected", String(n));
		}), Q(g);
	})), Q(g), {
		host: u,
		root: d,
		show: (e = document.activeElement) => {
			b = e, u.hidden = !1, u.setAttribute("aria-hidden", "false"), d.querySelector(".close").focus();
		},
		close: j,
		setState: Q,
		showSettings: R,
		getState: () => ({ ...g })
	};
}
//#endregion
//#region src/ui/fab.js
var n = "qqj-fab-pos", r = 36, i = () => globalThis.innerWidth <= 540 || globalThis.matchMedia?.("(max-width: 540px)").matches, a = () => ({
	width: Number(globalThis.innerWidth) || 0,
	height: Number(globalThis.innerHeight) || 0
}), o = (e, t) => Math.max(0, Math.min(Math.max(0, t - r), e));
function s({ onClick: e } = {}) {
	let t = document.createElement("div");
	t.id = "qqj-fab-host", t.attachShadow({ mode: "open" });
	let r = t.shadowRoot;
	r.innerHTML = "<style>:host{position:fixed;right:16px;top:calc(100dvh - 80px - 44px);z-index:1000;touch-action:none}button{width:36px;height:36px;border:0;border-radius:50%;background:#B23A48;color:#fff;cursor:pointer;box-shadow:0 7px 18px rgba(178,58,72,.32);touch-action:none;display:grid;place-items:center;padding:4px}button:focus-visible{outline:2px solid #23262D;outline-offset:3px}svg{width:28px;height:28px;display:block}@media(max-width:540px){:host{right:14px}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}</style><button type=\"button\" aria-label=\"打开千千结\"><svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" width=\"64\" height=\"64\" fill=\"none\"><circle cx=\"32\" cy=\"32\" r=\"25\" stroke=\"currentColor\" stroke-width=\"0.9\"/><g stroke=\"currentColor\" stroke-width=\"0.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M 30.72 28.58 C 27.3 26.5, 24.5 25.3, 20.46 25.38 C 17.2 25.45, 15.53 28.1, 15.55 31.36 C 15.57 35.1, 17.6 37.8, 19.82 39.05 C 21.5 40.0, 23.4 39.9, 24.74 39.48 L 40.12 30.29\"/><path d=\"M 32.85 36.06 C 35.6 37.7, 37.8 39.2, 38.84 39.48 C 42.8 40.6, 46.0 38.3, 47.60 34.99 C 49.0 31.8, 47.6 28.5, 44.61 26.02 C 42.7 24.5, 39.2 24.7, 36.91 26.02 L 27.94 31.57\"/><path d=\"M 23.45 30.29 L 30.72 34.56\"/><path d=\"M 26.02 33.07 L 23.67 34.35\"/><path d=\"M 35.63 31.57 L 32.85 30.08\"/><path d=\"M 37.34 33.07 L 39.91 34.35\"/></g></svg></button>";
	let s = r.querySelector("button"), c = null, l = !1, u = null, d = () => {
		t.style.left = "", t.style.top = "calc(100dvh - 80px - 44px)", t.style.right = i() ? "14px" : "16px";
	}, f = () => {
		if (i()) return null;
		try {
			let e = JSON.parse(globalThis.localStorage?.getItem(n) || "null");
			return Number.isFinite(e?.x) && Number.isFinite(e?.y) ? e : null;
		} catch {
			return null;
		}
	}, p = (e) => {
		let n = a();
		if (!n.width || !n.height || !e) return;
		let r = o(e.x, n.width), i = o(e.y, n.height);
		t.style.left = `${r}px`, t.style.top = `${i}px`, t.style.right = "auto", u = {
			x: r,
			y: i
		};
	}, m = () => {
		if (i()) return;
		let e = t.getBoundingClientRect(), r = a(), s = {
			x: o(e.left, r.width),
			y: o(e.top, r.height)
		};
		u = s;
		try {
			globalThis.localStorage?.setItem(n, JSON.stringify({
				x: Math.round(s.x),
				y: Math.round(s.y)
			}));
		} catch {}
	}, h = () => {
		d(), i() || p(u || f());
	}, g = () => {
		i() ? d() : p(u || f());
	};
	return s.addEventListener("pointerdown", (e) => {
		c = {
			startX: e.clientX,
			startY: e.clientY,
			origX: t.getBoundingClientRect().left,
			origY: t.getBoundingClientRect().top,
			dragging: !1
		}, l = !1, s.setPointerCapture?.(e.pointerId);
	}), s.addEventListener("pointermove", (e) => {
		if (!c) return;
		let n = e.clientX - c.startX, r = e.clientY - c.startY;
		if (!c.dragging && Math.hypot(n, r) <= 5) return;
		c.dragging = !0, e.preventDefault?.();
		let i = a();
		t.style.left = `${o(c.origX + n, i.width)}px`, t.style.top = `${o(c.origY + r, i.height)}px`, t.style.right = "auto";
	}), s.addEventListener("pointerup", (e) => {
		c && (l = c.dragging, c.dragging && m(), c = null, s.releasePointerCapture?.(e?.pointerId));
	}), s.addEventListener("pointercancel", () => {
		c = null, l = !1;
	}), s.addEventListener("click", (t) => {
		if (l) {
			t.preventDefault(), l = !1;
			return;
		}
		e?.(t);
	}), globalThis.addEventListener?.("resize", g), h(), {
		host: t,
		root: r,
		button: s,
		restore: h,
		onResize: g,
		destroy: () => globalThis.removeEventListener?.("resize", g)
	};
}
//#endregion
//#region src/ui/wand-entry.js
function c(e) {
	let t, n, r = () => {
		if (t?.isConnected) return n?.disconnect(), !0;
		let r = document.querySelector("#sp_wand_container") || document.querySelector("#extensionsMenu");
		return r ? (t = document.createElement("div"), t.id = "qqj_open_wand", t.className = "list-group-item flex-container flexGap5", t.style.display = "flex", t.style.flexDirection = "row", t.style.flexWrap = "nowrap", t.style.alignItems = "center", t.style.whiteSpace = "nowrap", t.setAttribute("role", "button"), t.tabIndex = 0, t.innerHTML = "<i class=\"fa-solid fa-link extensionsMenuExtensionButton\"></i><span>千千结</span>", t.addEventListener("click", (t) => e?.(t)), t.addEventListener("keydown", (t) => {
			(t.key === "Enter" || t.key === " ") && (t.preventDefault(), e?.(t));
		}), r.append(t), n?.disconnect(), !0) : !1;
	};
	return !r() && document.body && (n = new MutationObserver(r), n.observe(document.body, {
		childList: !0,
		subtree: !0
	})), () => {
		n?.disconnect(), t?.remove();
	};
}
new TextEncoder(), Object.freeze([
	"GREETING_INVALID",
	"SCANNER_UNAVAILABLE",
	"SCAN_FAILED",
	"SCAN_RESULT_INVALID",
	"ENTRY_INVALID",
	"ROUTE_INVALID",
	"UNKNOWN"
]), Object.freeze({
	maxSources: 80,
	maxSourceChars: 24e3,
	maxTotalChars: 12e4,
	maxItems: 80,
	maxNameChars: 120,
	maxAnchorChars: 80,
	maxRefs: 12
}), Object.freeze({
	type: "object",
	additionalProperties: !1,
	required: [
		"confirmed",
		"candidate",
		"discarded"
	],
	properties: {
		confirmed: {
			type: "array",
			items: { $ref: "#/$defs/item" }
		},
		candidate: {
			type: "array",
			items: { $ref: "#/$defs/item" }
		},
		discarded: {
			type: "array",
			items: { $ref: "#/$defs/item" }
		}
	},
	$defs: {
		item: {
			type: "object",
			additionalProperties: !1,
			required: [
				"name",
				"sourceAnchor",
				"primarySourceRef",
				"sourceRefs"
			],
			properties: {
				name: {
					type: "string",
					minLength: 1,
					maxLength: 120
				},
				sourceAnchor: {
					type: "string",
					minLength: 1,
					maxLength: 80
				},
				primarySourceRef: { $ref: "#/$defs/ref" },
				sourceRefs: {
					type: "array",
					minItems: 1,
					maxItems: 12,
					items: { $ref: "#/$defs/ref" }
				}
			}
		},
		ref: {
			type: "object",
			additionalProperties: !1,
			required: ["kind", "locator"],
			properties: {
				kind: {
					type: "string",
					enum: ["greeting", "worldbook"]
				},
				locator: {
					type: "string",
					minLength: 1,
					maxLength: 300
				}
			}
		}
	}
}), Object.freeze({
	confirmed: [
		"confirmedPeople",
		"confirmedCharacters",
		"confirmed_people"
	],
	candidate: [
		"candidates",
		"candidatePeople",
		"candidateCharacters",
		"candidate_people"
	],
	discarded: [
		"excluded",
		"discardedPeople",
		"discardedCharacters",
		"discarded_people"
	]
}), Object.freeze({
	name: ["displayName"],
	sourceAnchor: ["anchor"],
	primarySourceRef: ["primarySource"],
	sourceRefs: ["refs"]
});
function l(e) {
	let t = Number(e?.status || e?.statusCode || 0), n = String(e?.code || e?.name || "").toLowerCase(), r = String(e?.message || "");
	return e?.name === "AbortError" || /timeout|timed.?out|etimedout|abort/.test(n) || /timeout|timed.?out|超时/i.test(r) || [408, 504].includes(t) ? "API 请求超时，请稍后重试" : [401, 403].includes(t) || /unauthori[sz]ed|forbidden|认证|api.?key/.test(`${n} ${r}`.toLowerCase()) ? "API 认证失败，请检查配置后重试" : t === 429 || /rate.?limit|too many requests|限流/.test(`${n} ${r}`.toLowerCase()) ? "API 请求过于频繁，请稍后重试" : /jsonData|generateTask 返回值无效|未返回 jsonData|结果不是 json|结果结构|结构无效|字段无效|来源锚点无效|无可用人物|schema/i.test(r) ? "人物识别结果格式无效" : "人物识别失败，请稍后重试";
}
//#endregion
//#region src/bootstrap.js
function u({ formal: e, people: n, settings: r, apiTools: i, loadState: a, initialRelations: o, reviewActions: u, onPluginEnabledChange: d, documentRef: f = globalThis.document, panelFactory: p = t, fabFactory: m = s, wandInstaller: h = c, enableFab: g = !1 } = {}) {
	if (!f) return {
		setState() {},
		show() {}
	};
	let _ = f.getElementById("qqj-panel-host");
	if (_) return _.__qqjInstance;
	let v = () => r?.isEnabled?.() !== !1, y = 0, b = () => v() ? { status: "stale" } : { status: "disabled" }, x = async (e, t) => {
		let r = () => v() && t === y;
		if (!r() || typeof n?.getPeople != "function") return r() ? e : b();
		let i = await n.getPeople();
		if (!r()) return b();
		if (![
			"uninitialized",
			"preparing",
			"deleting",
			"restoring",
			"renaming",
			"conflict",
			"stale"
		].includes(i?.status) || typeof n.identify != "function") return {
			...e,
			people: i
		};
		try {
			let t = await n.identify({ onPhase: (t) => {
				r() && T({
					...e,
					status: t
				});
			} });
			if (!r()) return b();
			let i = t?.status === "people_error" ? t : await n.getPeople();
			return r() ? {
				...e,
				people: {
					...i,
					warnings: [...new Map([...i?.warnings || [], ...t?.warnings || []].map((e) => [e.code || JSON.stringify(e), e])).values()].slice(0, 80)
				},
				...t?.status === "conflict" ? { peopleError: "人物改名恢复发生冲突，请稍后重试" } : {},
				...t?.peopleError ? { peopleError: t.peopleError } : {},
				peopleRecognitionFailed: t?.status === "people_error" || !!t?.peopleError
			} : b();
		} catch (t) {
			return r() ? {
				...e,
				status: ["ready", "route_ready"].includes(e?.status) ? e.status : "people_error",
				people: i,
				peopleError: l(t),
				peopleRecognitionFailed: !0
			} : b();
		}
	}, S, C = async ({ announceLoading: t = !1 } = {}) => {
		let n = ++y;
		if (!v()) {
			let e = { status: "disabled" };
			return n === y && S?.setState(e), e;
		}
		t && S?.setState({ status: "loading" });
		try {
			let t = typeof a == "function" ? await a() : await x(typeof e?.getFormalState == "function" ? await e.getFormalState() : { status: "error" }, n), r = v() && n === y ? t : b();
			return n === y && T(r), r;
		} catch {
			let e = v() ? { status: "error" } : { status: "disabled" };
			return n === y && T(e), e;
		}
	}, w = (e) => {
		S.host.style.display = "block", S.show(e?.currentTarget || e?.target || f.activeElement), C({ announceLoading: !0 });
	};
	S = p({
		formal: e,
		people: n,
		settings: r,
		apiTools: i,
		loadState: typeof a == "function" ? C : void 0,
		initialRelations: o,
		reviewActions: u,
		onPluginEnabledChange: d,
		onClose: () => {
			y += 1, S.host.style.display = "none";
		}
	});
	let T = (e) => {
		if (S.setState(e), e?.status === "people_error") {
			let t = S.root?.querySelector?.(".view"), n = f.createElement?.("p");
			n && (n.className = "error", n.textContent = e.peopleError || "人物识别失败：暂时无法读取人物结果，请稍后重试。", t?.append?.(n));
		}
	};
	S.host.style.display = "none", f.body.append(S.host);
	let E = g || typeof f.createElement != "function" ? m({ onClick: w }) : { host: null };
	E.host && (E.host.style ||= {}, E.host.style.display = v() ? "" : "none", f.body.append(E.host)), h(w), f.addEventListener("keydown", (e) => {
		e.key === "Escape" && !S.host.hidden && S.close();
	});
	let D = (e) => {
		y += 1, E.host?.style && (E.host.style.display = e ? "" : "none"), e || T({ status: "disabled" });
	}, O = {
		...S,
		fab: E,
		setState: T,
		setEnabled: D,
		show: w
	};
	return S.host.__qqjInstance = O, O;
}
//#endregion
export { u as bootstrap };
