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
function t({ formal: t, people: n, settings: r, apiTools: i, onPluginEnabledChange: a, onClose: o } = {}) {
	let s = document.createElement("div");
	s.id = "qqj-panel-host", s.hidden = !0, s.setAttribute("aria-hidden", "true");
	let c = s.attachShadow({ mode: "open" });
	c.innerHTML = "<style>:host{--panel:#fbfcfe;--panel-2:#f1f4f9;--ink:#23262d;--soft:#6a7079;--faint:#a2a8b2;--line:#23262d1a;--crimson:#b23a48;--u:#3e6b8c;--c:#b0784a;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif;display:block}*{box-sizing:border-box}.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;width:500px;max-width:100vw;animation:.35s both in;overflow:hidden;box-shadow:0 24px 70px #23262d2e,0 4px 14px #23262d12}.topbar{align-items:center;gap:14px;padding:15px 18px 0;display:flex}.brand{align-items:baseline;gap:7px;display:flex}.mark,.tab,.empty h2,.choice strong,.module b{font-family:宋体,Songti SC,SimSun,serif}.mark{letter-spacing:.06em;font-size:17px;font-weight:700}.em{color:var(--crimson)}.sub{color:var(--faint);letter-spacing:.22em;font:10px ui-monospace,monospace}.close{color:var(--soft);cursor:pointer;background:0 0;border:0;width:28px;height:28px;margin-left:auto;font-size:24px;line-height:1}.close:focus-visible,.tab:focus-visible,.choice:focus-visible,.init:focus-visible,.person-action:focus-visible,summary:focus-visible{outline:2px solid var(--crimson);outline-offset:2px}.tabs{border-bottom:1px solid var(--line);gap:2px;margin-top:8px;padding:6px 12px 0 14px;display:flex}.tab{color:var(--faint);cursor:pointer;background:0 0;border:0;padding:8px 12px 12px;font-size:14px;position:relative}.tab.active{color:var(--ink);font-weight:600}.tab.active:after{content:\"\";background:linear-gradient(var(--crimson),transparent);width:2px;height:12px;position:absolute;bottom:-1px;left:50%;transform:translate(-50%)}.body{max-height:74vh;padding:16px 18px 20px;overflow:auto}.status-line{color:var(--soft);align-items:center;gap:7px;min-height:18px;font-size:11px;display:flex}.status-dot{background:var(--faint);border-radius:50%;width:7px;height:7px}.status-dot.ready{background:#5b8c6e}.status-dot.warn{background:var(--crimson)}.status-meta{color:var(--faint);margin-left:auto;font:10px ui-monospace,monospace}.view{padding-top:10px}.empty{text-align:center;border-top:1px solid var(--line);margin-top:8px;padding:30px 8px 24px}.empty h2{margin:5px 0 8px;font-size:19px}.empty p{color:var(--soft);max-width:340px;margin:0 auto;font-size:12px;line-height:1.7}.eyebrow{letter-spacing:.12em;color:var(--crimson);font:10px ui-monospace,monospace}.choices{grid-template-columns:1fr 1fr;gap:8px;margin:20px 0 14px;display:grid}.choice{text-align:left;border:1px solid var(--line);background:var(--panel-2);cursor:pointer;color:var(--ink);border-radius:9px;padding:13px 12px;position:relative}.choice:hover,.choice.selected{background:#b23a480f;border-color:#b23a4873}.choice input{opacity:0;position:absolute}.choice strong{margin-bottom:4px;font-size:14px;display:block}.choice span{color:var(--soft);font-size:10.5px;line-height:1.5;display:block}.init{border:1px solid var(--crimson);background:var(--crimson);color:#fff;cursor:pointer;border-radius:8px;padding:8px 15px;font-size:12px}.init:disabled{opacity:.45;cursor:not-allowed}.people-list{text-align:left;gap:8px;margin-top:18px;display:grid}.people-list h3{color:var(--soft);margin:0 0 2px;font-size:12px;font-weight:600}.person-card{padding:12px 13px}.person-actions{flex-wrap:wrap;gap:6px;margin-top:10px;display:flex}.person-action{border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer;border-radius:7px;padding:5px 9px;font-size:11px}.person-action:hover{color:var(--crimson);border-color:#b23a4873}.shelved-people{text-align:left;border-top:1px solid var(--line);margin-top:18px;padding-top:12px}.shelved-people summary{cursor:pointer;color:var(--soft);font-size:12px}.modules{grid-template-columns:1fr 1fr;gap:9px;margin-top:15px;display:grid}.module{border:1px solid var(--line);background:linear-gradient(#b23a480a,#0000);border-radius:10px;padding:15px 13px}.module b{font-size:14px}.module small{color:var(--faint);margin-top:7px;font-size:10.5px;display:block}.footer{border-top:1px solid var(--line);background:var(--panel-2);align-items:center;gap:12px;padding:11px 18px;display:flex}.legend{color:var(--faint);gap:10px;font-size:10px;display:flex}.legend span{align-items:center;gap:3px;display:inline-flex}.legend i{border-radius:2px;width:7px;height:7px}.u{background:var(--u)}.c{background:var(--c)}.crimson{background:var(--crimson)}.foot-note{color:var(--faint);margin-left:auto;font-size:10px}@keyframes in{0%{opacity:0}to{opacity:1}}@media (width<=540px){.panel{border-radius:14px;min-height:0;box-shadow:0 15px 45px #23262d2e}.body{max-height:none}.choices,.modules{grid-template-columns:1fr}}@media (prefers-reduced-motion:reduce){*,:before,:after{transition-duration:.01ms!important;animation-duration:.01ms!important}}:host{--success:#3f7356;--field:#fff}.settings-btn{width:36px;height:36px;color:var(--soft);cursor:pointer;background:0 0;border:1px solid #0000;border-radius:50%;flex:0 0 36px;margin:-7px -8px -7px 0;font-size:16px;line-height:1}.settings-btn:hover{color:var(--crimson);background:#b23a4812;border-color:#b23a4824}.settings-btn:focus-visible,.open-settings:focus-visible,.settings-view button:focus-visible,.settings-view input:focus-visible,.settings-view select:focus-visible,.settings-view textarea:focus-visible{outline:2px solid var(--crimson);outline-offset:2px}.open-settings{border:1px solid var(--crimson);color:var(--crimson);cursor:pointer;background:0 0;border-radius:8px;margin-top:18px;padding:8px 15px;font-size:12px}.settings-view{text-align:left;padding:10px 2px 4px}.settings-heading{justify-content:space-between;align-items:flex-start;gap:14px;padding:4px 2px 14px;display:flex}.settings-heading h2{margin:4px 0 0;font:700 19px 宋体,Songti SC,SimSun,serif}.master-switch{border:1px solid var(--line);background:var(--panel-2);min-height:36px;color:var(--soft);white-space:nowrap;cursor:pointer;border-radius:18px;align-items:center;gap:7px;padding:7px 10px;font-size:11px;display:flex}.master-switch input,.check-field input{accent-color:var(--crimson)}.api-source-card{background:linear-gradient(105deg,#b23a4814,#3e6b8c09);border:1px solid #b23a482e;border-radius:10px;gap:4px;margin-bottom:14px;padding:13px 14px 13px 17px;display:grid;position:relative}.api-source-card:before{content:\"\";background:var(--crimson);border-radius:0 3px 3px 0;width:3px;position:absolute;top:12px;bottom:12px;left:0}.api-source-card span{color:var(--soft);font-size:10px}.api-source-card strong{font-size:13px}.api-source-card small{color:var(--faint);font-size:10px;line-height:1.5}.settings-section{border:1px solid var(--line);background:var(--panel-2);border-radius:11px;gap:10px;margin-top:14px;padding:14px;display:grid}.section-title{justify-content:space-between;align-items:start;gap:10px;display:flex}.section-title b{font-size:12px;display:block}.section-title small{color:var(--faint);margin-top:3px;font-size:10px;line-height:1.45;display:block}.field{color:var(--soft);gap:5px;font-size:10.5px;display:grid}.field input,.field select,.field textarea{border:1px solid var(--line);background:var(--field);width:100%;min-width:0;color:var(--ink);border-radius:7px;padding:8px 9px;font:12px -apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif}.field textarea{resize:vertical;line-height:1.5}.key-row,.model-row{grid-template-columns:minmax(0,1fr) auto auto;gap:6px;display:grid}.model-row{grid-template-columns:minmax(0,1fr) auto}.key-row button,.model-row button,.preset-actions button,.model-results button,.secondary-action,.primary-action{border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer;border-radius:7px;padding:7px 9px;font-size:10.5px}.preset-actions{flex-wrap:wrap;gap:6px;margin-top:-3px;display:flex}.preset-actions button{padding:5px 8px}.advanced{border-top:1px solid var(--line);padding-top:9px}.advanced summary{cursor:pointer;color:var(--soft);font-size:11px}.advanced[open] summary{margin-bottom:10px}.advanced-row{grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:10px;margin-top:9px;display:grid}.check-field{min-height:34px;color:var(--soft);align-items:center;gap:6px;font-size:11px;display:flex}.settings-actions{grid-template-columns:1fr 1.35fr;gap:8px;margin-top:14px;display:grid}.secondary-action,.primary-action{min-height:36px;font-size:12px}.primary-action{border-color:var(--crimson);background:var(--crimson);color:#fff}.settings-view button:disabled{opacity:.5;cursor:wait}.settings-result{min-height:18px;color:var(--soft);margin:8px 2px 0;font-size:10.5px;line-height:1.5}.settings-result.success{color:var(--success)}.settings-result.error{color:var(--crimson)}.model-results{flex-wrap:wrap;gap:5px;max-height:140px;display:flex;overflow:auto}.model-results[hidden]{display:none}.model-results button{text-overflow:ellipsis;white-space:nowrap;max-width:100%;overflow:hidden}@media (width<=540px){.footer{padding-bottom:max(11px,env(safe-area-inset-bottom,0px))}.legend{display:none}.foot-note{margin-left:auto}.settings-view{padding-bottom:4px}.settings-heading{align-items:center}.settings-section{padding:12px}.advanced-row{grid-template-columns:1fr}.check-field{min-height:auto}.key-row{grid-template-columns:minmax(0,1fr) auto}.key-row [data-action=key-clear]{grid-column:2}.settings-actions{background:linear-gradient(transparent,var(--panel) 30%);padding-top:8px;position:sticky;bottom:0}}:host{position:fixed;inset:0;z-index:1001;width:100dvw;height:100dvh;pointer-events:none;background:transparent}:host([hidden]){display:none!important;pointer-events:none!important}.panel{position:fixed;top:80px;right:20px;width:360px;max-width:calc(100vw - 40px);max-height:85vh;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;pointer-events:auto}.body{min-height:0;max-height:none;overflow-y:auto}.tabs{min-width:0;overflow-x:auto;flex-wrap:nowrap}.tab{flex:0 0 auto}@media(max-width:640px){.panel{top:calc(20px + env(safe-area-inset-top,0px));left:50%;right:auto;bottom:auto;transform:translateX(-50%);width:calc(100dvw - 20px);max-width:calc(100dvw - 20px);height:calc(100dvh - 40px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));max-height:calc(100dvh - 40px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));min-height:0;border-radius:14px}.body{min-height:0;overflow-y:auto}.choices{grid-template-columns:1fr}.tab{padding-left:9px;padding-right:9px}}</style><section class=\"panel\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"qqj-dialog-title\">\n<header class=\"topbar\"><div class=\"brand\"><span class=\"mark\" id=\"qqj-dialog-title\">千<span class=\"em\">千</span>结</span><span class=\"sub\">QIANQIANJIE</span></div><button class=\"icon-btn close\" type=\"button\" aria-label=\"关闭\">×</button></header>\n<nav class=\"tabs\" role=\"tablist\" aria-label=\"档案模块\"><button class=\"tab active\" role=\"tab\" aria-selected=\"true\" data-tab=\"people\">千人</button><button class=\"tab\" role=\"tab\" aria-selected=\"false\" data-tab=\"bonds\">双丝网</button><button class=\"tab\" role=\"tab\" aria-selected=\"false\" data-tab=\"milestones\">千事</button><button class=\"tab\" role=\"tab\" aria-selected=\"false\" data-tab=\"knots\">千结</button></nav>\n<main class=\"body\"><div class=\"status-line\"><span class=\"status-dot\"></span><span class=\"status-label\">正在读取当前聊天</span><span class=\"status-meta\"></span></div><div class=\"view\"></div></main>\n<footer class=\"footer\"><span class=\"legend\"><span><i class=\"u\"></i>你</span><span><i class=\"c\"></i>角色</span><span><i class=\"crimson\"></i>关系档案</span></span><span class=\"source-badge source-formal\">FORMAL</span><span class=\"foot-note\">本地界面 · 正式状态</span><button class=\"settings-btn\" type=\"button\" aria-label=\"打开千千结设置\" title=\"设置\">⚙</button></footer>\n</section>\n";
	let l = c.querySelector(".view"), u = c.querySelector(".status-label"), d = c.querySelector(".status-meta"), f = c.querySelector(".status-dot"), p = { status: "loading" }, m = null, h = !1, g = null, _ = "people", v = "", y = 0, b = () => [...c.querySelectorAll("button,input,select,textarea,[href],[tabindex]:not([tabindex=\"-1\"])")].filter((e) => !e.disabled && e.offsetParent !== null), x = () => {
		s.hidden = !0, s.setAttribute("aria-hidden", "true");
		let e = g;
		g = null, o?.(), e?.focus?.();
	}, S = (e) => ({
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
	})[String(e?.code || "")] || "连接失败，请检查 API 配置后重试。", C = (e, t, n) => {
		let r = document.createElement("option");
		return r.value = t, r.textContent = n, e?.append?.(r), r;
	}, w = () => {
		let e = Number(l.querySelector?.("[data-setting=\"timeout\"]")?.value);
		return {
			url: l.querySelector?.("[data-setting=\"url\"]")?.value?.trim?.() || "",
			key: v,
			model: l.querySelector?.("[data-setting=\"model\"]")?.value?.trim?.() || "",
			excludeParams: l.querySelector?.("[data-setting=\"exclude\"]")?.value || "",
			timeoutSec: e,
			stream: l.querySelector?.("[data-setting=\"stream\"]")?.checked === !0
		};
	}, T = () => {
		let e = l.querySelector?.("[data-setting=\"source\"]")?.value || "auto";
		return e.startsWith("seven:") ? {
			apiMode: "seven-preset",
			selectedSevenDaysPresetId: e.slice(6)
		} : e === "local" ? {
			apiMode: "local",
			selectedSevenDaysPresetId: "",
			localConfig: w()
		} : e === "tavern" ? {
			apiMode: "tavern",
			selectedSevenDaysPresetId: ""
		} : {
			apiMode: "auto",
			selectedSevenDaysPresetId: ""
		};
	}, E = (e, t = "") => {
		let n = l.querySelector?.(".settings-result");
		n && (n.textContent = e, n.className = `settings-result ${t}`.trim());
	}, D = (e) => {
		let t = l.querySelector?.("[data-setting=\"url\"]"), n = l.querySelector?.("[data-setting=\"model\"]"), r = l.querySelector?.("[data-setting=\"exclude\"]"), i = l.querySelector?.("[data-setting=\"timeout\"]"), a = l.querySelector?.("[data-setting=\"stream\"]"), o = l.querySelector?.("[data-setting=\"key\"]");
		t && (t.value = e?.url || ""), n && (n.value = e?.model || ""), r && (r.value = (e?.excludeParams || []).join("\n")), i && (i.value = String(e?.timeoutSec || 180)), a && (a.checked = e?.stream === !0), v = e?.key || "", o && (o.value = "", o.placeholder = v ? "已保存（输入新值可替换）" : "输入 API Key", o.type = "password");
	}, O = () => {
		let e = ++y;
		if (!r?.get) {
			E("设置存储暂不可用。", "error");
			return;
		}
		_ = "settings", c.querySelectorAll(".tab").forEach((e) => {
			e.classList.toggle("active", !1), e.setAttribute("aria-selected", "false");
		});
		let t = r.get(), n = r.localConfig(), o = i?.describe?.() || {
			sourceLabel: "尚未解析",
			sevenDaysPresets: []
		};
		u.textContent = "千千结设置", d.textContent = "LOCAL", f.className = `status-dot ${t.pluginEnabled === !1 ? "warn" : "ready"}`, l.innerHTML = "<section class=\"settings-view\"><div class=\"settings-heading\"><div><div class=\"eyebrow\">THREAD CONTROL</div><h2>连接与总开关</h2></div><label class=\"master-switch\"><input data-setting=\"enabled\" type=\"checkbox\"><span>启用千千结</span></label></div><div class=\"api-source-card\"><span>当前请求来源</span><strong class=\"api-source-label\"></strong><small>构画配置只读继承，密钥不会复制到千千结。</small></div><label class=\"field\"><span>API 来源</span><select data-setting=\"source\"></select></label><section class=\"settings-section\"><div class=\"section-title\"><div><b>千千结本地 API</b><small>构画不可用时自动接力，也可手动选择。</small></div></div><label class=\"field\"><span>本地预设</span><select data-setting=\"local-preset\"></select></label><div class=\"preset-actions\"><button type=\"button\" data-action=\"preset-new\">新增</button><button type=\"button\" data-action=\"preset-update\">更新</button><button type=\"button\" data-action=\"preset-rename\">改名</button><button type=\"button\" data-action=\"preset-delete\">删除</button></div><label class=\"field\"><span>Base URL</span><input data-setting=\"url\" type=\"url\" autocomplete=\"off\" placeholder=\"https://api.example.com/v1\"></label><label class=\"field\"><span>API Key</span><span class=\"key-row\"><input data-setting=\"key\" type=\"password\" autocomplete=\"new-password\"><button type=\"button\" data-action=\"key-toggle\" aria-label=\"显示或隐藏 Key\">显示</button><button type=\"button\" data-action=\"key-clear\">清除</button></span></label><label class=\"field\"><span>模型</span><span class=\"model-row\"><input data-setting=\"model\" type=\"text\" autocomplete=\"off\" placeholder=\"gpt-4o-mini\"><button type=\"button\" data-action=\"models\">拉取模型</button></span></label><div class=\"model-results\" hidden></div><details class=\"advanced\"><summary>高级设置</summary><label class=\"field\"><span>剔除参数（每行一个）</span><textarea data-setting=\"exclude\" rows=\"3\" placeholder=\"frequency_penalty\"></textarea></label><div class=\"advanced-row\"><label class=\"field\"><span>超时（5–600 秒）</span><input data-setting=\"timeout\" type=\"number\" min=\"5\" max=\"600\"></label><label class=\"check-field\"><input data-setting=\"stream\" type=\"checkbox\"><span>流式响应</span></label></div></details></section><div class=\"settings-actions\"><button class=\"secondary-action\" type=\"button\" data-action=\"test\">测试连接</button><button class=\"primary-action\" type=\"button\" data-action=\"save\">保存设置</button></div><p class=\"settings-result\" role=\"status\" aria-live=\"polite\"></p></section>";
		let s = l.querySelector("[data-setting=\"enabled\"]");
		s && (s.checked = t.pluginEnabled !== !1);
		let p = l.querySelector(".api-source-label");
		p && (p.textContent = o.sourceLabel);
		let m = l.querySelector("[data-setting=\"source\"]");
		C(m, "auto", "自动继承构画");
		for (let e of o.sevenDaysPresets || []) C(m, `seven:${e.id}`, `构画预设 · ${e.name}`);
		C(m, "local", "千千结本地 API"), C(m, "tavern", "酒馆当前模型"), m && (m.value = t.apiMode === "seven-preset" ? `seven:${t.selectedSevenDaysPresetId}` : t.apiMode || "auto");
		let h = l.querySelector("[data-setting=\"local-preset\"]");
		C(h, "", "当前本地配置");
		for (let e of r.presets()) C(h, e.id, e.name);
		h && (h.value = t.apiPresetActiveId || "");
		let g = r.presets().find((e) => e.id === t.apiPresetActiveId);
		D(g || n);
		let b = t.pluginEnabled !== !1, x = l.querySelector("[data-action=\"test\"]"), k = l.querySelector("[data-action=\"models\"]");
		x && (x.disabled = !b), k && (k.disabled = !b), h?.addEventListener("change", () => {
			let e = r.presets().find((e) => e.id === h.value);
			D(e || r.localConfig());
		}), l.querySelector("[data-setting=\"key\"]")?.addEventListener("input", (e) => {
			v = e.target.value;
		}), l.querySelector("[data-action=\"key-toggle\"]")?.addEventListener("click", (e) => {
			let t = l.querySelector("[data-setting=\"key\"]");
			t && (t.type === "password" ? (!t.value && v && (t.value = v), t.type = "text", e.currentTarget.textContent = "隐藏") : (v = t.value, t.value = "", t.type = "password", t.placeholder = v ? "已保存（输入新值可替换）" : "输入 API Key", e.currentTarget.textContent = "显示"));
		}), l.querySelector("[data-action=\"key-clear\"]")?.addEventListener("click", () => {
			v = "";
			let e = l.querySelector("[data-setting=\"key\"]");
			e && (e.value = "", e.placeholder = "输入 API Key"), E("保存后会清除千千结本地 Key。");
		}), l.querySelector("[data-action=\"preset-new\"]")?.addEventListener("click", () => {
			let e = globalThis.prompt?.("新预设名称", "新预设")?.trim();
			if (!e) return;
			let t = r.upsertPreset(e, w());
			r.update({ apiPresetActiveId: t }), O(), E(`已新增本地预设「${e}」。`, "success");
		}), l.querySelector("[data-action=\"preset-update\"]")?.addEventListener("click", () => {
			let e = l.querySelector("[data-setting=\"local-preset\"]")?.value, t = r.presets().find((t) => t.id === e);
			if (!t) return E("请先选择要更新的本地预设。", "error");
			r.upsertPreset(t.name, w(), e), O(), E(`已更新本地预设「${t.name}」。`, "success");
		}), l.querySelector("[data-action=\"preset-rename\"]")?.addEventListener("click", () => {
			let e = l.querySelector("[data-setting=\"local-preset\"]")?.value, t = r.presets().find((t) => t.id === e);
			if (!t) return E("请先选择要改名的本地预设。", "error");
			let n = globalThis.prompt?.("新的预设名称", t.name)?.trim();
			n && (r.renamePreset(e, n), O(), E(`已改名为「${n}」。`, "success"));
		}), l.querySelector("[data-action=\"preset-delete\"]")?.addEventListener("click", () => {
			let e = l.querySelector("[data-setting=\"local-preset\"]")?.value, t = r.presets().find((t) => t.id === e);
			if (!t) return E("请先选择要删除的本地预设。", "error");
			globalThis.confirm?.(`删除本地预设「${t.name}」？`) && (r.deletePreset(e), O(), E("本地预设已删除。", "success"));
		}), l.querySelector("[data-action=\"save\"]")?.addEventListener("click", async () => {
			let e = w();
			if (!Number.isInteger(e.timeoutSec) || e.timeoutSec < 5 || e.timeoutSec > 600) return E("超时时间必须是 5–600 秒的整数。", "error");
			let t = T(), n = r.isEnabled();
			r.update({
				...t,
				pluginEnabled: s?.checked !== !1,
				apiUrl: e.url,
				apiKey: e.key,
				apiModel: e.model,
				apiExcludeParams: e.excludeParams,
				apiTimeoutSec: e.timeoutSec,
				apiStream: e.stream,
				apiPresetActiveId: l.querySelector("[data-setting=\"local-preset\"]")?.value || ""
			});
			let i = r.isEnabled();
			n !== i && await a?.(i), O(), E("设置已保存。", "success");
		}), l.querySelector("[data-action=\"test\"]")?.addEventListener("click", async (t) => {
			if (!r.isEnabled()) {
				E("千千结已关闭；启用并保存后才能测试连接。", "error");
				return;
			}
			let n = T();
			t.currentTarget.disabled = !0, E("正在发送不含聊天与人物数据的短测试…");
			try {
				let t = await i?.testConnection?.(n);
				e === y && r.isEnabled() && E(`连接成功 · ${t?.model || "当前模型"}`, "success");
			} catch (t) {
				e === y && r.isEnabled() && E(S(t), "error");
			} finally {
				e === y && r.isEnabled() && (t.currentTarget.disabled = !1);
			}
		}), l.querySelector("[data-action=\"models\"]")?.addEventListener("click", async (t) => {
			if (!r.isEnabled()) {
				E("千千结已关闭；启用并保存后才能读取模型列表。", "error");
				return;
			}
			let n = T();
			t.currentTarget.disabled = !0, E("正在读取模型列表…");
			try {
				let t = await i?.fetchModels?.(n), a = l.querySelector(".model-results");
				if (!a || e !== y || !r.isEnabled()) return;
				a.replaceChildren(), a.hidden = !1;
				for (let e of t || []) {
					let t = document.createElement("button");
					t.type = "button", t.textContent = e, t.addEventListener("click", () => {
						let t = l.querySelector("[data-setting=\"model\"]");
						t && (t.value = e);
					}), a.append(t);
				}
				E(`已读取 ${t?.length || 0} 个模型。`, "success");
			} catch (t) {
				e === y && r.isEnabled() && E(S(t), "error");
			} finally {
				e === y && r.isEnabled() && (t.currentTarget.disabled = !1);
			}
		});
	}, k = () => {
		l.innerHTML = "<div class=\"empty\"><div class=\"eyebrow\">FIRST THREAD</div><h2>先为这段关系选一种形状</h2><p>选择只决定档案的起始方式，之后仍可以在正式数据中继续补充。</p><div class=\"choices\">" + e.map((e) => "<label class=\"choice\"><input type=\"radio\" name=\"qqj-card-type\" value=\"" + e[0] + "\"><strong>" + e[1] + "</strong><span>" + e[2] + "</span></label>").join("") + "</div><button class=\"init\" type=\"button\" disabled>初始化档案</button></div>", l.querySelectorAll("input").forEach((e) => e.addEventListener("change", () => {
			m = e.value, l.querySelectorAll(".choice").forEach((e) => e.classList.toggle("selected", e.querySelector("input").checked)), l.querySelector(".init").disabled = !1;
		})), l.querySelector(".init").addEventListener("click", async () => {
			if (!(h || !m)) {
				h = !0, l.querySelector(".init").disabled = !0, u.textContent = "正在写入正式档案";
				try {
					M(await t.initializeCard({ cardType: m }));
				} catch {
					M({ status: "error" });
				} finally {
					h = !1;
				}
			}
		});
	}, A = (e, t, n) => {
		let r = document.createElement("button");
		return r.type = "button", r.className = "person-action", r.dataset[t] = n, r.textContent = e, r;
	}, j = () => {
		let e = Array.isArray(p.people?.confirmed) ? p.people.confirmed : [], t = Array.isArray(p.people?.candidate) ? p.people.candidate : [], r = Array.isArray(p.people?.shelved) ? p.people.shelved : [], i = Array.isArray(p.people?.warnings) ? p.people.warnings : [], a = i.some((e) => String(e?.code || "").startsWith("NORMALIZATION_")), o = i.some((e) => !String(e?.code || "").startsWith("NORMALIZATION_"));
		l.replaceChildren();
		let s = document.createElement("div");
		s.className = "empty";
		let c = document.createElement("div");
		c.className = "eyebrow", c.textContent = "FORMAL PROFILE / READY";
		let u = document.createElement("h2");
		u.textContent = "关系档案已就绪";
		let d = document.createElement("p");
		if (d.textContent = "“选择”只表示你当前想关注和发展这位人物，可多选；不代表已经恋爱或发生关系。未选择人物会继续保留。", s.append(c, u, d), o) {
			let e = document.createElement("p");
			e.className = "error", e.textContent = "部分原设来源当前不可用，已按其余来源继续。", s.append(e);
		}
		if (a) {
			let e = document.createElement("p");
			e.className = "error", e.textContent = "部分人物格式已自动修正或跳过。", s.append(e);
		}
		if (p.peopleError) {
			let e = document.createElement("p");
			e.className = "error", e.textContent = p.peopleError, s.append(e);
		}
		if (e.length) {
			let t = document.createElement("section");
			t.className = "people-list";
			let n = document.createElement("h3");
			n.textContent = "明确人物", t.append(n), e.forEach((e) => {
				let n = document.createElement("article");
				n.className = "module person-card";
				let r = document.createElement("b");
				r.textContent = e.displayName ?? "";
				let i = e.selection?.status === "selected", a = document.createElement("small");
				a.textContent = i ? "当前关注 · 不代表已经恋爱" : "尚未选择 · 人物仍会长期保留";
				let o = document.createElement("div");
				o.className = "person-actions", o.append(A(i ? "取消选择" : "选择", i ? "unselect" : "select", e.identityId), A("改名", "edit", e.identityId), A("搁置", "shelve", e.identityId)), n.append(r, a, o), t.append(n);
			}), s.append(t);
		} else if (!o && !p.peopleError) {
			let e = document.createElement("p");
			e.textContent = "当前来源尚未登记明确人物。", s.append(e);
		}
		if (t.length) {
			let e = document.createElement("section");
			e.className = "people-list";
			let n = document.createElement("h3");
			n.textContent = "待判断人物", e.append(n), t.forEach((t) => {
				let n = document.createElement("article");
				n.className = "module person-card";
				let r = document.createElement("b");
				r.textContent = t.name ?? "";
				let i = document.createElement("small");
				i.textContent = "身份或重要性仍需判断 · 未选择", n.append(r, i), e.append(n);
			}), s.append(e);
		}
		if (r.length) {
			let e = document.createElement("details");
			e.className = "shelved-people";
			let t = document.createElement("summary");
			t.textContent = `已搁置人物（${r.length}）`, e.append(t);
			let n = document.createElement("div");
			n.className = "people-list", r.forEach((e) => {
				let t = document.createElement("article");
				t.className = "module person-card";
				let r = document.createElement("b");
				r.textContent = e.displayName ?? "";
				let i = document.createElement("small");
				i.textContent = "已保留身份、改名和用户事实";
				let a = document.createElement("div");
				a.className = "person-actions", a.append(A("恢复", "restore", e.identityId)), t.append(r, i, a), n.append(t);
			}), e.append(n), s.append(e);
		}
		let f = document.createElement("div");
		f.className = "modules", [
			"双丝网",
			"千事",
			"千结"
		].forEach((e) => {
			let t = document.createElement("article");
			t.className = "module";
			let n = document.createElement("b");
			n.textContent = e;
			let r = document.createElement("small");
			r.textContent = "尚未接入业务数据", t.append(n, r), f.append(t);
		}), s.append(f), l.append(s), l.querySelectorAll("[data-edit]").forEach((t) => t.addEventListener("click", async () => {
			let r = globalThis.prompt?.("新的显示名", e.find((e) => e.identityId === t.dataset.edit)?.displayName ?? "");
			r?.trim() && n?.editDisplayName && await N(() => n.editDisplayName({
				identityId: t.dataset.edit,
				displayName: r
			}));
		})), l.querySelectorAll("[data-select]").forEach((e) => e.addEventListener("click", () => N(() => n.select({ identityId: e.dataset.select })))), l.querySelectorAll("[data-unselect]").forEach((e) => e.addEventListener("click", () => N(() => n.unselect({ identityId: e.dataset.unselect })))), l.querySelectorAll("[data-shelve]").forEach((e) => e.addEventListener("click", async () => {
			globalThis.confirm?.("搁置后人物会从主列表隐藏，但可随时恢复。继续吗？") && n?.shelve && await N(() => n.shelve({ identityId: e.dataset.shelve }));
		})), l.querySelectorAll("[data-restore]").forEach((e) => e.addEventListener("click", () => N(() => n.restore({ identityId: e.dataset.restore }))));
	}, M = (e) => {
		if (p = e || { status: "error" }, _ === "settings") return;
		let t = p.status, n = ["ready", "route_ready"].includes(t) && p.peopleRecognitionFailed, r = Array.isArray(p.people?.warnings) && p.people.warnings.some((e) => String(e?.code || "").startsWith("NORMALIZATION_"));
		if (u.textContent = n ? "人物识别失败，已保留旧列表" : {
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
		}[t] || t, d.textContent = t === "route_unavailable" ? [
			"GREETING_INVALID",
			"SCANNER_UNAVAILABLE",
			"SCAN_FAILED",
			"SCAN_RESULT_INVALID",
			"ENTRY_INVALID",
			"ROUTE_INVALID",
			"UNKNOWN"
		].includes(p.diagnosticCode) ? p.diagnosticCode : "UNKNOWN" : p.cardType || "", f.className = "status-dot " + (n || r || [
			"disabled",
			"mismatch",
			"route_mismatch",
			"route_unavailable",
			"error",
			"conflict"
		].includes(t) ? "warn" : ["ready", "route_ready"].includes(t) ? "ready" : ""), t === "awaiting_card_type" || t === "migrated") return k();
		if (["ready", "route_ready"].includes(t)) return j();
		let i = t === "disabled" ? ["千千结现在是关闭的", "不会读取聊天、扫描来源、调用 AI 或写入档案。已有数据保持原样。"] : t === "route_mismatch" ? ["路线来源需要确认", "当前路线已锁定，来源诊断仅作提示，不影响人物识别。"] : t === "route_unavailable" ? ["来源扫描不可用", "当前世界书无法进行安全的 dry-run 扫描，请稍后重试。"] : t === "mismatch" ? ["身份需要确认", "当前角色、Persona 或正式档案绑定不一致。为保护已有数据，本次只读。"] : t === "offline" ? ["暂时离线", "正式存储暂时不可用，恢复连接后可重新打开。"] : t === "stopped" ? ["还没有可用聊天", "请先打开一个单人聊天，再打开千千结。"] : t === "preparing" ? ["正在恢复档案", "请稍候，档案恢复完成前不能操作人物。"] : t === "renaming" ? ["正在恢复人物改名", "上次改名尚未完成，正在核对人物档案与列表。"] : ["正在准备档案", "正式状态尚未就绪，请稍后重试。"];
		l.innerHTML = "<div class=\"empty\"><div class=\"eyebrow\">QIANQIANJIE / " + t.toUpperCase() + "</div><h2>" + i[0] + "</h2><p>" + i[1] + "</p>" + (t === "disabled" ? "<button class=\"open-settings\" type=\"button\">打开设置</button>" : "") + "</div>", l.querySelector?.(".open-settings")?.addEventListener("click", O);
	}, N = async (e) => {
		if (!h) {
			h = !0;
			try {
				let t = await e();
				if (t?.status === "conflict" || t?.status === "error") {
					M({
						...p,
						status: ["ready", "route_ready"].includes(p.status) ? p.status : t.status,
						people: p.people,
						peopleError: "档案发生冲突，请稍后重试"
					});
					return;
				}
				let r = n?.getPeople ? await n.getPeople() : t;
				M(p.peopleRecognitionFailed ? {
					...p,
					people: r
				} : {
					...p,
					people: r,
					peopleError: null
				});
			} catch {
				M({
					...p,
					status: ["ready", "route_ready"].includes(p.status) ? p.status : "error",
					people: p.people,
					peopleError: "操作失败，原人物列表已保留"
				});
			} finally {
				h = !1;
			}
		}
	};
	return c.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			e.preventDefault(), x();
			return;
		}
		if (e.key !== "Tab") return;
		let t = b();
		if (!t.length) return;
		let n = t[0], r = t[t.length - 1];
		e.shiftKey && c.activeElement === n ? (e.preventDefault(), r.focus()) : !e.shiftKey && c.activeElement === r && (e.preventDefault(), n.focus());
	}), c.querySelector(".close").addEventListener("click", x), c.querySelector(".settings-btn")?.addEventListener("click", () => {
		if (_ === "settings") {
			y += 1, _ = "people";
			let e = c.querySelector(".tab");
			e?.classList.toggle("active", !0), e?.setAttribute("aria-selected", "true"), M(p);
		} else O();
	}), c.querySelectorAll(".tab").forEach((e) => e.addEventListener("click", () => {
		y += 1, _ = "people", c.querySelectorAll(".tab").forEach((t) => {
			let n = t === e;
			t.classList.toggle("active", n), t.setAttribute("aria-selected", String(n));
		}), M(p);
	})), M(p), {
		host: s,
		root: c,
		show: (e = document.activeElement) => {
			g = e, s.hidden = !1, s.setAttribute("aria-hidden", "false"), c.querySelector(".close").focus();
		},
		close: x,
		setState: M,
		showSettings: O,
		getState: () => ({ ...p })
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
function u({ formal: e, people: n, settings: r, apiTools: i, onPluginEnabledChange: a, documentRef: o = globalThis.document, panelFactory: u = t, fabFactory: d = s, wandInstaller: f = c, enableFab: p = !1 } = {}) {
	if (!o) return {
		setState() {},
		show() {}
	};
	let m = o.getElementById("qqj-panel-host");
	if (m) return m.__qqjInstance;
	let h = () => r?.isEnabled?.() !== !1, g = 0, _ = () => h() ? { status: "stale" } : { status: "disabled" }, v = async (e, t) => {
		let r = () => h() && t === g;
		if (!r() || typeof n?.getPeople != "function") return r() ? e : _();
		let i = await n.getPeople();
		if (!r()) return _();
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
				r() && x({
					...e,
					status: t
				});
			} });
			if (!r()) return _();
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
			} : _();
		} catch (t) {
			return r() ? {
				...e,
				status: ["ready", "route_ready"].includes(e?.status) ? e.status : "people_error",
				people: i,
				peopleError: l(t),
				peopleRecognitionFailed: !0
			} : _();
		}
	}, y = (t) => {
		if (b.host.style.display = "block", b.show(t?.currentTarget || t?.target || o.activeElement), !h()) {
			b.setState({ status: "disabled" });
			return;
		}
		if (typeof e?.getFormalState == "function") {
			let t = g;
			b.setState({ status: "loading" }), Promise.resolve().then(() => h() && t === g ? e.getFormalState() : _()).then((e) => v(e, t)).then((e) => {
				t === g && x(h() ? e : { status: "disabled" });
			}).catch(() => {
				t === g && x(h() ? { status: "error" } : { status: "disabled" });
			});
		}
	}, b = u({
		formal: e,
		people: n,
		settings: r,
		apiTools: i,
		onPluginEnabledChange: a,
		onClose: () => {
			b.host.style.display = "none";
		}
	}), x = (e) => {
		if (b.setState(e), e?.status === "people_error") {
			let t = b.root?.querySelector?.(".view"), n = o.createElement?.("p");
			n && (n.className = "error", n.textContent = e.peopleError || "人物识别失败：暂时无法读取人物结果，请稍后重试。", t?.append?.(n));
		}
	};
	b.host.style.display = "none", o.body.append(b.host);
	let S = p || typeof o.createElement != "function" ? d({ onClick: y }) : { host: null };
	S.host && (S.host.style ||= {}, S.host.style.display = h() ? "" : "none", o.body.append(S.host)), f(y), o.addEventListener("keydown", (e) => {
		e.key === "Escape" && !b.host.hidden && b.close();
	});
	let C = (e) => {
		g += 1, S.host?.style && (S.host.style.display = e ? "" : "none"), e || x({ status: "disabled" });
	}, w = {
		...b,
		fab: S,
		setState: x,
		setEnabled: C,
		show: y
	};
	return b.host.__qqjInstance = w, w;
}
//#endregion
export { u as bootstrap };
