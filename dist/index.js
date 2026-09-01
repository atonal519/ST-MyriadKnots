//#region src/ui/panel.html?raw
var e = "qqj-panel-pos-v2", t = "qqj-panel-size-v2", n = (e) => Number.isFinite(Number(e)), r = (e, t, n) => Math.min(n, Math.max(t, e)), i = (e, t) => ({
	width: Math.max(0, Number(e) || 0),
	height: Math.max(0, Number(t) || 0)
});
function a(e, t, a = null) {
	let o = i(e, t), s = Math.max(0, o.width - 20), c = Math.max(0, o.height - 20), l = Math.min(320, s), u = Math.min(300, c), d = n(a?.width) && Number(a.width) > 0 ? Number(a.width) : 360, f = Math.min(600, Math.max(0, o.height * .85)), p = n(a?.height) && Number(a.height) > 0 ? Number(a.height) : f;
	return {
		width: r(d, l, s),
		height: r(p, u, c),
		minWidth: l,
		minHeight: u,
		maxWidth: s,
		maxHeight: c
	};
}
function o(e, t, a, o, s = null) {
	let c = i(e, t), l = Math.max(0, c.width - Math.max(0, Number(a) || 0)), u = Math.max(0, c.height - Math.max(0, Number(o) || 0)), d = Math.min(10, l), f = Math.max(d, l - 10), p = Math.min(10, u), m = Math.max(p, u - 10), h = r(l - 20, d, f), g = r(80, p, m);
	return {
		left: r(n(s?.left) ? Number(s.left) : h, d, f),
		top: r(n(s?.top) ? Number(s.top) : g, p, m)
	};
}
function s(e, t) {
	try {
		let n = JSON.parse(e?.getItem?.(t) || "null");
		return n && typeof n == "object" ? n : null;
	} catch {
		return null;
	}
}
function c(e) {
	let t = e?.getBoundingClientRect?.() || {};
	return {
		left: n(t.left) ? Number(t.left) : Number.parseFloat(e?.style?.left) || 0,
		top: n(t.top) ? Number(t.top) : Number.parseFloat(e?.style?.top) || 0,
		width: Number(t.width) > 0 ? Number(t.width) : Number(e?.offsetWidth) || Number.parseFloat(e?.style?.width) || 0,
		height: Number(t.height) > 0 ? Number(t.height) : Number(e?.offsetHeight) || Number.parseFloat(e?.style?.height) || 0
	};
}
function l({ panel: l, dragHandle: u, resizeHandle: d, storage: f = globalThis.localStorage, viewport: p = globalThis } = {}) {
	let m = null, h = null, g = null, _ = () => Number(p?.innerWidth) >= 641, v = () => i(p?.innerWidth, p?.innerHeight), y = (e, t) => {
		try {
			f?.setItem?.(e, JSON.stringify(t));
		} catch {}
	}, b = () => {
		h !== null && typeof p?.cancelAnimationFrame == "function" && p.cancelAnimationFrame(h), h = null, g = null;
	}, x = (e) => {
		if (!m || m.kind !== "drag") return;
		let t = c(l), n = v(), r = o(n.width, n.height, t.width, t.height, {
			left: m.left + e.x - m.startX,
			top: m.top + e.y - m.startY
		});
		l.style.left = `${r.left}px`, l.style.top = `${r.top}px`, l.style.right = "auto";
	}, S = (e) => {
		if (!m || m.kind !== "resize") return;
		let t = v(), n = Math.max(0, t.width - m.left - 10), i = Math.max(0, t.height - m.top - 10), a = Math.min(320, n), o = Math.min(300, i), s = r(m.width + e.x - m.startX, a, n), c = r(m.height + e.y - m.startY, o, i);
		l.style.width = `${s}px`, l.style.height = `${c}px`, l.style.maxWidth = `${n}px`, l.style.maxHeight = `${i}px`;
	}, C = () => {
		let e = g;
		h = null, g = null, e && (m?.kind === "drag" ? x(e) : m?.kind === "resize" && S(e));
	}, w = (e) => {
		g = e, h === null && (typeof p?.requestAnimationFrame == "function" ? h = p.requestAnimationFrame(C) : C());
	}, T = () => {
		g && (h !== null && typeof p?.cancelAnimationFrame == "function" && p.cancelAnimationFrame(h), C());
	}, E = (e) => {
		try {
			e?.surface?.releasePointerCapture?.(e.pointerId);
		} catch {}
	}, D = ({ persist: n = !1 } = {}) => {
		let r = m;
		if (!r || (n && r.kind !== "pending-drag" ? T() : b(), m = null, l?.classList?.remove?.("is-gesturing"), l.style.willChange = "", E(r), !n)) return;
		let i = c(l);
		r.kind === "drag" && y(e, {
			left: i.left,
			top: i.top
		}), r.kind === "resize" && y(t, {
			width: i.width,
			height: i.height
		});
	}, O = (e, t) => {
		try {
			e?.setPointerCapture?.(t.pointerId);
		} catch {}
	}, k = (e) => e?.button === void 0 || e.button === 0, A = (e) => !!e?.closest?.("button,a,input,select,textarea,[contenteditable]"), j = (e) => ({
		x: Number(e?.clientX) || 0,
		y: Number(e?.clientY) || 0
	}), M = (e) => !m || e?.pointerId === void 0 || e.pointerId === m.pointerId, N = (e) => {
		if (!_() || !k(e) || A(e?.target)) return;
		let t = j(e), n = c(l);
		m = {
			kind: "pending-drag",
			surface: u,
			pointerId: e?.pointerId,
			startX: t.x,
			startY: t.y,
			left: n.left,
			top: n.top,
			width: n.width,
			height: n.height
		}, O(u, e);
	}, P = (e) => {
		if (!m || !["pending-drag", "drag"].includes(m.kind) || !M(e)) return;
		if (e?.pointerType === "mouse" && e.buttons === 0) {
			D();
			return;
		}
		let t = j(e);
		if (m.kind === "pending-drag") {
			if (Math.hypot(t.x - m.startX, t.y - m.startY) <= 5) return;
			m.kind = "drag", l.style.left = `${m.left}px`, l.style.top = `${m.top}px`, l.style.right = "auto", l.style.willChange = "left, top", l?.classList?.add?.("is-gesturing");
		}
		e?.preventDefault?.(), w(t);
	}, F = (e) => {
		if (!_() || !k(e)) return;
		e?.preventDefault?.(), e?.stopPropagation?.();
		let t = j(e), n = c(l), r = v(), i = o(r.width, r.height, n.width, n.height, n);
		l.style.left = `${i.left}px`, l.style.top = `${i.top}px`, l.style.right = "auto", m = {
			kind: "resize",
			surface: d,
			pointerId: e?.pointerId,
			startX: t.x,
			startY: t.y,
			left: i.left,
			top: i.top,
			width: n.width,
			height: n.height
		}, l.style.willChange = "width, height", l?.classList?.add?.("is-gesturing"), O(d, e);
	}, I = (e) => {
		if (!(!m || m.kind !== "resize" || !M(e))) {
			if (e?.pointerType === "mouse" && e.buttons === 0) {
				D();
				return;
			}
			e?.preventDefault?.(), w(j(e));
		}
	}, L = (e) => {
		m && M(e) && D({ persist: !0 });
	}, R = (e) => {
		m && M(e) && D();
	}, z = () => {
		if (D(), !l) return;
		if (!_()) {
			for (let e of [
				"left",
				"top",
				"right",
				"bottom",
				"width",
				"height",
				"maxWidth",
				"maxHeight",
				"transform",
				"willChange"
			]) l.style[e] = "";
			return;
		}
		let r = v(), i = s(f, t), c = a(r.width, r.height, i);
		l.style.width = `${c.width}px`, l.style.height = `${c.height}px`, l.style.maxWidth = `${c.maxWidth}px`, l.style.maxHeight = `${c.maxHeight}px`, l.style.bottom = "auto", l.style.transform = "none";
		let u = s(f, e), d = o(r.width, r.height, c.width, c.height, u);
		l.style.top = `${d.top}px`, u && n(u.left) && n(u.top) ? (l.style.left = `${d.left}px`, l.style.right = "auto") : (l.style.left = "", l.style.right = `${Math.max(0, r.width - d.left - c.width)}px`);
	}, B = () => z(), ee = [
		[
			u,
			"pointerdown",
			N
		],
		[
			u,
			"pointermove",
			P
		],
		[
			u,
			"pointerup",
			L
		],
		[
			u,
			"pointercancel",
			R
		],
		[
			u,
			"lostpointercapture",
			R
		],
		[
			d,
			"pointerdown",
			F
		],
		[
			d,
			"pointermove",
			I
		],
		[
			d,
			"pointerup",
			L
		],
		[
			d,
			"pointercancel",
			R
		],
		[
			d,
			"lostpointercapture",
			R
		],
		[
			p,
			"resize",
			B
		],
		[
			p,
			"orientationchange",
			B
		]
	];
	for (let [e, t, n] of ee) e?.addEventListener?.(t, n);
	return z(), {
		restore: z,
		cancelGesture: () => D(),
		destroy() {
			D();
			for (let [e, t, n] of ee) e?.removeEventListener?.(t, n);
		}
	};
}
//#endregion
//#region src/ui/panel.js
var u = [
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
], d = /* @__PURE__ */ new Set([
	"API 请求超时，请稍后重试",
	"API 认证失败，请检查配置后重试",
	"API 请求过于频繁，请稍后重试",
	"人物识别结果格式无效",
	"人物识别失败，请稍后重试",
	"人物识别尚未完成，请重试",
	"人物显示名存在未完成冲突，请稍后重试",
	"人物改名恢复发生冲突，请稍后重试",
	"档案发生冲突，请稍后重试",
	"操作失败，原人物列表已保留"
]), f = (e) => {
	let t = typeof e == "string" ? e.trim() : "";
	return d.has(t) ? t : "人物识别失败，请稍后重试";
};
function p({ formal: e, people: t, sourceCatalog: n, settings: r, apiTools: i, loadState: a, initialRelations: o, reviewActions: s, onPluginEnabledChange: c, archiveV2InitializationView: d, onClose: p } = {}) {
	let m = document.createElement("div");
	m.id = "qqj-panel-host", m.hidden = !0, m.setAttribute("aria-hidden", "true"), m.style?.setProperty?.("text-shadow", "none", "important"), m.style?.setProperty?.("isolation", "isolate", "important"), m.style?.setProperty?.("z-index", "4000", "important");
	let h = m.attachShadow({ mode: "open" });
	h.innerHTML = "<style>:host{--panel:#fbfcfe;--panel-2:#f1f4f9;--ink:#23262d;--soft:#6a7079;--faint:#a2a8b2;--line:#23262d1a;--crimson:#b23a48;--u:#3e6b8c;--c:#b0784a;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif;display:block}*{box-sizing:border-box}.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;animation:.35s both in;overflow:hidden;box-shadow:0 24px 70px #23262d2e,0 4px 14px #23262d12}.panel.is-gesturing{-webkit-user-select:none;user-select:none}.topbar{touch-action:none;cursor:grab;-webkit-user-select:none;user-select:none;align-items:center;gap:14px;padding:15px 18px 0;display:flex}.brand{align-items:baseline;gap:7px;display:flex}.mark,.tab,.empty h2,.choice strong,.module b{font-family:宋体,Songti SC,SimSun,serif}.mark{letter-spacing:.06em;font-size:17px;font-weight:700}.em{color:var(--crimson)}.sub{color:var(--faint);letter-spacing:.22em;font:10px ui-monospace,monospace}.close{color:var(--soft);cursor:pointer;background:0 0;border:0;width:28px;height:28px;margin-left:auto;font-size:24px;line-height:1}.close:focus-visible,.tab:focus-visible,.choice:focus-visible,.init:focus-visible,.person-action:focus-visible,summary:focus-visible{outline:2px solid var(--crimson);outline-offset:2px}.tabs{border-bottom:1px solid var(--line);gap:2px;margin-top:8px;padding:6px 12px 0 14px;display:flex}.tab{color:var(--faint);cursor:pointer;background:0 0;border:0;padding:8px 12px 12px;font-size:14px;position:relative}.tab.active{color:var(--ink);font-weight:600}.tab.active:after{content:\"\";background:linear-gradient(var(--crimson),transparent);width:2px;height:12px;position:absolute;bottom:-1px;left:50%;transform:translate(-50%)}.body{max-height:74vh;padding:16px 18px 20px;overflow:auto}.status-line{color:var(--soft);align-items:center;gap:7px;min-height:18px;font-size:11px;display:flex}.status-dot{background:var(--faint);border-radius:50%;width:7px;height:7px}.status-dot.ready{background:#5b8c6e}.status-dot.warn{background:var(--crimson)}.status-meta{color:var(--faint);margin-left:auto;font:10px ui-monospace,monospace}.view{padding-top:10px}.empty{text-align:center;border-top:1px solid var(--line);margin-top:8px;padding:30px 8px 24px}.empty h2{margin:5px 0 8px;font-size:19px}.empty p{color:var(--soft);max-width:340px;margin:0 auto;font-size:12px;line-height:1.7}.eyebrow{letter-spacing:.12em;color:var(--crimson);font:10px ui-monospace,monospace}.choices{grid-template-columns:1fr 1fr;gap:8px;margin:20px 0 14px;display:grid}.choice{text-align:left;border:1px solid var(--line);background:var(--panel-2);cursor:pointer;color:var(--ink);border-radius:9px;padding:13px 12px;position:relative}.choice:hover,.choice.selected{background:#b23a480f;border-color:#b23a4873}.choice input{opacity:0;position:absolute}.choice strong{margin-bottom:4px;font-size:14px;display:block}.choice span{color:var(--soft);font-size:10.5px;line-height:1.5;display:block}.init{border:1px solid var(--crimson);background:var(--crimson);color:#fff;cursor:pointer;border-radius:8px;padding:8px 15px;font-size:12px}.init:disabled{opacity:.45;cursor:not-allowed}.people-list{text-align:left;gap:8px;margin-top:18px;display:grid}.people-list h3{color:var(--soft);margin:0 0 2px;font-size:12px;font-weight:600}.person-card{padding:12px 13px}.person-actions{flex-wrap:wrap;gap:6px;margin-top:10px;display:flex}.person-action{border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer;border-radius:7px;padding:5px 9px;font-size:11px}.person-action:hover{color:var(--crimson);border-color:#b23a4873}.shelved-people{text-align:left;border-top:1px solid var(--line);margin-top:18px;padding-top:12px}.shelved-people summary{cursor:pointer;color:var(--soft);font-size:12px}.modules{grid-template-columns:1fr 1fr;gap:9px;margin-top:15px;display:grid}.module{border:1px solid var(--line);background:linear-gradient(#b23a480a,#0000);border-radius:10px;padding:15px 13px}.module b{font-size:14px}.module small{color:var(--faint);margin-top:7px;font-size:10.5px;display:block}.footer{border-top:1px solid var(--line);background:var(--panel-2);align-items:center;gap:12px;padding:11px 18px;display:flex}.legend{color:var(--faint);gap:10px;font-size:10px;display:flex}.legend span{align-items:center;gap:3px;display:inline-flex}.legend i{border-radius:2px;width:7px;height:7px}.u{background:var(--u)}.c{background:var(--c)}.crimson{background:var(--crimson)}.foot-note{color:var(--faint);margin-left:auto;font-size:10px}@keyframes in{0%{opacity:0}to{opacity:1}}@media (width<=540px){.panel{border-radius:14px;min-height:0;box-shadow:0 15px 45px #23262d2e}.body{max-height:none}.choices,.modules{grid-template-columns:1fr}}@media (prefers-reduced-motion:reduce){*,:before,:after{transition-duration:.01ms!important;animation-duration:.01ms!important}}:host{--success:#3f7356;--field:#fff}.settings-btn{color:var(--soft);cursor:pointer;background:0 0;border:1px solid #0000;line-height:1}.panel-resize-handle{width:24px;height:24px;color:var(--faint);cursor:nwse-resize;touch-action:none;background:0 0;border:0;border-radius:7px 0 10px;justify-content:center;align-items:center;margin:0;padding:0;line-height:1;display:inline-flex;position:absolute;bottom:0;right:0}.panel-resize-handle:hover{color:var(--crimson);background:#b23a4812}.panel-resize-handle:focus-visible{outline:2px solid var(--crimson);outline-offset:2px}.settings-btn:hover{color:var(--crimson);background:#b23a4812;border-color:#b23a4824}.settings-btn:focus-visible,.open-settings:focus-visible,.settings-view button:focus-visible,.settings-view input:focus-visible,.settings-view select:focus-visible,.settings-view textarea:focus-visible{outline:2px solid var(--crimson);outline-offset:2px}.open-settings{border:1px solid var(--crimson);color:var(--crimson);cursor:pointer;background:0 0;border-radius:8px;margin-top:18px;padding:8px 15px;font-size:12px}.settings-view{text-align:left;padding:10px 2px 4px}.master-control{border-bottom:1px solid var(--line);justify-content:space-between;align-items:center;gap:12px;min-height:40px;padding:2px 2px 10px;display:flex}.master-label{letter-spacing:.04em;color:var(--ink);font:700 12px 宋体,Songti SC,SimSun,serif}.master-switch{border:1px solid var(--line);background:var(--panel-2);min-height:30px;color:var(--soft);white-space:nowrap;cursor:pointer;border-radius:15px;align-items:center;gap:7px;padding:5px 9px;font-size:10.5px;display:flex}.master-switch input,.check-field input{accent-color:var(--crimson)}.settings-drawer{border:1px solid var(--line);background:var(--panel-2);border-radius:11px;margin-top:12px;overflow:hidden}.settings-drawer>summary,.settings-subdrawer>summary{min-height:44px;color:var(--ink);cursor:pointer;-webkit-user-select:none;user-select:none;align-items:center;padding:10px 38px 10px 13px;list-style:none;display:flex;position:relative}.settings-drawer>summary::-webkit-details-marker{display:none}.settings-subdrawer>summary::-webkit-details-marker{display:none}.settings-drawer>summary{letter-spacing:.02em;font:700 14px 宋体,Songti SC,SimSun,serif}.settings-drawer>summary:after,.settings-subdrawer>summary:after{content:\"\";border-right:1.5px solid var(--soft);border-bottom:1.5px solid var(--soft);width:7px;height:7px;transition:transform .18s;position:absolute;top:50%;right:15px;transform:translateY(-70%)rotate(45deg)}.settings-drawer[open]>summary:after,.settings-subdrawer[open]>summary:after{transform:translateY(-30%)rotate(225deg)}.settings-drawer[open]>summary{border-bottom:1px solid var(--line)}.settings-drawer-body{padding:10px}.settings-subdrawer{border:1px solid var(--line);background:var(--panel);border-radius:9px;overflow:hidden}.settings-subdrawer>summary{min-height:40px;padding-top:8px;padding-bottom:8px;font-size:12px;font-weight:700}.settings-subdrawer[open]>summary{border-bottom:1px solid var(--line);color:var(--crimson)}.settings-section{background:0 0;border:0;border-radius:0;gap:10px;margin:0;padding:13px;display:grid}.field{color:var(--soft);gap:5px;font-size:10.5px;display:grid}.field input,.field select,.field textarea{border:1px solid var(--line);background:var(--field);width:100%;min-width:0;color:var(--ink);border-radius:7px;padding:8px 9px;font:12px -apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif}.field textarea{resize:vertical;line-height:1.5}.key-row,.model-row{grid-template-columns:minmax(0,1fr) auto auto;gap:6px;display:grid}.model-row{grid-template-columns:minmax(0,1fr) auto}.key-row button,.model-row button,.preset-actions button,.model-results button,.secondary-action,.primary-action{border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer;border-radius:7px;padding:7px 9px;font-size:10.5px}.preset-actions{flex-wrap:wrap;gap:6px;margin-top:-3px;display:flex}.preset-actions button{padding:5px 8px}.advanced{border-top:1px solid var(--line);padding-top:9px}.advanced summary{cursor:pointer;color:var(--soft);font-size:11px}.advanced[open] summary{margin-bottom:10px}.advanced-row{grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:10px;margin-top:9px;display:grid}.check-field{min-height:34px;color:var(--soft);align-items:center;gap:6px;font-size:11px;display:flex}.settings-actions{border-top:1px solid var(--line);grid-template-columns:1fr 1.35fr;gap:8px;margin-top:4px;padding-top:12px;display:grid}.secondary-action,.primary-action{min-height:36px;font-size:12px}.primary-action{border-color:var(--crimson);background:var(--crimson);color:#fff}.settings-view button:disabled{opacity:.5;cursor:wait}.settings-result{min-height:18px;color:var(--soft);margin:8px 2px 0;font-size:10.5px;line-height:1.5}.settings-result.success{color:var(--success)}.settings-result.error{color:var(--crimson)}.model-results{flex-wrap:wrap;gap:5px;max-height:140px;display:flex;overflow:auto}.model-results[hidden]{display:none}.model-results button{text-overflow:ellipsis;white-space:nowrap;max-width:100%;overflow:hidden}@media (width<=540px){.settings-view{padding-bottom:4px}.settings-drawer-body{padding:8px}.settings-section{padding:11px}.advanced-row{grid-template-columns:1fr}.check-field{min-height:auto}.key-row{grid-template-columns:minmax(0,1fr) auto}.key-row [data-action=key-clear]{grid-column:2}.settings-actions{background:0 0;padding-top:11px;position:static}}.people-page{text-align:left;gap:13px;display:grid}.generation-banner{border:1px solid #b23a4833;border-left:2px solid var(--crimson);background:var(--panel-2);border-radius:0 9px 9px 0;padding:13px 14px 13px 17px;position:relative}.generation-banner h3{margin:0;font:700 14px 宋体,Songti SC,SimSun,serif}.generation-banner p{color:var(--soft);margin:5px 0 0;font-size:11px;line-height:1.6}.generation-banner .generation-hint{color:var(--crimson)}.generation-actions{flex-wrap:wrap;gap:7px;margin-top:10px;display:flex}.generation-actions button{min-height:32px;padding:6px 10px}.generation-banner .source-change-summary{color:var(--ink);font-weight:600}.profile-rail-shell{grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:7px;min-width:0;display:grid}.profile-switcher{overscroll-behavior-inline:contain;scrollbar-width:thin;gap:7px;min-width:0;padding:2px 0 5px;display:flex;overflow-x:auto}.profile-tab{border:1px solid var(--line);background:var(--panel);min-height:34px;color:var(--soft);cursor:pointer;border-radius:8px;flex:none;align-items:center;gap:6px;padding:6px 10px;font-size:11px;display:inline-flex;position:relative}.profile-tab.active{color:var(--ink);background:#b23a480e;border-color:#b23a4857}.profile-tab-name{text-overflow:ellipsis;white-space:nowrap;max-width:150px;overflow:hidden}.profile-update-dot{background:var(--crimson);pointer-events:none;border-radius:50%;width:6px;height:6px;position:absolute;top:4px;right:4px}.profile-tools{grid-template-columns:repeat(2,54px);gap:7px;padding:2px 0 5px;display:grid}.profile-tool{border:1px solid var(--line);background:var(--panel);width:54px;min-height:34px;color:var(--soft);white-space:nowrap;cursor:pointer;border-radius:8px;justify-content:center;align-items:center;padding:6px;font-size:11px;font-weight:600;display:inline-flex}.profile-tool.active{color:var(--ink);background:#b23a480e;border-color:#b23a4857}.profile-tab:focus-visible,.profile-tool:focus-visible,.more-person:focus-visible,.pending-actions button:focus-visible,.people-pool>summary:focus-visible,.basic-info button:focus-visible,.basic-info input:focus-visible,.basic-info textarea:focus-visible,.dynamic-info button:focus-visible,.dynamic-info textarea:focus-visible{outline:2px solid var(--crimson);outline-offset:2px}.subject-tag{border-radius:5px;justify-content:center;align-items:center;min-width:22px;height:20px;padding:0 5px;font:700 10px ui-monospace,monospace;display:inline-flex}.tag-u{color:var(--u);background:#3e6b8c1c}.tag-c{color:var(--c);background:#b0784a1f}.dossier-card{border-left:2px solid var(--crimson);gap:11px;padding-left:13px;display:grid}.profile-summary{align-items:flex-start;gap:9px;padding:3px 1px 1px;display:flex}.profile-summary h2{margin:0;font:700 18px 宋体,Songti SC,SimSun,serif}.profile-summary p{color:var(--soft);margin:3px 0 0;font-size:10.5px;line-height:1.5}.profile-layer{border:1px solid var(--line);background:var(--panel);border-radius:9px;padding:12px}.profile-layer.facts{background:#6a707909}.profile-layer.interpretations{background:#3e6b8c09}.profile-layer-head{border-bottom:1px solid var(--line);align-items:baseline;gap:7px;padding-bottom:8px;display:flex}.profile-layer-head h3,.section-heading h3{margin:0;font:700 13px 宋体,Songti SC,SimSun,serif}.profile-layer-head p{color:var(--faint);margin:0;font-size:9.5px;line-height:1.4}.fact-item{border-bottom:1px solid var(--line);padding:9px 0}.fact-item:last-child{border-bottom:0;padding-bottom:1px}.fact-value,.pending-value{color:var(--ink);overflow-wrap:anywhere;margin:0;font-size:12px;line-height:1.65}.fact-source,.fact-target{color:var(--faint);margin:5px 7px 0 0;font:9.5px ui-monospace,monospace;display:inline-block}.fact-target{color:var(--soft)}.layer-empty,.pool-empty{color:var(--soft);margin:9px 0 1px;font-size:11px;line-height:1.6}.pending-section{gap:8px;display:grid}.section-heading{align-items:baseline;gap:7px;display:flex}.section-heading span{color:var(--faint);font-size:9.5px}.pending-card{border:1px solid #b23a482e;border-left:2px solid var(--crimson);background:var(--panel);border-radius:0 9px 9px 0;padding:12px 12px 12px 14px}.pending-reason{color:var(--soft);overflow-wrap:anywhere;margin:6px 0 0;font-size:10.5px;line-height:1.55}.pending-meta{color:var(--faint);flex-wrap:wrap;gap:5px 9px;margin-top:8px;font:9.5px ui-monospace,monospace;display:flex}.pending-actions{gap:7px;margin-top:10px;display:flex}.pending-actions button{min-height:32px;padding:6px 10px}.pending-card[data-busy=true]{opacity:.72}.review-error{margin:0}.people-pool{border-top:1px solid var(--line);padding-top:11px}.people-pool>summary{cursor:pointer;color:var(--soft);font:600 12px 宋体,Songti SC,SimSun,serif}.people-pool[open]>summary{color:var(--ink)}.pool-intro{color:var(--soft);margin:8px 0 0;font-size:10.5px;line-height:1.6}.people-pool .people-list{margin-top:12px}.people-pool .person-card{background:var(--panel-2)}.people-content{border:1px solid var(--line);background:var(--panel);border-radius:9px;gap:11px;min-width:0;padding:12px;display:grid}.content-heading{border-bottom:1px solid var(--line);gap:4px;padding-bottom:9px;display:grid}.content-heading h2{margin:0;font:700 15px 宋体,Songti SC,SimSun,serif}.content-heading p{color:var(--soft);margin:0;font-size:10.5px;line-height:1.6}.more-list{gap:7px;display:grid}.more-person{border:1px solid var(--line);background:var(--panel-2);width:100%;min-width:0;min-height:36px;color:var(--ink);text-align:left;cursor:pointer;border-radius:8px;align-items:center;gap:7px;padding:7px 9px;font-size:11px;display:flex}.more-person:hover{color:var(--crimson);border-color:#b23a4857}.fate-book-view .people-list{margin-top:2px}.fate-book-view .person-card{background:var(--panel-2)}.fate-person-head{justify-content:space-between;align-items:flex-start;gap:9px;display:flex}.fate-person-name{font:700 13px 宋体,Songti SC,SimSun,serif;display:block}.fate-person-state{margin-top:4px}.fate-person-rename{grid-template-columns:minmax(0,1fr) auto;gap:6px;margin-top:10px;display:grid}.fate-person-rename input{border:1px solid var(--line);background:var(--field);width:100%;min-width:0;color:var(--ink);border-radius:7px;padding:6px 8px;font:11px -apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif}.fate-person-rename input:focus-visible{outline:2px solid var(--crimson);outline-offset:2px}.source-catalog-page{text-align:left;gap:12px;display:grid}.source-catalog-empty .source-start,.source-catalog-empty .people-retry{margin-top:16px}.source-catalog{gap:12px;display:grid}.source-list{gap:7px;display:grid}.source-row{border:1px solid var(--line);background:var(--panel);cursor:pointer;border-radius:8px;align-items:flex-start;gap:9px;padding:9px 10px;display:flex}.source-row input{accent-color:var(--crimson);margin-top:2px}.source-row.is-disabled{opacity:.55;cursor:not-allowed}.source-copy{gap:3px;min-width:0;display:grid}.source-copy b{overflow-wrap:anywhere;font-size:11.5px;line-height:1.45}.source-copy small{color:var(--soft);font-size:9.5px}.source-confirm{width:100%}.basic-info{border:1px solid var(--line);background:linear-gradient(145deg,#b0784a0f,#0000);border-radius:9px;gap:11px;padding:12px;display:grid}.basic-info-head{justify-content:space-between;align-items:flex-start;gap:10px;display:flex}.basic-info-head h3{margin:0;font:700 13px 宋体,Songti SC,SimSun,serif}.basic-info-head p{color:var(--soft);margin:4px 0 0;font-size:9.5px;line-height:1.5}.basic-info-actions,.basic-edit-actions{flex-wrap:wrap;gap:6px;display:flex}.basic-info-actions{justify-content:flex-end}.basic-fields,.basic-row{gap:8px;min-width:0;max-width:100%;display:grid}.basic-row-three{grid-template-columns:repeat(3,minmax(0,1fr))}.basic-row-two{grid-template-columns:repeat(2,minmax(0,1fr))}.basic-row-one{grid-template-columns:minmax(0,1fr)}.basic-field{border:1px solid var(--line);background:var(--panel);overflow-wrap:anywhere;border-radius:7px;min-width:0;max-width:100%;padding:8px 9px;overflow:hidden}.basic-label{color:var(--soft);overflow-wrap:anywhere;margin-bottom:4px;font-size:9.5px;display:block}.basic-value{overflow-wrap:anywhere;margin:0;font-size:11.5px;line-height:1.55}.basic-value.missing{color:var(--faint)}.basic-source{color:var(--faint);overflow-wrap:anywhere;margin-top:5px;font-size:9px;line-height:1.4;display:block}.basic-field input,.basic-field textarea{border:1px solid var(--line);background:var(--field);width:100%;min-width:0;max-width:100%;color:var(--ink);border-radius:6px;padding:7px 8px;font:11.5px -apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif;display:block}.basic-field textarea{resize:vertical;min-height:64px;line-height:1.5}.basic-message{color:var(--soft);margin:0;font-size:10.5px;line-height:1.5}.basic-message.success{color:var(--success)}.basic-message.error{color:var(--crimson)}.dynamic-info{background:linear-gradient(145deg,#3e6b8c0f,#0000);border:1px solid #3e6b8c2e;border-radius:9px;gap:11px;min-width:0;max-width:100%;padding:12px;display:grid}.dynamic-info-head{justify-content:space-between;align-items:flex-start;gap:10px;min-width:0;display:flex}.dynamic-info-head h3{margin:0;font:700 13px 宋体,Songti SC,SimSun,serif}.dynamic-info-head p{color:var(--soft);margin:4px 0 0;font-size:9.5px;line-height:1.5}.dynamic-info-actions,.dynamic-edit-actions{flex-wrap:wrap;gap:6px;display:flex}.dynamic-info-actions{justify-content:flex-end}.dynamic-fields,.dynamic-row{gap:8px;min-width:0;max-width:100%;display:grid}.dynamic-row-one{grid-template-columns:minmax(0,1fr)}.dynamic-row-two{grid-template-columns:repeat(2,minmax(0,1fr))}.dynamic-field{border:1px solid var(--line);background:var(--panel);overflow-wrap:anywhere;border-radius:7px;min-width:0;max-width:100%;padding:8px 9px;overflow:hidden}.dynamic-label{color:var(--soft);overflow-wrap:anywhere;margin-bottom:4px;font-size:9.5px;display:block}.dynamic-value{overflow-wrap:anywhere;margin:0;font-size:11.5px;line-height:1.55}.dynamic-value.missing{color:var(--faint)}.dynamic-source{color:var(--faint);overflow-wrap:anywhere;margin-top:5px;font-size:9px;line-height:1.4;display:block}.dynamic-field textarea{border:1px solid var(--line);background:var(--field);width:100%;min-width:0;max-width:100%;min-height:64px;color:var(--ink);resize:vertical;border-radius:6px;padding:7px 8px;font:11.5px/1.5 -apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif;display:block}.dynamic-message{color:var(--soft);overflow-wrap:anywhere;margin:0;font-size:10.5px;line-height:1.5}.dynamic-message.success{color:var(--success)}.dynamic-message.error{color:var(--crimson)}@media (width<=390px){.body{padding-left:14px;padding-right:14px}.dossier-card{padding-left:10px}.profile-layer{padding:10px}.pending-actions,.generation-actions{grid-template-columns:1fr;display:grid}.pending-actions button,.generation-actions button{width:100%}.profile-layer-head,.section-heading{gap:3px;display:grid}.basic-info{padding:10px}.basic-info-head{display:grid}.basic-info-actions,.basic-edit-actions{grid-template-columns:1fr;width:100%;display:grid}.basic-info-actions button,.basic-edit-actions button{width:100%}.basic-fields,.basic-row{gap:5px}.basic-field{padding:7px 6px}.basic-label{font-size:9px}.basic-value,.basic-field input,.basic-field textarea{font-size:10.5px}.dynamic-info{padding:10px}.dynamic-info-head{display:grid}.dynamic-info-actions,.dynamic-edit-actions{grid-template-columns:1fr;width:100%;display:grid}.dynamic-info-actions button,.dynamic-edit-actions button{width:100%}.dynamic-fields,.dynamic-row{gap:5px}.dynamic-row-two{grid-template-columns:minmax(0,1fr)}.dynamic-field{padding:7px 6px}.dynamic-label{font-size:9px}.dynamic-value,.dynamic-field textarea{font-size:10.5px}.profile-rail-shell,.profile-switcher{gap:5px}.profile-tools{grid-template-columns:repeat(2,50px);gap:5px}.profile-tool{width:50px}.profile-tab-name{max-width:118px}.people-content{padding:10px}.basic-row-three,.fate-person-rename{grid-template-columns:minmax(0,1fr)}.fate-person-rename .person-action{width:100%}}@media (width<=640px){.topbar{touch-action:auto;cursor:default;-webkit-user-select:auto;user-select:auto}.panel-resize-handle{display:none}}:host{text-shadow:none!important;isolation:isolate!important}.body::-webkit-scrollbar{width:4px;height:4px}.body::-webkit-scrollbar-track{background:0 0}.body::-webkit-scrollbar-thumb{background:#6a707947;border-radius:999px;min-height:32px}.body::-webkit-scrollbar-thumb:hover{background:#6a70797a}.body::-webkit-scrollbar-button{background:0 0!important;border:0!important;width:0!important;min-width:0!important;height:0!important;min-height:0!important;display:none!important}.body::-webkit-scrollbar-button:single-button{background:0 0!important;border:0!important;width:0!important;min-width:0!important;height:0!important;min-height:0!important;display:none!important}.body::-webkit-scrollbar-button:vertical:decrement{background:0 0!important;border:0!important;width:0!important;min-width:0!important;height:0!important;min-height:0!important;display:none!important}.body::-webkit-scrollbar-button:vertical:increment{background:0 0!important;border:0!important;width:0!important;min-width:0!important;height:0!important;min-height:0!important;display:none!important}.body::-webkit-scrollbar-button:start:decrement{background:0 0!important;border:0!important;width:0!important;min-width:0!important;height:0!important;min-height:0!important;display:none!important}.body::-webkit-scrollbar-button:end:increment{background:0 0!important;border:0!important;width:0!important;min-width:0!important;height:0!important;min-height:0!important;display:none!important}.topbar .settings-btn,.topbar .close{width:30px;height:30px;color:var(--soft);background:0 0;border:1px solid #0000;border-radius:8px;flex:0 0 30px;place-items:center;padding:0;line-height:1;transition:color .16s,background-color .16s,border-color .16s;display:grid}.topbar .settings-btn{margin-left:auto;margin-right:0}.topbar .close{margin-left:0}.topbar .settings-btn svg,.topbar .close svg{fill:none;stroke:currentColor;stroke-width:1.8px;stroke-linecap:round;stroke-linejoin:round;width:16px;height:16px;display:block}.topbar .settings-btn:hover,.topbar .close:hover{color:var(--crimson);background:#b23a4812;border-color:#b23a4824}.resize-grip{width:13px;height:13px;display:block;position:relative}.resize-grip:before,.resize-grip:after{content:\"\";border-bottom:1.5px solid;border-right:1.5px solid;position:absolute;bottom:1px;right:1px}.resize-grip:before{width:10px;height:10px}.resize-grip:after{width:5px;height:5px}:host{position:fixed;inset:0;z-index:4000;width:100dvw;height:100dvh;pointer-events:none;background:transparent;text-shadow:none!important;isolation:isolate}:host([hidden]){display:none!important;pointer-events:none!important}.panel{position:fixed;top:80px;right:20px;width:360px;height:min(600px,85dvh);max-width:calc(100dvw - 40px);max-height:85dvh;display:grid;grid-template-rows:auto auto minmax(0,1fr) 24px;pointer-events:auto}.body{min-height:0;max-height:none;overflow-y:auto;scrollbar-gutter:stable}.tabs{min-width:0;overflow:hidden;flex-wrap:nowrap}.tab{flex:0 0 auto}@media(max-width:640px){.panel{top:calc(20px + env(safe-area-inset-top,0px));left:50%;right:auto;bottom:auto;transform:translateX(-50%);width:calc(100dvw - 20px);max-width:calc(100dvw - 20px);height:calc(100dvh - 40px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));max-height:calc(100dvh - 40px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));min-height:0;border-radius:14px;grid-template-rows:auto auto minmax(0,1fr)}.body{min-height:0;overflow-y:auto;scrollbar-gutter:stable}.tabs{overflow-x:auto;overflow-y:hidden;scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}.choices{grid-template-columns:1fr}.tab{padding-left:9px;padding-right:9px}}</style><section class=\"panel\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"qqj-dialog-title\">\n<header class=\"topbar\"><div class=\"brand\"><span class=\"mark\" id=\"qqj-dialog-title\">千<span class=\"em\">千</span>结</span><span class=\"sub\">QIANQIANJIE</span></div><button class=\"settings-btn\" type=\"button\" aria-label=\"打开千千结设置\" title=\"设置\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"3\"></circle><path d=\"M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.6v-.1A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.1 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.3V9.6h.1A1.7 1.7 0 0 0 4.1 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06L6.56 3.7l.06.06A1.7 1.7 0 0 0 8.5 4.1a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2.3h4v.1A1.7 1.7 0 0 0 15 4.1a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 8.5a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4h-.1A1.7 1.7 0 0 0 19.4 15Z\"></path></svg></button><button class=\"icon-btn close\" type=\"button\" aria-label=\"关闭\"><svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M6 6l12 12M18 6 6 18\"></path></svg></button></header>\n<nav class=\"tabs\" role=\"tablist\" aria-label=\"档案模块\"><button class=\"tab active\" role=\"tab\" aria-selected=\"true\" data-tab=\"people\">千人</button><button class=\"tab\" role=\"tab\" aria-selected=\"false\" data-tab=\"bonds\">双丝网</button><button class=\"tab\" role=\"tab\" aria-selected=\"false\" data-tab=\"milestones\">千事</button><button class=\"tab\" role=\"tab\" aria-selected=\"false\" data-tab=\"knots\">千结</button></nav>\n<main class=\"body\"><div class=\"status-line\"><span class=\"status-dot\"></span><span class=\"status-label\">正在读取当前聊天</span><span class=\"status-meta\"></span></div><div class=\"view\"></div></main>\n<button class=\"panel-resize-handle\" type=\"button\" aria-label=\"调整千千结面板大小\" title=\"拖动调整面板大小\"><span class=\"resize-grip\" aria-hidden=\"true\"></span></button>\n</section>\n";
	let g = h.querySelector(".view"), _ = h.querySelector(".status-label"), v = h.querySelector(".status-meta"), y = h.querySelector(".status-dot");
	if (d !== void 0 && [
		"mount",
		"activate",
		"deactivate"
	].some((e) => typeof d?.[e] != "function")) throw TypeError("archiveV2InitializationView 必须提供 mount、activate 和 deactivate");
	let b = { status: "loading" }, x = null, S = !1, C = null, w = "people", T = "people", E = "", D = 0, O = null, k = !1, A = "", j = 0, M = 0, N = null, P = !1, F = !1, I = null, L = !1, R = !1, z = null, B = !1, ee = "summary", V = null, H = /* @__PURE__ */ new Map(), te = /* @__PURE__ */ new Map(), ne = null, re = null, ie = !1, ae = null, oe = null, se = "legacy", ce = !1, le = 0, ue = !1, de = /* @__PURE__ */ new Set([
		"loading",
		"reading_sources",
		"waiting_ai",
		"saving_people",
		"preparing",
		"renaming"
	]), fe = () => [...h.querySelectorAll("button,input,select,textarea,summary,[href],[tabindex]:not([tabindex=\"-1\"])")].filter((e) => !e.disabled && e.offsetParent !== null), pe = () => {
		M += 1, F = !1, R = !1, P = !1, L = !1, I = null, z = null;
	}, U = ({ releaseContent: e = !1 } = {}) => {
		if (le += 1, ce) {
			ce = !1;
			try {
				d?.deactivate();
			} catch {}
		}
		e && (se = "legacy", ue = !1);
	}, W = () => {
		try {
			return !!d && r?.isEnabled?.() !== !1 && !m.hidden && w !== "settings" && T === "people";
		} catch {
			return !1;
		}
	}, me = () => {
		_.textContent = "千人档案暂不可用", v.textContent = "INIT_VIEW_FAILED", y.className = "status-dot warn";
	}, he = () => {
		if (!W()) return Promise.resolve(!1);
		if (ue = !1, se !== "archive-v2") {
			U({ releaseContent: !0 });
			try {
				g.replaceChildren(), d.mount(g);
			} catch {
				se = "legacy";
				try {
					$(b);
				} catch {}
				return me(), Promise.resolve(!1);
			}
			se = "archive-v2";
		}
		if (_.textContent = "千人档案", v.textContent = "", y.className = "status-dot", ce) return Promise.resolve(!0);
		let e = ++le;
		ce = !0;
		try {
			return Promise.resolve(d.activate()).then(() => e === le && ce, () => (e === le && (ce = !1, me()), !1));
		} catch {
			return e === le && (ce = !1, me()), Promise.resolve(!1);
		}
	}, ge = () => {
		ue = !1, U();
	}, _e = () => {
		O !== null && globalThis.clearInterval?.(O), O = null;
	}, ve = () => {
		U(), j += 1, S = !1, B = !1, _e(), pe(), ae = null, re?.disconnect?.(), re = null, oe?.cancelGesture?.(), m.hidden = !0, m.setAttribute("aria-hidden", "true");
		let e = C;
		C = null, p?.(), e?.focus?.();
	}, ye = (e) => Array.isArray(e) ? e.map(ye) : !e || typeof e != "object" ? e : Object.fromEntries(Object.keys(e).sort().map((t) => [t, ye(e[t])])), be = (e) => JSON.stringify(ye(e)), xe = (e) => String(e?.chatId || e?.peopleFoundation?.state?.chatId || e?.people?.chatId || "unknown-chat"), Se = (e, t) => [...e.filter((e) => e !== t), t], G = (e) => {
		let t = (Array.isArray(e?.people?.confirmed) ? e.people.confirmed : []).filter((e) => e.selection?.status === "selected"), n = new Set(t.map((e) => e.identityId)), r = (Array.isArray(e?.peopleFoundation?.profiles) ? e.peopleFoundation.profiles : []).filter((e) => e?.subject === "character" && n.has(e.identityId));
		return {
			selectedCharacters: t,
			selectedIds: n,
			profiles: r,
			profileMap: new Map(r.map((e) => [e.identityId, e]))
		};
	}, Ce = () => ne ? H.get(ne) : null, we = (e, t) => {
		let n = new Map(t.map((e, t) => [e.identityId, t])), r = new Map(e.updatedOrder.map((e, t) => [e, t])), i = new Map(e.viewedOrder.map((e, t) => [e, t]));
		return t.map((e) => e.identityId).sort((t, a) => t === e.selectedProfileId ? -1 : a === e.selectedProfileId ? 1 : Number(e.unreadUpdatedIds.has(a)) - Number(e.unreadUpdatedIds.has(t)) || (r.get(a) ?? -1) - (r.get(t) ?? -1) || (i.get(a) ?? -1) - (i.get(t) ?? -1) || n.get(t) - n.get(a));
	}, K = (e, t) => {
		let n = new Set(e.railIds);
		return t.map((e) => e.identityId).filter((e) => n.has(e));
	}, Te = (e) => {
		if (e?.peopleFoundation?.status !== "ready" || !Array.isArray(e.peopleFoundation.profiles)) return null;
		let t = xe(e), { profiles: n, profileMap: r } = G(e), i = new Set(n.map((e) => e.identityId)), a = H.get(t);
		if (a) {
			let e = a.profileFingerprints.size > 0;
			a.railIds = a.railIds.filter((e) => i.has(e)), a.viewedOrder = a.viewedOrder.filter((e) => i.has(e)), a.updatedOrder = a.updatedOrder.filter((e) => i.has(e)), a.unreadUpdatedIds = new Set([...a.unreadUpdatedIds].filter((e) => i.has(e)));
			let o = te.get(t);
			if (o) for (let e of [...o.keys()]) i.has(e) || o.delete(e);
			for (let e of [...a.profileFingerprints.keys()]) i.has(e) || a.profileFingerprints.delete(e);
			for (let e of n) {
				let t = be(e), n = a.profileFingerprints.get(e.identityId);
				n !== void 0 && n !== t && (a.updatedOrder = Se(a.updatedOrder, e.identityId), a.unreadUpdatedIds.add(e.identityId), a.railIds.includes(e.identityId) || a.railIds.push(e.identityId)), n === void 0 && !a.railIds.includes(e.identityId) && a.railIds.push(e.identityId), a.profileFingerprints.set(e.identityId, t);
			}
			if ((!a.selectedProfileId || !r.has(a.selectedProfileId)) && (a.selectedProfileId = n[0]?.identityId || null), !e && n.length > 0 && (a.selectedProfileId = n[0].identityId, a.contentMode = "dossier", a.viewedOrder = Se(a.viewedOrder, a.selectedProfileId), a.unreadUpdatedIds.delete(a.selectedProfileId)), a.selectedProfileId && !a.railIds.includes(a.selectedProfileId) && a.railIds.unshift(a.selectedProfileId), n.length <= 2) a.railIds = n.map((e) => e.identityId);
			else if (a.railIds.length < 2) {
				for (let e of we(a, n)) if (a.railIds.includes(e) || a.railIds.push(e), a.railIds.length >= 2) break;
			}
			[
				"dossier",
				"more",
				"fateBook"
			].includes(a.contentMode) || (a.contentMode = "dossier");
		} else {
			let e = n[0]?.identityId || null;
			a = {
				contentMode: "dossier",
				selectedProfileId: e,
				railIds: [...i],
				viewedOrder: e ? [e] : [],
				updatedOrder: [],
				unreadUpdatedIds: /* @__PURE__ */ new Set(),
				profileFingerprints: new Map(n.map((e) => [e.identityId, be(e)]))
			}, H.set(t, a);
		}
		return ne = t, a;
	}, Ee = (e) => ({
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
		QQJ_PRESET_INVALID: "所选 API 预设已失效，请重新选择或保存。",
		QQJ_TAVERN: "当前没有可独立测试的 API，请配置下方 API 后重试。",
		QQJ_DISABLED: "千千结已关闭；启用并保存后才能测试连接。"
	})[String(e?.code || "")] || "连接失败，请检查 API 配置后重试。", De = (e, t, n) => {
		let r = document.createElement("option");
		return r.value = t, r.textContent = n, e?.append?.(r), r;
	}, Oe = () => {
		let e = Number(g.querySelector?.("[data-setting=\"timeout\"]")?.value);
		return {
			url: g.querySelector?.("[data-setting=\"url\"]")?.value?.trim?.() || "",
			key: E,
			model: g.querySelector?.("[data-setting=\"model\"]")?.value?.trim?.() || "",
			excludeParams: g.querySelector?.("[data-setting=\"exclude\"]")?.value || "",
			timeoutSec: e,
			stream: g.querySelector?.("[data-setting=\"stream\"]")?.checked === !0
		};
	}, ke = () => {
		let e = g.querySelector?.("[data-setting=\"api-preset\"]")?.value?.trim?.() || "";
		return e ? {
			apiMode: "seven-preset",
			selectedSevenDaysPresetId: e
		} : {
			apiMode: "auto",
			selectedSevenDaysPresetId: ""
		};
	}, Ae = () => {
		let e = [];
		try {
			e = i?.describe?.()?.sevenDaysPresets || [];
		} catch {}
		let t = /* @__PURE__ */ new Set(), n = [];
		for (let r of Array.isArray(e) ? e : []) {
			let e = typeof r?.id == "string" ? r.id.trim() : "", i = typeof r?.name == "string" ? r.name.trim() : "";
			!e || !i || t.has(e) || (t.add(e), n.push({
				...r,
				id: e,
				name: i
			}));
		}
		return n;
	}, q = (e, t = "") => {
		let n = g.querySelector?.(".settings-result");
		n && (n.textContent = e, n.className = `settings-result ${t}`.trim());
	}, je = (e) => {
		let t = g.querySelector?.("[data-setting=\"url\"]"), n = g.querySelector?.("[data-setting=\"model\"]"), r = g.querySelector?.("[data-setting=\"exclude\"]"), i = g.querySelector?.("[data-setting=\"timeout\"]"), a = g.querySelector?.("[data-setting=\"stream\"]"), o = g.querySelector?.("[data-setting=\"key\"]");
		t && (t.value = e?.url || ""), n && (n.value = e?.model || ""), r && (r.value = (e?.excludeParams || []).join("\n")), i && (i.value = String(e?.timeoutSec || 180)), a && (a.checked = e?.stream === !0), E = e?.key || "", o && (o.value = "", o.placeholder = E ? "已保存（输入新值可替换）" : "输入 API Key", o.type = "password");
	}, J = () => {
		let e = g.querySelector?.("[data-setting=\"api-preset\"]")?.value?.trim?.() || "";
		return e ? r.sharedPresets?.().find((t) => t.id === e) || null : r.sharedMainConfig?.() || {};
	}, Me = () => {
		w !== "settings" || m.hidden || k || (r.sharedSnapshotKey?.() || "") !== A && Pe({ preserveDrawers: !0 });
	}, Ne = () => {
		_e(), w === "settings" && typeof globalThis.setInterval == "function" && (O = globalThis.setInterval(Me, 1500), O?.unref?.());
	}, Pe = (e = {}) => {
		U({ releaseContent: !0 });
		let t = ++D;
		if (!r?.get) {
			q("设置存储暂不可用。", "error");
			return;
		}
		let n = e?.preserveDrawers === !0, a = n && g.querySelector?.(".settings-drawer")?.open === !0, o = n && g.querySelector?.(".settings-subdrawer")?.open === !0;
		w = "settings", h.querySelectorAll(".tab").forEach((e) => {
			e.classList.toggle("active", !1), e.setAttribute("aria-selected", "false");
		}), k = !1;
		let s = r.get(), l = Ae(), u = (r.sharedPresets?.() || []).filter((e) => typeof e?.id == "string" && e.id.trim() && typeof e?.name == "string" && e.name.trim());
		_.textContent = "千千结设置", v.textContent = "", y.className = `status-dot ${s.pluginEnabled === !1 ? "warn" : "ready"}`, g.innerHTML = `<section class="settings-view"><div class="master-control"><span class="master-label">总开关</span><label class="master-switch"><input data-setting="enabled" type="checkbox"><span>启用千千结</span></label></div><details class="settings-drawer"${a ? " open" : ""}><summary><span>基础通用设置</span></summary><div class="settings-drawer-body"><details class="settings-subdrawer"${o ? " open" : ""}><summary><span>API</span></summary><section class="settings-section"><label class="field"><span>预设</span><select data-setting="api-preset"></select></label><label class="field"><span>副 API（记忆扫描）</span><select data-setting="utility-preset"></select></label><div class="preset-actions"><button type="button" data-action="preset-new">新增</button><button type="button" data-action="preset-update">更新</button><button type="button" data-action="preset-rename">改名</button><button type="button" data-action="preset-delete">删除</button></div><label class="field"><span>Base URL</span><input data-setting="url" type="url" autocomplete="off" placeholder="https://api.example.com/v1"></label><label class="field"><span>API Key</span><span class="key-row"><input data-setting="key" type="password" autocomplete="new-password"><button type="button" data-action="key-toggle" aria-label="显示或隐藏 Key">显示</button><button type="button" data-action="key-clear">清除</button></span></label><label class="field"><span>模型</span><span class="model-row"><input data-setting="model" type="text" autocomplete="off" placeholder="gpt-4o-mini"><button type="button" data-action="models">拉取模型</button></span></label><div class="model-results" hidden></div><details class="advanced"><summary>高级设置</summary><label class="field"><span>剔除参数（每行一个）</span><textarea data-setting="exclude" rows="3" placeholder="frequency_penalty"></textarea></label><div class="advanced-row"><label class="field"><span>超时（5–600 秒）</span><input data-setting="timeout" type="number" min="5" max="600"></label><label class="check-field"><input data-setting="stream" type="checkbox"><span>流式响应</span></label></div></details><div class="settings-actions"><button class="secondary-action" type="button" data-action="test">测试连接</button><button class="primary-action" type="button" data-action="save">保存 API 配置</button></div></section></details></div></details><p class="settings-result" role="status" aria-live="polite"></p></section>`;
		let d = g.querySelector("[data-setting=\"enabled\"]");
		d && (d.checked = s.pluginEnabled !== !1);
		let f = g.querySelector("[data-setting=\"api-preset\"]");
		De(f, "", "主配置");
		for (let e of l) De(f, e.id, e.name);
		let p = s.apiMode === "seven-preset" ? s.selectedSevenDaysPresetId : "", m = l.find((e) => e.id === p);
		p && !m && De(f, p, "已失效预设（请重新选择）"), f && (f.value = p);
		let b = g.querySelector("[data-setting=\"utility-preset\"]");
		De(b, "", "跟随主 API");
		for (let e of u) De(b, e.id.trim(), e.name.trim());
		let x = r.sharedUtilityPresetId?.() || "", S = u.some((e) => e.id.trim() === x) ? x : "";
		b && (b.value = S), je(p ? m : r.sharedMainConfig?.()), A = r.sharedSnapshotKey?.() || "", p && !m && q("所选 API 预设已失效，请重新选择后保存。", "error");
		let C = s.pluginEnabled !== !1, T = g.querySelector("[data-action=\"test\"]"), O = g.querySelector("[data-action=\"models\"]");
		T && (T.disabled = !C), O && (O.disabled = !C), f?.addEventListener("change", () => {
			k = !0, je(J());
		}), b?.addEventListener("change", () => {
			k = !0;
		});
		for (let e of [
			"url",
			"model",
			"exclude",
			"timeout",
			"stream"
		]) g.querySelector(`[data-setting="${e}"]`)?.addEventListener("input", () => {
			k = !0;
		});
		g.querySelector("[data-setting=\"key\"]")?.addEventListener("input", (e) => {
			E = e.target.value, k = !0;
		}), g.querySelector("[data-action=\"key-toggle\"]")?.addEventListener("click", (e) => {
			let t = g.querySelector("[data-setting=\"key\"]");
			t && (t.type === "password" ? (!t.value && E && (t.value = E), t.type = "text", e.currentTarget.textContent = "隐藏") : (E = t.value, t.value = "", t.type = "password", t.placeholder = E ? "已保存（输入新值可替换）" : "输入 API Key", e.currentTarget.textContent = "显示"));
		}), g.querySelector("[data-action=\"key-clear\"]")?.addEventListener("click", () => {
			E = "", k = !0;
			let e = g.querySelector("[data-setting=\"key\"]");
			e && (e.value = "", e.placeholder = "输入 API Key"), q("保存后会清除 API Key。");
		}), g.querySelector("[data-action=\"preset-new\"]")?.addEventListener("click", () => {
			let e = globalThis.prompt?.("新预设名称", "新预设")?.trim();
			if (!e) return;
			let t = r.upsertSharedPreset?.(e, Oe());
			r.update({
				apiMode: "seven-preset",
				selectedSevenDaysPresetId: t
			}), k = !1, Pe({ preserveDrawers: !0 }), q(`已新增预设「${e}」。`, "success");
		}), g.querySelector("[data-action=\"preset-update\"]")?.addEventListener("click", () => {
			let e = g.querySelector("[data-setting=\"api-preset\"]")?.value, t = r.sharedPresets?.().find((t) => t.id === e);
			if (!t) return q("请先选择要更新的预设。", "error");
			r.upsertSharedPreset(t.name, Oe(), e), k = !1, Pe({ preserveDrawers: !0 }), q(`已更新预设「${t.name}」。`, "success");
		}), g.querySelector("[data-action=\"preset-rename\"]")?.addEventListener("click", () => {
			let e = g.querySelector("[data-setting=\"api-preset\"]")?.value, t = r.sharedPresets?.().find((t) => t.id === e);
			if (!t) return q("请先选择要改名的预设。", "error");
			let n = globalThis.prompt?.("新的预设名称", t.name)?.trim();
			n && (r.renameSharedPreset(e, n), k = !1, Pe({ preserveDrawers: !0 }), q(`已改名为「${n}」。`, "success"));
		}), g.querySelector("[data-action=\"preset-delete\"]")?.addEventListener("click", () => {
			let e = g.querySelector("[data-setting=\"api-preset\"]")?.value, t = r.sharedPresets?.().find((t) => t.id === e);
			if (!t) return q("请先选择要删除的预设。", "error");
			globalThis.confirm?.(`删除预设「${t.name}」？`) && (r.deleteSharedPreset(e), r.update({
				apiMode: "auto",
				selectedSevenDaysPresetId: ""
			}), k = !1, Pe({ preserveDrawers: !0 }), q("预设已删除。", "success"));
		}), g.querySelector("[data-action=\"save\"]")?.addEventListener("click", async () => {
			let e = Oe();
			if (!Number.isInteger(e.timeoutSec) || e.timeoutSec < 5 || e.timeoutSec > 600) return q("超时时间必须是 5–600 秒的整数。", "error");
			let t = ke(), n = r.isEnabled(), i = b?.value?.trim?.() || "";
			if (i && !(r.sharedPresets?.() || []).some((e) => e?.id === i)) return q("所选记忆扫描 API 预设已失效，请重新选择。", "error");
			if (t.apiMode === "seven-preset") {
				let n = r.sharedPresets?.().find((e) => e.id === t.selectedSevenDaysPresetId);
				if (!n) return q("所选 API 预设已失效，请重新选择。", "error");
				r.upsertSharedPreset(n.name, e, n.id);
			} else r.saveSharedMainConfig?.(e);
			r.setSharedUtilityPresetId?.(i), r.update({
				...t,
				pluginEnabled: d?.checked !== !1
			});
			let a = r.isEnabled();
			n !== a && await c?.(a), k = !1, Pe({ preserveDrawers: !0 }), q("API 设置已保存。", "success");
		}), g.querySelector("[data-action=\"test\"]")?.addEventListener("click", async (e) => {
			if (!r.isEnabled()) {
				q("千千结已关闭；启用并保存后才能测试连接。", "error");
				return;
			}
			let n = ke();
			e.currentTarget.disabled = !0, q("正在发送不含聊天与人物数据的短测试…");
			try {
				let e = await i?.testConnection?.(n);
				t === D && r.isEnabled() && q(`连接成功 · ${e?.model || "当前模型"}`, "success");
			} catch (e) {
				t === D && r.isEnabled() && q(Ee(e), "error");
			} finally {
				t === D && r.isEnabled() && (e.currentTarget.disabled = !1);
			}
		}), g.querySelector("[data-action=\"models\"]")?.addEventListener("click", async (e) => {
			if (!r.isEnabled()) {
				q("千千结已关闭；启用并保存后才能读取模型列表。", "error");
				return;
			}
			let n = ke();
			e.currentTarget.disabled = !0, q("正在读取模型列表…");
			try {
				let e = await i?.fetchModels?.(n), a = g.querySelector(".model-results");
				if (!a || t !== D || !r.isEnabled()) return;
				a.replaceChildren(), a.hidden = !1;
				for (let t of e || []) {
					let e = document.createElement("button");
					e.type = "button", e.textContent = t, e.addEventListener("click", () => {
						let e = g.querySelector("[data-setting=\"model\"]");
						e && (e.value = t), k = !0;
					}), a.append(e);
				}
				q(`已读取 ${e?.length || 0} 个模型。`, "success");
			} catch (e) {
				t === D && r.isEnabled() && q(Ee(e), "error");
			} finally {
				t === D && r.isEnabled() && (e.currentTarget.disabled = !1);
			}
		}), Ne();
	}, Fe = () => {
		g.innerHTML = "<div class=\"empty\"><div class=\"eyebrow\">FIRST THREAD</div><h2>先为这段关系选一种形状</h2><p>选择只决定档案的起始方式，之后仍可以在正式数据中继续补充。</p><div class=\"choices\">" + u.map((e) => "<label class=\"choice\"><input type=\"radio\" name=\"qqj-card-type\" value=\"" + e[0] + "\"><strong>" + e[1] + "</strong><span>" + e[2] + "</span></label>").join("") + "</div><button class=\"init\" type=\"button\" disabled>初始化档案</button></div>", g.querySelectorAll("input").forEach((e) => e.addEventListener("change", () => {
			x = e.value, g.querySelectorAll(".choice").forEach((e) => e.classList.toggle("selected", e.querySelector("input").checked)), g.querySelector(".init").disabled = !1;
		})), g.querySelector(".init").addEventListener("click", async () => {
			if (S || !x) return;
			let t = ++j;
			S = !0, g.querySelector(".init").disabled = !0, _.textContent = "正在写入正式档案";
			try {
				let n = await e.initializeCard({ cardType: x });
				if (t !== j || m.hidden) return;
				["ready", "route_ready"].includes(n?.status) && typeof a == "function" ? (_.textContent = "正在读取人物初始化状态", await a()) : $(n);
			} catch {
				t === j && !m.hidden && $({ status: "error" });
			} finally {
				if (t === j) {
					S = !1;
					let e = g.querySelector(".init");
					e && (e.disabled = !x);
				}
			}
		});
	}, Ie = (e, t, n) => {
		let r = document.createElement("button");
		return r.type = "button", r.className = "person-action", r.dataset[t] = n, r.textContent = e, r;
	}, Y = (e, t, n) => {
		let r = document.createElement(e);
		return t && (r.className = t), n !== void 0 && (r.textContent = n), r;
	}, X = (e) => {
		e.querySelectorAll("[data-edit]").forEach((e) => e.addEventListener("click", async () => {
			let n = Array.isArray(b.people?.confirmed) ? b.people.confirmed : [], r = globalThis.prompt?.("新的显示名", n.find((t) => t.identityId === e.dataset.edit)?.displayName ?? "");
			r?.trim() && t?.editDisplayName && await yt(() => t.editDisplayName({
				identityId: e.dataset.edit,
				displayName: r
			}));
		})), e.querySelectorAll("[data-select]").forEach((e) => e.addEventListener("click", () => yt(() => t.select({ identityId: e.dataset.select }), { selectedIdentityId: e.dataset.select }))), e.querySelectorAll("[data-unselect]").forEach((e) => e.addEventListener("click", () => yt(() => t.unselect({ identityId: e.dataset.unselect })))), e.querySelectorAll("[data-shelve]").forEach((e) => e.addEventListener("click", async () => {
			globalThis.confirm?.("搁置后人物会从主列表隐藏，但可随时恢复。继续吗？") && t?.shelve && await yt(() => t.shelve({ identityId: e.dataset.shelve }));
		})), e.querySelectorAll("[data-restore]").forEach((e) => e.addEventListener("click", () => yt(() => t.restore({ identityId: e.dataset.restore }))));
	}, Le = (e, { showStateError: t = !0 } = {}) => {
		let n = Array.isArray(b.people?.confirmed) ? b.people.confirmed : [], r = Array.isArray(b.people?.candidate) ? b.people.candidate : [], i = Array.isArray(b.people?.shelved) ? b.people.shelved : [], a = Array.isArray(b.people?.warnings) ? b.people.warnings : [], o = a.some((e) => String(e?.code || "").startsWith("NORMALIZATION_")), s = a.some((e) => !String(e?.code || "").startsWith("NORMALIZATION_"));
		if (s && e.append(Y("p", "error", "部分原设来源当前不可用，已按其余来源继续。")), o && e.append(Y("p", "error", "部分人物格式已自动修正或跳过。")), t && b.peopleError && e.append(Y("p", "error", f(b.peopleError))), n.length) {
			let t = document.createElement("section");
			t.className = "people-list";
			let r = document.createElement("h3");
			r.textContent = "明确人物", t.append(r), n.forEach((e) => {
				let n = document.createElement("article");
				n.className = "module person-card";
				let r = document.createElement("b");
				r.textContent = e.displayName ?? "";
				let i = e.selection?.status === "selected", a = document.createElement("small");
				a.textContent = i ? "当前关注 · 不代表已经恋爱" : "尚未选择 · 人物仍会长期保留";
				let o = document.createElement("div");
				o.className = "person-actions", o.append(Ie(i ? "取消选择" : "选择", i ? "unselect" : "select", e.identityId), Ie("改名", "edit", e.identityId), Ie("搁置", "shelve", e.identityId)), n.append(r, a, o), t.append(n);
			}), e.append(t);
		} else !s && !b.peopleError && e.append(Y("p", "pool-empty", "当前来源尚未登记明确人物。"));
		if (r.length) {
			let t = document.createElement("section");
			t.className = "people-list";
			let n = document.createElement("h3");
			n.textContent = "待判断人物", t.append(n), r.forEach((e) => {
				let n = document.createElement("article");
				n.className = "module person-card";
				let r = document.createElement("b");
				r.textContent = e.name ?? "";
				let i = document.createElement("small");
				i.textContent = "身份或重要性仍需判断 · 未选择", n.append(r, i), t.append(n);
			}), e.append(t);
		}
		if (i.length) {
			let t = document.createElement("details");
			t.className = "shelved-people";
			let n = document.createElement("summary");
			n.textContent = `已搁置人物（${i.length}）`, t.append(n);
			let r = document.createElement("div");
			r.className = "people-list", i.forEach((e) => {
				let t = document.createElement("article");
				t.className = "module person-card";
				let n = document.createElement("b");
				n.textContent = e.displayName ?? "";
				let i = document.createElement("small");
				i.textContent = "已保留身份、改名和用户事实";
				let a = document.createElement("div");
				a.className = "person-actions", a.append(Ie("恢复", "restore", e.identityId)), t.append(n, i, a), r.append(t);
			}), t.append(r), e.append(t);
		}
		X(e);
	}, Re = (e) => ({
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
	})[e] || ["首次档案尚未完成", "重新加载后再试。"], ze = (e) => {
		let t = [...new Set((Array.isArray(e?.sourceRefs) ? e.sourceRefs : []).map((e) => ({
			persona: "Persona",
			card: "角色卡",
			greeting: "开场白",
			worldbook: "世界书",
			chat: "稳定聊天",
			memory: "柏宝书记忆"
		})[e?.kind]).filter(Boolean))];
		return t.length ? t.join(" · ") : "来源未标注";
	}, Be = async (e) => {
		if (S || !o?.[e]) return;
		S = !0, N = e === "resume" ? "applying" : e === "adoptCurrentSources" ? "adopting_sources" : "generating";
		let t = ++j;
		Q();
		try {
			if (await o[e](), t !== j || m.hidden) return;
			N = null, S = !1, await a?.();
		} finally {
			t === j && (S = !1, N && (N = null, Q()));
		}
	}, Ve = () => {
		o?.cancel && (j += 1, o.cancel(), S = !1, N = "cancelled", Q());
	}, He = [
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
	], Ue = [
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
	], We = async (e) => {
		if (S || F || R || !o?.extractBasicInfo) return;
		F = !0, I = {
			kind: "",
			text: "正在提取基础信息…"
		}, Q();
		let t = ++M;
		try {
			let n = await o.extractBasicInfo({ identityId: e.identityId });
			if (t !== M || m.hidden) return;
			if (n?.status === "ready") {
				let e = Number(n.acceptedFields) || 0, t = Number(n.rejectedFields) || 0;
				I = e === 0 && t > 0 ? {
					kind: "error",
					text: `AI 返回了 ${t} 项，但格式未能采用；原有基础信息保持不变。`
				} : {
					kind: "success",
					text: n.emptyResult ? "提取完成，没有发现可可靠填写的新信息。" : `提取完成，采用了 ${e} 项。`
				}, F = !1, await a?.();
			} else I = {
				kind: "error",
				text: n?.status === "conflict" ? "档案刚刚发生变化，请重新加载后再试。" : n?.status === "no_selected_character" ? "当前没有已选择人物，请先到人物池选择 C。" : "提取失败，原有基础信息保持不变。"
			};
		} catch {
			t === M && (I = {
				kind: "error",
				text: "提取失败，原有基础信息保持不变。"
			});
		} finally {
			t === M && (F = !1, Q());
		}
	}, Ge = async (e, n, r) => {
		if (S || F || R) return;
		let i = new Map([...r.querySelectorAll("[data-basic-field]")].map((e) => [e.dataset.basicField, e]));
		F = !0, I = {
			kind: "",
			text: "正在保存基础信息…"
		}, Q();
		let s = ++M;
		try {
			let r = i.get("name")?.value?.trim?.() || "";
			if (!r) throw Error("姓名不能为空");
			if (r !== n) {
				let n = await t?.editDisplayName?.({
					identityId: e.identityId,
					displayName: r
				});
				if (n?.status === "conflict" || n?.status === "future_schema_readonly") throw Error("姓名保存冲突");
			}
			for (let [t] of He.slice(1)) {
				let n = i.get(t)?.value ?? "", r = e.basicFields?.[t]?.value ?? "";
				if (String(n).replace(/\r\n?/g, "\n").trim() !== String(r).replace(/\r\n?/g, "\n").trim() && (await o?.saveBasicField?.({
					identityId: e.identityId,
					field: t,
					value: n
				}))?.status !== "ready") throw Error("字段保存冲突");
			}
			if (s !== M || m.hidden) return;
			P = !1, I = {
				kind: "success",
				text: "基础信息已保存；用户填写内容不会被重新提取覆盖。"
			}, F = !1, await a?.();
		} catch (e) {
			s === M && (I = {
				kind: "error",
				text: e?.message === "姓名不能为空" ? "姓名不能为空。" : "保存未全部完成；部分已成功字段可能已保存，请重新加载确认。"
			});
		} finally {
			s === M && (F = !1, Q());
		}
	}, Ke = (e, t) => {
		let n = Y("section", "basic-info"), r = Y("div", "basic-info-head"), i = Y("div");
		i.append(Y("h3", "", "基础信息"), Y("p", "", "只记录稳定且有依据的角色信息；缺失不会猜测。")), r.append(i);
		let a = Y("div", "basic-info-actions");
		if (!P) {
			let t = Object.values(e.basicFields || {}).some((e) => e?.value), n = Y("button", "secondary-action", F ? "正在提取…" : t ? "重新提取" : "提取基础信息");
			n.type = "button", n.disabled = F || R, n.addEventListener("click", () => We(e));
			let r = Y("button", "secondary-action", "编辑");
			r.type = "button", r.disabled = F || R, r.addEventListener("click", () => {
				P = !0, I = null, Q();
			}), a.append(n, r);
		}
		r.append(a), n.append(r);
		let o = Y("div", "basic-fields"), s = ([n, r]) => {
			let i = Y("div", "basic-field");
			i.append(Y("span", "basic-label", r));
			let a = n === "name" ? t : e.basicFields?.[n]?.value;
			if (P) {
				let e = document.createElement(n === "name" || ["gender", "age"].includes(n) ? "input" : "textarea");
				e.dataset.basicField = n, e.value = a || "", e.maxLength = n === "name" ? 120 : 2400, e.setAttribute("aria-label", r), i.append(e);
			} else i.append(Y("p", `basic-value ${a ? "" : "missing"}`.trim(), a || "未提及")), n !== "name" && a && i.append(Y("small", "basic-source", e.basicFields?.[n]?.provenance === "user" ? "用户填写" : ze(e.basicFields?.[n])));
			return i;
		}, c = new Map(He.map((e) => [e[0], e]));
		for (let e of Ue) {
			let t = e.length === 3 ? "basic-row-three" : e.length === 2 ? "basic-row-two basic-preference-row" : "basic-row-one basic-relationships-row", n = Y("div", `basic-row ${t}`);
			for (let t of e) n.append(s(c.get(t)));
			o.append(n);
		}
		if (n.append(o), P) {
			let r = Y("div", "basic-edit-actions"), i = Y("button", "primary-action", F ? "正在保存…" : "保存基础信息"), a = Y("button", "secondary-action", "取消");
			i.type = a.type = "button", i.disabled = a.disabled = F, i.addEventListener("click", () => Ge(e, t, n)), a.addEventListener("click", () => {
				P = !1, I = null, Q();
			}), r.append(i, a), n.append(r);
		}
		return I && n.append(Y("p", `basic-message ${I.kind}`.trim(), I.text)), n;
	}, qe = [
		["personalityState", "当前性格状态"],
		["currentGoals", "当前目标"],
		["currentSituation", "当前处境"],
		["currentSecrets", "当前秘密"],
		["wellbeing", "当前身心状态"],
		["stableChanges", "长期稳定变化"]
	], Je = [
		["personalityState"],
		["currentGoals", "currentSituation"],
		["currentSecrets"],
		["wellbeing", "stableChanges"]
	], Ye = async (e) => {
		if (S || F || R || !o?.updateDynamicFields) return;
		R = !0, z = {
			kind: "",
			text: "正在更新动态状态…"
		}, Q();
		let t = ++M;
		try {
			let n = await o.updateDynamicFields({ identityId: e.identityId });
			if (t !== M || m.hidden) return;
			if (n?.status === "ready") {
				let e = Number(n.acceptedFields) || 0, t = Number(n.rejectedFields) || 0;
				z = e === 0 && t > 0 ? {
					kind: "error",
					text: `AI 返回了 ${t} 项动态状态，但格式或范围未能采用；原有状态保持不变。`
				} : {
					kind: "success",
					text: n.emptyResult ? "更新完成，没有发现可可靠填写的当前状态。" : `更新完成，采用了 ${e} 项动态状态。`
				}, R = !1, await a?.();
			} else z = {
				kind: "error",
				text: n?.status === "conflict" ? "档案刚刚发生变化，请重新加载后再试。" : n?.status === "no_selected_character" ? "当前没有已选择人物，请先到人物池选择 C。" : "动态状态更新失败，原有内容保持不变。"
			};
		} catch {
			t === M && (z = {
				kind: "error",
				text: "动态状态更新失败，原有内容保持不变。"
			});
		} finally {
			t === M && (R = !1, Q());
		}
	}, Xe = async (e, t) => {
		if (S || F || R) return;
		let n = new Map([...t.querySelectorAll("[data-dynamic-field]")].map((e) => [e.dataset.dynamicField, e]));
		R = !0, z = {
			kind: "",
			text: "正在保存当前状态…"
		}, Q();
		let r = ++M;
		try {
			for (let [t] of qe) {
				let r = n.get(t)?.value ?? "", i = e.dynamicFields?.[t]?.value ?? "";
				if (String(r).replace(/\r\n?/g, "\n").trim() !== String(i).replace(/\r\n?/g, "\n").trim() && (await o?.saveDynamicField?.({
					identityId: e.identityId,
					field: t,
					value: r
				}))?.status !== "ready") throw Error("字段保存冲突");
			}
			if (r !== M || m.hidden) return;
			L = !1, z = {
				kind: "success",
				text: "当前状态已保存；用户填写内容不会被 AI 更新覆盖。"
			}, R = !1, await a?.();
		} catch {
			r === M && (z = {
				kind: "error",
				text: "保存未全部完成；部分已成功字段可能已保存，请重新加载确认。"
			});
		} finally {
			r === M && (R = !1, Q());
		}
	}, Ze = (e) => {
		let t = Y("section", "dynamic-info"), n = Y("div", "dynamic-info-head"), r = Y("div");
		r.append(Y("h3", "", "当前状态"), Y("p", "", "记录这个 C 当前仍成立的个人状态；不记录对 U 的态度或关系阶段。")), n.append(r);
		let i = Y("div", "dynamic-info-actions");
		if (!L) {
			let t = Y("button", "secondary-action", R ? "正在更新…" : "更新动态状态");
			t.type = "button", t.disabled = R || F, t.addEventListener("click", () => Ye(e));
			let n = Y("button", "secondary-action", "编辑");
			n.type = "button", n.disabled = R || F, n.addEventListener("click", () => {
				L = !0, z = null, Q();
			}), i.append(t, n);
		}
		n.append(i), t.append(n);
		let a = Y("div", "dynamic-fields"), o = new Map(qe.map((e) => [e[0], e])), s = ([t, n]) => {
			let r = Y("div", "dynamic-field");
			r.append(Y("span", "dynamic-label", n));
			let i = e.dynamicFields?.[t]?.value;
			if (L) {
				let e = document.createElement("textarea");
				e.dataset.dynamicField = t, e.value = i || "", e.maxLength = 2400, e.setAttribute("aria-label", n), r.append(e);
			} else r.append(Y("p", `dynamic-value ${i ? "" : "missing"}`.trim(), i || "未提及")), i && r.append(Y("small", "dynamic-source", e.dynamicFields?.[t]?.provenance === "user" ? "用户填写" : ze(e.dynamicFields?.[t])));
			return r;
		};
		for (let e of Je) {
			let t = Y("div", `dynamic-row ${e.length === 2 ? "dynamic-row-two" : "dynamic-row-one"}`);
			for (let n of e) t.append(s(o.get(n)));
			a.append(t);
		}
		if (t.append(a), L) {
			let n = Y("div", "dynamic-edit-actions"), r = Y("button", "primary-action", R ? "正在保存…" : "保存当前状态"), i = Y("button", "secondary-action", "取消");
			r.type = i.type = "button", r.disabled = i.disabled = R, r.addEventListener("click", () => Xe(e, t)), i.addEventListener("click", () => {
				L = !1, z = null, Q();
			}), n.append(r, i), t.append(n);
		}
		return z && t.append(Y("p", `dynamic-message ${z.kind}`.trim(), z.text)), t;
	}, Qe = (e) => Object.values(e || {}).some((e) => typeof e?.value == "string" && e.value.trim().length > 0), $e = (e) => Qe(e?.basicFields) && Qe(e?.dynamicFields), et = (e, t) => {
		let n = b.initialRelations || b.peopleFoundation?.state?.initialGeneration || {
			status: "uninitialized",
			completedMemberIds: []
		}, r = n.lastAttempt || b.peopleFoundation?.state?.lastAttempt, i = r?.action === "adopt_current_sources" && r?.status === "ready", o = N || (i && ["blocked_source_changed", "uninitialized"].includes(n.status) ? "adopted_sources" : n.status) || "uninitialized", s = new Set(n.completedMemberIds || []), c = new Map(t.map((e) => [e.identityId, e])), l = e.some((e) => !s.has(e) && !$e(c.get(e))), u = t.length > 0, d = e.length > 0 && !l, f = r?.emptyResult === !0;
		if (o === "ready" && !l && !f || d && !f && [
			"uninitialized",
			"failed_retryable",
			"cancelled"
		].includes(o)) return null;
		let p = Y("section", "generation-banner");
		p.setAttribute("aria-live", "polite"), p.setAttribute("aria-busy", String(["generating", "applying"].includes(o)));
		let [m, h] = o === "ready" && !l && f ? ["首次整理已完成", "没有可靠结果；人物骨架和用户内容保持不变。"] : o === "ready" && l ? ["有新人物等待补充", "只会为尚未完成的已选择人物生成首次档案。"] : Re(o);
		if (p.append(Y("h3", "", m), Y("p", "", h)), n.status === "blocked_source_changed" && r?.sourceDiagnostics) {
			let e = r.sourceDiagnostics, t = e.greeting === "changed" ? "开场白已变化" : e.greeting === "unavailable" ? "开场白暂时无法读取" : "开场白未变化", n = Number(e.worldbookUnreadable) || 0, i = n > 0 ? `，暂时无法读取 ${n} 条` : "";
			p.append(Y("p", "source-change-summary", `${t}；世界书 ${Number(e.worldbookChanged) || 0} 条变化，${Number(e.worldbookMissing) || 0} 条缺失${i}。`));
		}
		let g = Y("div", "generation-actions");
		if (["generating", "applying"].includes(o)) {
			let e = Y("button", "secondary-action", "停止，稍后继续");
			e.type = "button", e.addEventListener("click", Ve), g.append(e);
		} else if (o === "blocked_source_changed") {
			let e = Y("button", "primary-action", "采用当前作者来源");
			e.type = "button", e.disabled = S, e.addEventListener("click", () => Be("adoptCurrentSources")), g.append(e);
		} else if (l && ![
			"mismatch",
			"future_schema_readonly",
			"input_too_large",
			"requires_rebuild"
		].includes(o)) {
			let e = Y("button", "primary-action", o === "ready" && l ? "为新人物补充档案" : o === "cancelled" ? "继续整理档案" : "生成首次档案");
			e.type = "button", e.disabled = S, e.addEventListener("click", () => Be(n.status === "applying" ? "resume" : "start")), g.append(e);
		}
		if (!["generating", "applying"].includes(o)) {
			let e = Y("button", "secondary-action", o === "blocked_source_changed" ? "重新读取状态" : "重新加载");
			e.type = "button", e.addEventListener("click", () => a?.({ announceLoading: !0 })), g.append(e);
		}
		return !u && o === "uninitialized" && p.append(Y("p", "generation-hint", "还没有选择 C；可以先到“因缘簿”选择人物。")), (g.children?.length || g.childNodes?.length) && p.append(g), p;
	}, tt = () => pe(), Z = (e) => {
		if (!e) return !1;
		let t = e.kind === "profile" ? ".profile-tab" : ".profile-tool", n = e.kind === "profile" ? "profileId" : "contentMode", r = [...g.querySelectorAll(t)].find((t) => t.dataset[n] === e.id);
		return r?.focus?.(), r?.scrollIntoView?.({
			block: "nearest",
			inline: "nearest"
		}), !!r;
	}, nt = () => {
		let e = h.activeElement;
		return e?.dataset?.profileId ? {
			kind: "profile",
			id: e.dataset.profileId
		} : e?.dataset?.contentMode ? {
			kind: "tool",
			id: e.dataset.contentMode
		} : null;
	}, rt = () => {
		let e = ae;
		return ae = null, Z(e);
	}, it = (e, { restoreFocus: t = !1 } = {}) => {
		let n = Ce();
		n && (n.selectedProfileId = e, n.contentMode = "dossier", n.viewedOrder = Se(n.viewedOrder, e), n.unreadUpdatedIds.delete(e), n.railIds.includes(e) || n.railIds.push(e), t && (ae = {
			kind: "profile",
			id: e
		}), tt(), Q(), rt());
	}, at = ({ availableWidth: e, itemWidths: t = {} } = {}, n = !0) => {
		let r = Ce(), { profiles: i } = G(b), a = nt();
		if (!r) return ae = null, {
			changed: !1,
			railIds: []
		};
		if (i.length <= 2) {
			let e = i.map((e) => e.identityId), t = e.join("|") !== r.railIds.join("|");
			return r.railIds = e, ae = null, t && n && (Q(), Z(a)), {
				changed: t,
				railIds: [...r.railIds]
			};
		}
		let o = Number(e), s = we(r, i), c = K(r, i);
		if (!(o > 0)) return ae = null, {
			changed: !1,
			railIds: c
		};
		let l = te.get(ne);
		l || (l = /* @__PURE__ */ new Map(), te.set(ne, l));
		let u = t instanceof Map ? t : new Map(Object.entries(t || {}));
		for (let [e, t] of u) Number(t) > 0 && l.set(e, Number(t));
		let d = (e) => l.get(e) || 72, f = new Set(s.filter((e) => e === r.selectedProfileId || r.unreadUpdatedIds.has(e))), p = [...f].reduce((e, t) => e + d(t), Math.max(0, f.size - 1) * 7);
		for (let e of s) {
			if (f.has(e)) continue;
			let t = d(e) + (f.size ? 7 : 0);
			(f.size < 2 || p + t <= o) && (f.add(e), p += t);
		}
		let m = i.map((e) => e.identityId).filter((e) => f.has(e)), h = m.join("|") !== c.join("|");
		return h && (r.railIds = m, n && (Q(), Z(a))), ae = null, {
			changed: h,
			railIds: [...m]
		};
	}, ot = (e) => {
		if (!e || ie) return;
		ie = !0;
		let t = () => {
			ie = !1;
			let t = h.querySelector(".profile-switcher");
			if (t !== e) {
				t && ot(t);
				return;
			}
			let n = Number(e.clientWidth);
			if (!(n > 0)) {
				ae = null;
				return;
			}
			let r = new Map([...e.querySelectorAll(".profile-tab")].map((e) => [e.dataset.profileId, Number(e.getBoundingClientRect?.().width || e.offsetWidth || 0)]));
			at({
				availableWidth: n,
				itemWidths: r
			});
		};
		typeof globalThis.requestAnimationFrame == "function" ? globalThis.requestAnimationFrame(t) : globalThis.queueMicrotask?.(t);
	}, st = (e) => {
		re?.disconnect?.(), re = null, ot(e), typeof globalThis.ResizeObserver == "function" && (re = new globalThis.ResizeObserver(() => ot(e)), re.observe(e));
	}, ct = (e, t, n, r) => {
		let i = t.filter((e) => !r.has(e.identityId)), a = Y("section", "people-content more-view"), o = Y("div", "content-heading");
		if (o.append(Y("h2", "", `更多人物（${i.length}）`), Y("p", "", "这些人物仍在关注中，只是暂时退出快捷轨道。点击即可回到档案并提高轨道优先级。")), a.append(o), !i.length) a.append(Y("p", "layer-empty", "当前没有退出快捷轨道的人物。"));
		else {
			let e = Y("div", "more-list");
			for (let t of i) {
				let r = Y("button", "more-person");
				r.type = "button", r.dataset.profileId = t.identityId, r.append(Y("span", "subject-tag tag-c", "C"), Y("span", "", n.get(t.identityId))), r.addEventListener("click", () => it(t.identityId, { restoreFocus: !0 })), e.append(r);
			}
			a.append(e);
		}
		e.append(a);
	}, lt = (e) => {
		let t = Y("section", "people-content fate-book-view"), n = Y("div", "content-heading");
		n.append(Y("h2", "", "因缘簿"), Y("p", "", "管理候选人物与关注状态；这里的“选择”只表示当前关注，不代表关系已经成立。")), t.append(n), Le(t), e.append(t);
	}, ut = () => {
		if (b.peopleRecognitionFailed || b.peopleError) return ["人物识别没有完成", f(b.peopleError)];
		let e = b.people?.status;
		return b.people ? e === "ready" ? ["人物档案尚未就绪", {
			storage_error: "人物档案暂时无法保存，已有数据保持不变。",
			conflict: "人物档案刚刚发生变化，请重试。",
			recoverable: "人物档案尚未收敛，可以继续恢复。",
			initializing: "人物档案正在初始化。",
			future_schema_readonly: "人物档案来自更新版本，当前只读。",
			blocked: "当前身份或聊天尚不满足初始化条件。"
		}[b.peopleFoundation?.status] || "人物档案尚未准备好。"] : ["人物尚未识别", {
			uninitialized: "尚未生成人物池。",
			preparing: "人物池正在恢复，可以重新尝试。",
			deleting: "人物池有未完成的搁置操作。",
			restoring: "人物池有未完成的恢复操作。",
			renaming: "人物池有未完成的改名操作。",
			conflict: "人物池刚刚发生变化，请重试。",
			stale: "当前人物状态已过期，请重新读取。"
		}[e] || "人物池尚未准备好。"] : ["人物尚未识别", "正式档案已写入，但人物层还没有准备好。"];
	}, dt = (e) => $({
		...b,
		sourceCatalog: e,
		peopleRecognitionFailed: !1,
		peopleError: null
	}), ft = async () => {
		if (S || typeof n?.start != "function") return;
		let e = ++j;
		S = !0, Q();
		try {
			let t = await n.start({ formalState: b });
			e === j && !m.hidden && dt(t);
		} catch {
			e === j && !m.hidden && $({
				...b,
				sourceCatalogError: !0
			});
		} finally {
			e === j && (S = !1);
		}
	}, pt = async (e, t) => {
		if (S || typeof n?.setSelected != "function") return;
		let r = ++j;
		S = !0;
		try {
			let i = await n.setSelected({
				id: e,
				selected: t
			});
			r === j && !m.hidden && dt(i);
		} catch {
			r === j && !m.hidden && $({
				...b,
				sourceCatalogError: !0
			});
		} finally {
			r === j && (S = !1);
		}
	}, mt = async () => {
		if (S || typeof n?.confirm != "function" || typeof a != "function") return;
		let e = ++j;
		S = !0, Q();
		try {
			let t = await n.confirm();
			if (e !== j || m.hidden) return;
			b = {
				...b,
				sourceCatalog: t,
				peopleRecognitionFailed: !1,
				peopleError: null
			}, await a({ allowIdentification: !0 });
		} catch {
			e === j && !m.hidden && $({
				...b,
				sourceCatalogError: !0
			});
		} finally {
			e === j && (S = !1);
		}
	}, ht = () => {
		let e = b.sourceCatalog || {
			stage: "uninitialized",
			candidates: [],
			permit: { status: "none" }
		}, t = Y("div", "source-catalog-page");
		if (e.stage === "uninitialized") {
			let e = Y("div", "empty source-catalog-empty");
			e.append(Y("div", "eyebrow", "PEOPLE / SOURCES"), Y("h2", "", "人物来源尚未整理"), Y("p", "", "先在本地列出角色卡与世界书材料；这一步不会调用 AI。"));
			let n = Y("button", "primary-action source-start", S ? "正在整理本地来源…" : "开始整理来源");
			return n.type = "button", n.disabled = S, n.addEventListener("click", ft), e.append(n), t.append(e), t;
		}
		if (e.stage === "draft") {
			let n = Y("section", "source-catalog"), r = Y("div", "content-heading");
			r.append(Y("h2", "", "选择人物初始化来源"), Y("p", "", "只影响本次人物识别与首次基础档案；不会修改酒馆世界书开关。")), n.append(r);
			let i = Y("div", "source-list");
			for (let t of e.candidates || []) {
				let e = Y("label", `source-row ${t.availability === "disabled" ? "is-disabled" : ""}`.trim()), n = document.createElement("input");
				n.type = "checkbox", n.checked = t.selected === !0, n.disabled = S || t.availability === "disabled", n.addEventListener("change", () => pt(t.id, n.checked));
				let r = Y("span", "source-copy");
				r.append(Y("b", "", t.label), Y("small", "", {
					card: "角色卡",
					greeting: "开场白",
					activated: "已激活",
					enabled: "角色关联 · 已启用",
					disabled: "角色关联 · 已禁用"
				}[t.availability] || t.availability)), e.append(n, r), i.append(e);
			}
			n.append(i);
			let a = (e.candidates || []).filter((e) => e.selected && e.availability !== "disabled").length, o = Y("button", "primary-action source-confirm", S ? "正在保存来源…" : "确认并开始识别人");
			return o.type = "button", o.disabled = S || a === 0, o.addEventListener("click", mt), n.append(o), t.append(n), t;
		}
		let n = e.stage === "failed" || e.permit?.status === "failed" || e.permit?.status === "in_flight", r = Y("div", "empty source-catalog-empty");
		if (r.append(Y("div", "eyebrow", "PEOPLE / SOURCES"), Y("h2", "", n ? "人物识别没有完成" : "人物来源已经确认"), Y("p", "", n ? "已保存的来源不会自动再次调用 AI；需要你手动重试。" : "正在按已确认来源完成人物档案。")), n) {
			let e = Y("button", "primary-action people-retry", B ? "正在重新识别…" : "重新识别人物");
			e.type = "button", e.disabled = B || typeof a != "function", e.addEventListener("click", gt), r.append(e);
		}
		return t.append(r), t;
	}, gt = async () => {
		if (S || B || typeof a != "function") return;
		let e = ++j;
		S = !0, B = !0, Q();
		try {
			await a({
				allowIdentification: !0,
				retryRecognition: !0
			});
		} catch {
			e === j && !m.hidden && $({
				...b,
				peopleRecognitionFailed: !0,
				peopleError: "人物识别失败，请稍后重试"
			});
		} finally {
			e === j && (S = !1, B = !1, Q());
		}
	}, _t = () => {
		if (b.sourceCatalog && (b.people?.status === "uninitialized" || b.sourceCatalog.stage !== "completed")) {
			g.append(ht());
			return;
		}
		let e = xe(b);
		V !== e && (V = e, ee = "summary");
		let [t, n] = ut(), r = Y("div", "people-page people-unavailable"), i = Y("div", "generation-actions people-recovery-actions"), o = Y("button", "primary-action people-retry", B ? "正在重新识别…" : "重新识别人物");
		o.type = "button", o.disabled = B || typeof a != "function", o.addEventListener("click", gt);
		let s = Y("button", "secondary-action open-fate-book", ee === "fateBook" ? "返回人物页" : "因缘簿");
		if (s.type = "button", s.addEventListener("click", () => {
			ee = ee === "fateBook" ? "summary" : "fateBook", Q();
		}), i.append(o, s), ee === "fateBook") {
			let e = Y("section", "people-content fate-book-view"), t = Y("div", "content-heading");
			t.append(Y("h2", "", "因缘簿"), Y("p", "", "人物池尚未生成时不会伪造人物；可在这里重新识别。")), e.append(t, Y("p", "error", n), i), Le(e, { showStateError: !1 }), r.append(e);
		} else {
			let e = Y("div", "empty");
			e.append(Y("div", "eyebrow", "PEOPLE / RETRY"), Y("h2", "", t), Y("p", "", n), Y("p", "", "选择只表示你当前想关注这位人物，不代表已经恋爱或发生关系。"), i), Le(e, { showStateError: !1 }), r.append(e);
		}
		g.append(r);
	}, Q = () => {
		if (g.replaceChildren(), b.people?.refreshRecommended === !0 && b.sourceCatalog && b.sourceCatalog.stage !== "uninitialized" && b.sourceCatalog.stage !== "completed") {
			g.append(ht());
			return;
		}
		let e = b.peopleFoundation;
		if (e?.status !== "ready" || !Array.isArray(e.profiles)) {
			_t();
			return;
		}
		ee = "summary", V = xe(b);
		let t = Te(b), { selectedCharacters: r, selectedIds: i, profiles: a, profileMap: o } = G(b), s = new Map(r.map((e) => [e.identityId, e.displayName || "未命名人物"])), c = [...i], l = o.get(t?.selectedProfileId), u = new Map([[e.state?.personaId, "我"], ...a.map((e) => [e.identityId, s.get(e.identityId) || e.displayName || "未命名人物"])]), d = Y("div", "people-page");
		if (b.people?.refreshRecommended === !0) {
			let e = Y("section", "legacy-refresh-notice");
			e.append(Y("p", "", "旧人物档案已正常恢复；来源策略较旧，可在需要时手动重新识别。"));
			let t = Y("button", "secondary-action source-refresh", S ? "正在整理本地来源…" : "手动刷新人物来源");
			t.type = "button", t.disabled = S || typeof n?.start != "function", t.addEventListener("click", ft), e.append(t), d.append(e);
		}
		let f = Y("div", "profile-rail-shell"), p = Y("div", "profile-switcher");
		p.setAttribute("role", "tablist"), p.setAttribute("aria-label", "切换人物档案");
		let m = K(t, a).map((e) => o.get(e)).filter(Boolean);
		for (let e of m) {
			let n = t.contentMode === "dossier" && e.identityId === t.selectedProfileId, r = t.unreadUpdatedIds.has(e.identityId), i = u.get(e.identityId), a = Y("button", `profile-tab ${n ? "active" : ""} ${r ? "has-update" : ""}`.trim());
			if (a.type = "button", a.dataset.profileId = e.identityId, a.tabIndex = 0, a.setAttribute("role", "tab"), a.setAttribute("aria-selected", String(n)), a.setAttribute("aria-label", `C ${i}${r ? "，有新更新" : ""}`), a.append(Y("span", "subject-tag tag-c", "C"), Y("span", "profile-tab-name", i)), r) {
				let e = Y("span", "profile-update-dot");
				e.setAttribute("aria-hidden", "true"), a.append(e);
			}
			a.addEventListener("click", () => it(e.identityId, { restoreFocus: !0 })), p.append(a);
		}
		let h = Y("div", "profile-tools");
		for (let [e, n] of [["more", "更多"], ["fateBook", "因缘簿"]]) {
			let r = Y("button", `profile-tool ${t.contentMode === e ? "active" : ""}`.trim(), n);
			r.type = "button", r.dataset.contentMode = e, r.setAttribute("aria-pressed", String(t.contentMode === e)), r.addEventListener("click", () => {
				if (t.contentMode === e && l) {
					it(l.identityId, { restoreFocus: !0 });
					return;
				}
				t.contentMode = e, tt(), ae = {
					kind: "tool",
					id: e
				}, Q(), rt();
			}), h.append(r);
		}
		if (f.append(p, h), d.append(f), t.contentMode === "more") ct(d, a, u, new Set(t.railIds));
		else if (t.contentMode === "fateBook") lt(d);
		else if (!l) d.append(Y("p", "layer-empty", "还没有已选择的 C。请打开“因缘簿”选择一位人物。"));
		else {
			let e = Y("section", "dossier-card"), t = Y("header", "profile-summary");
			t.append(Y("span", "subject-tag tag-c", "C"));
			let n = Y("div");
			n.append(Y("h2", "", u.get(l.identityId)), Y("p", "", "当前已选择人物的稳定关系档案")), t.append(n), e.append(t);
			let r = et(c, a);
			r && e.append(r), e.append(Ke(l, u.get(l.identityId))), e.append(Ze(l)), d.append(e);
		}
		g.append(d), st(p);
	}, vt = () => {
		U({ releaseContent: !0 });
		let e = {
			bonds: "双丝网",
			milestones: "千事",
			knots: "千结"
		}, t = Y("div", "empty");
		t.append(Y("div", "eyebrow", "COMING LATER"), Y("h2", "", e[T] || "此模块"), Y("p", "", "尚未接入业务数据。本次只完成千人关系档案。")), g.replaceChildren(t);
	}, $ = (e) => {
		let t = e || { status: "error" };
		if (se === "archive-v2" && t.status !== "disabled") {
			if (w === "settings" || T !== "people") U({ releaseContent: !0 });
			else return b = t, b.status === "loading" && m.hidden && (ue = !0), !ce && !ue && !de.has(b.status) && he(), !1;
		}
		if (N === "cancelled" && e?.status === "stale" && ["ready", "route_ready"].includes(b?.status)) {
			S = !1, Q();
			return;
		}
		if (!(["ready", "route_ready"].includes(e?.status) && e?.peopleFoundation?.status === "ready")) pe(), ae = null;
		else {
			let t = xe(e), n = G(e).profileMap, r = Ce();
			(ne && t !== ne || r?.selectedProfileId && !n.has(r.selectedProfileId)) && (pe(), ae = null);
		}
		if (j += 1, S = !1, B = !1, N = null, b = t, b.status === "disabled" && U({ releaseContent: !0 }), w === "settings") return;
		if (T !== "people") return vt();
		let n = b.status, r = ["ready", "route_ready"].includes(n) && (b.peopleRecognitionFailed || b.people?.status !== "ready" || b.peopleFoundation?.status !== "ready" || !Array.isArray(b.peopleFoundation?.profiles)), i = ["ready", "route_ready"].includes(n) && b.peopleRecognitionFailed, a = Array.isArray(b.people?.warnings) && b.people.warnings.some((e) => String(e?.code || "").startsWith("NORMALIZATION_"));
		if (_.textContent = b.people?.status === "uninitialized" && b.sourceCatalog?.stage === "uninitialized" ? "开始整理来源" : i ? "人物识别失败，已保留旧列表" : r ? ut()[0] : {
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
		}[n] || n, v.textContent = n === "route_unavailable" ? [
			"GREETING_INVALID",
			"SCANNER_UNAVAILABLE",
			"SCAN_FAILED",
			"SCAN_RESULT_INVALID",
			"ENTRY_INVALID",
			"ROUTE_INVALID",
			"UNKNOWN"
		].includes(b.diagnosticCode) ? b.diagnosticCode : "UNKNOWN" : b.cardType || "", y.className = "status-dot " + (r || a || [
			"disabled",
			"mismatch",
			"route_mismatch",
			"route_unavailable",
			"error",
			"conflict"
		].includes(n) ? "warn" : ["ready", "route_ready"].includes(n) ? "ready" : ""), n === "awaiting_card_type" || n === "migrated") return Fe();
		if (["ready", "route_ready"].includes(n)) return Q();
		let o = n === "disabled" ? ["千千结现在是关闭的", "不会读取聊天、扫描来源、调用 AI 或写入档案。已有数据保持原样。"] : n === "route_mismatch" ? ["路线来源需要确认", "当前路线已锁定，来源诊断仅作提示，不影响人物识别。"] : n === "route_unavailable" ? ["来源扫描不可用", "当前世界书无法进行安全的 dry-run 扫描，请稍后重试。"] : n === "mismatch" && b.mismatchReason === "persona" ? ["user 不一致", "当前 user 与档案绑定的 user 不一致，请确认或切换后重试"] : n === "mismatch" ? ["身份需要确认", "当前角色、Persona 或正式档案绑定不一致。为保护已有数据，本次只读。"] : n === "offline" ? ["暂时离线", "正式存储暂时不可用，恢复连接后可重新打开。"] : n === "stopped" ? ["还没有可用聊天", "请先打开一个单人聊天，再打开千千结。"] : n === "preparing" ? ["正在恢复档案", "请稍候，档案恢复完成前不能操作人物。"] : n === "renaming" ? ["正在恢复人物改名", "上次改名尚未完成，正在核对人物档案与列表。"] : ["正在准备档案", "正式状态尚未就绪，请稍后重试。"], s = Y("div", "empty");
		if (s.append(Y("div", "eyebrow", "QIANQIANJIE"), Y("h2", "", o[0]), Y("p", "", o[1])), n === "disabled") {
			let e = Y("button", "open-settings", "打开设置");
			e.type = "button", e.addEventListener("click", Pe), s.append(e);
		}
		g.replaceChildren(s);
	}, yt = async (e, { selectedIdentityId: n = null } = {}) => {
		if (!S) {
			S = !0;
			try {
				let r = await e();
				if (r?.status === "conflict" || r?.status === "error") {
					$({
						...b,
						status: ["ready", "route_ready"].includes(b.status) ? b.status : r.status,
						people: b.people,
						peopleError: "档案发生冲突，请稍后重试"
					});
					return;
				}
				if (typeof a == "function") {
					await a(), n && G(b).profileMap.has(n) && it(n);
					return;
				}
				let i = t?.getPeople ? await t.getPeople() : r;
				$(b.peopleRecognitionFailed ? {
					...b,
					people: i
				} : {
					...b,
					people: i,
					peopleError: null
				}), n && G(b).profileMap.has(n) && it(n);
			} catch {
				$({
					...b,
					status: ["ready", "route_ready"].includes(b.status) ? b.status : "error",
					people: b.people,
					peopleError: "操作失败，原人物列表已保留"
				});
			} finally {
				S = !1;
			}
		}
	};
	return h.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			e.preventDefault(), ve();
			return;
		}
		if (e.key !== "Tab") return;
		let t = fe();
		if (!t.length) return;
		let n = t[0], r = t[t.length - 1];
		e.shiftKey && h.activeElement === n ? (e.preventDefault(), r.focus()) : !e.shiftKey && h.activeElement === r && (e.preventDefault(), n.focus());
	}), h.querySelector(".close").addEventListener("click", ve), h.querySelector(".settings-btn")?.addEventListener("click", () => {
		w === "settings" ? (D += 1, _e(), w = "people", T = "people", h.querySelectorAll(".tab").forEach((e, t) => {
			e.classList.toggle("active", t === 0), e.setAttribute("aria-selected", String(t === 0));
		}), W() ? he() : $(b)) : Pe();
	}), h.querySelectorAll(".tab").forEach((e) => e.addEventListener("click", () => {
		D += 1, _e(), w = "people", T = e.dataset.tab || "people", h.querySelectorAll(".tab").forEach((t) => {
			let n = t === e;
			t.classList.toggle("active", n), t.setAttribute("aria-selected", String(n));
		}), W() ? he() : $(b);
	})), globalThis.addEventListener?.("focus", Me), oe = l({
		panel: h.querySelector(".panel"),
		dragHandle: h.querySelector(".topbar"),
		resizeHandle: h.querySelector(".panel-resize-handle")
	}), $(b), {
		host: m,
		root: h,
		show: (e = document.activeElement) => {
			C = e, oe?.restore?.(), m.hidden = !1, m.setAttribute("aria-hidden", "false"), w === "settings" ? Pe({ preserveDrawers: !0 }) : W() && he(), st(h.querySelector(".profile-switcher")), h.querySelector(".close").focus();
		},
		close: ve,
		setState: $,
		settlePeopleRail: at,
		showSettings: Pe,
		showInitialization: he,
		invalidateInitialization: ge,
		getState: () => ({ ...b })
	};
}
//#endregion
//#region src/ui/fab.js
var m = "qqj-fab-pos", h = 36, g = () => globalThis.innerWidth <= 540 || globalThis.matchMedia?.("(max-width: 540px)").matches, _ = () => ({
	width: Number(globalThis.innerWidth) || 0,
	height: Number(globalThis.innerHeight) || 0
}), v = (e, t) => Math.max(0, Math.min(Math.max(0, t - h), e));
function y({ onClick: e } = {}) {
	let t = document.createElement("div");
	t.id = "qqj-fab-host", t.attachShadow({ mode: "open" });
	let n = t.shadowRoot;
	n.innerHTML = "<style>:host{position:fixed;right:16px;top:calc(100dvh - 80px - 44px);z-index:1000;touch-action:none}button{width:36px;height:36px;border:0;border-radius:50%;background:#B23A48;color:#fff;cursor:pointer;box-shadow:0 7px 18px rgba(178,58,72,.32);touch-action:none;display:grid;place-items:center;padding:4px}button:focus-visible{outline:2px solid #23262D;outline-offset:3px}svg{width:28px;height:28px;display:block}@media(max-width:540px){:host{right:14px}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}</style><button type=\"button\" aria-label=\"打开千千结\"><svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" width=\"64\" height=\"64\" fill=\"none\"><circle cx=\"32\" cy=\"32\" r=\"25\" stroke=\"currentColor\" stroke-width=\"0.9\"/><g stroke=\"currentColor\" stroke-width=\"0.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M 30.72 28.58 C 27.3 26.5, 24.5 25.3, 20.46 25.38 C 17.2 25.45, 15.53 28.1, 15.55 31.36 C 15.57 35.1, 17.6 37.8, 19.82 39.05 C 21.5 40.0, 23.4 39.9, 24.74 39.48 L 40.12 30.29\"/><path d=\"M 32.85 36.06 C 35.6 37.7, 37.8 39.2, 38.84 39.48 C 42.8 40.6, 46.0 38.3, 47.60 34.99 C 49.0 31.8, 47.6 28.5, 44.61 26.02 C 42.7 24.5, 39.2 24.7, 36.91 26.02 L 27.94 31.57\"/><path d=\"M 23.45 30.29 L 30.72 34.56\"/><path d=\"M 26.02 33.07 L 23.67 34.35\"/><path d=\"M 35.63 31.57 L 32.85 30.08\"/><path d=\"M 37.34 33.07 L 39.91 34.35\"/></g></svg></button>";
	let r = n.querySelector("button"), i = null, a = !1, o = null, s = () => {
		t.style.left = "", t.style.top = "calc(100dvh - 80px - 44px)", t.style.right = g() ? "14px" : "16px";
	}, c = () => {
		if (g()) return null;
		try {
			let e = JSON.parse(globalThis.localStorage?.getItem(m) || "null");
			return Number.isFinite(e?.x) && Number.isFinite(e?.y) ? e : null;
		} catch {
			return null;
		}
	}, l = (e) => {
		let n = _();
		if (!n.width || !n.height || !e) return;
		let r = v(e.x, n.width), i = v(e.y, n.height);
		t.style.left = `${r}px`, t.style.top = `${i}px`, t.style.right = "auto", o = {
			x: r,
			y: i
		};
	}, u = () => {
		if (g()) return;
		let e = t.getBoundingClientRect(), n = _(), r = {
			x: v(e.left, n.width),
			y: v(e.top, n.height)
		};
		o = r;
		try {
			globalThis.localStorage?.setItem(m, JSON.stringify({
				x: Math.round(r.x),
				y: Math.round(r.y)
			}));
		} catch {}
	}, d = () => {
		s(), g() || l(o || c());
	}, f = () => {
		g() ? s() : l(o || c());
	};
	return r.addEventListener("pointerdown", (e) => {
		i = {
			startX: e.clientX,
			startY: e.clientY,
			origX: t.getBoundingClientRect().left,
			origY: t.getBoundingClientRect().top,
			dragging: !1
		}, a = !1, r.setPointerCapture?.(e.pointerId);
	}), r.addEventListener("pointermove", (e) => {
		if (!i) return;
		let n = e.clientX - i.startX, r = e.clientY - i.startY;
		if (!i.dragging && Math.hypot(n, r) <= 5) return;
		i.dragging = !0, e.preventDefault?.();
		let a = _();
		t.style.left = `${v(i.origX + n, a.width)}px`, t.style.top = `${v(i.origY + r, a.height)}px`, t.style.right = "auto";
	}), r.addEventListener("pointerup", (e) => {
		i && (a = i.dragging, i.dragging && u(), i = null, r.releasePointerCapture?.(e?.pointerId));
	}), r.addEventListener("pointercancel", () => {
		i = null, a = !1;
	}), r.addEventListener("click", (t) => {
		if (a) {
			t.preventDefault(), a = !1;
			return;
		}
		e?.(t);
	}), globalThis.addEventListener?.("resize", f), d(), {
		host: t,
		root: n,
		button: r,
		restore: d,
		onResize: f,
		destroy: () => globalThis.removeEventListener?.("resize", f)
	};
}
//#endregion
//#region src/ui/wand-entry.js
function b(e) {
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
]), Object.freeze([
	["description", "角色描述"],
	["personality", "角色性格"],
	["scenario", "场景设定"],
	["mes_example", "对话示例"],
	["system_prompt", "角色系统设定"],
	["post_history_instructions", "历史后指令"],
	["creator_notes", "创作者备注"]
]), Object.freeze({
	maxSources: 80,
	maxSourceChars: 24e3,
	maxTotalChars: 12e4,
	maxItems: 80,
	maxNameChars: 120,
	maxAnchorChars: 80,
	maxRefs: 12
}), Object.freeze({
	kind: "single-main",
	version: 1
}), Object.freeze([
	"description",
	"personality",
	"scenario",
	"mes_example",
	"system_prompt",
	"post_history_instructions",
	"creator_notes"
]);
var x = Object.freeze([
	"card",
	"greeting",
	"worldbook"
]);
Object.freeze({
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
			minItems: 1,
			maxItems: 1,
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
					enum: x
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
function S(e) {
	let t = Number(e?.status || e?.statusCode || 0), n = String(e?.code || e?.name || "").toLowerCase(), r = String(e?.message || "");
	return e?.name === "AbortError" || /timeout|timed.?out|etimedout|abort/.test(n) || /timeout|timed.?out|超时/i.test(r) || [408, 504].includes(t) ? "API 请求超时，请稍后重试" : [401, 403].includes(t) || /unauthori[sz]ed|forbidden|认证|api.?key/.test(`${n} ${r}`.toLowerCase()) ? "API 认证失败，请检查配置后重试" : t === 429 || /rate.?limit|too many requests|限流/.test(`${n} ${r}`.toLowerCase()) ? "API 请求过于频繁，请稍后重试" : /jsonData|generateTask 返回值无效|未返回 jsonData|结果不是 json|结果结构|结构无效|字段无效|来源锚点无效|无可用人物|schema/i.test(r) ? "人物识别结果格式无效" : "人物识别失败，请稍后重试";
}
var C = /* @__PURE__ */ new Set([
	"schemaVersion",
	"kind",
	"chatId",
	"identity",
	"initialization",
	"people",
	"events",
	"bonds",
	"nextSteps",
	"progress"
]);
Object.freeze({
	PERSONA_MISMATCH: "persona_mismatch",
	CHARACTER_MISMATCH: "character_mismatch"
});
var w = class extends Error {
	constructor(e, t = "ARCHIVE_V2_INVALID") {
		super(e), this.name = "ArchiveV2ValidationError", this.code = t;
	}
};
function T(e, t) {
	throw new w(e, t);
}
function E(e) {
	if (typeof e != "object" || !e || Array.isArray(e)) return !1;
	let t = Object.getPrototypeOf(e);
	return t === Object.prototype || t === null;
}
function D(e, t = "archive", n = /* @__PURE__ */ new WeakSet()) {
	if (e === null || typeof e == "string" || typeof e == "boolean") return e;
	if (typeof e == "number") return Number.isFinite(e) || T(`${t} 必须是合法 JSON`, "ARCHIVE_V2_NOT_JSON"), e;
	(typeof e != "object" || !e) && T(`${t} 必须是合法 JSON`, "ARCHIVE_V2_NOT_JSON"), n.has(e) && T(`${t} 不得包含循环引用`, "ARCHIVE_V2_NOT_JSON"), n.add(e);
	try {
		if (Array.isArray(e)) {
			let r = Reflect.ownKeys(e);
			(Object.getOwnPropertySymbols(e).length > 0 || r.length !== e.length + 1 || !r.includes("length")) && T(`${t} 必须是连续 JSON 数组`, "ARCHIVE_V2_NOT_JSON");
			let i = [];
			for (let r = 0; r < e.length; r += 1) {
				let a = Object.getOwnPropertyDescriptor(e, String(r));
				(!a?.enumerable || !Object.hasOwn(a, "value")) && T(`${t} 必须是连续 JSON 数组`, "ARCHIVE_V2_NOT_JSON"), i.push(D(a.value, `${t}[${r}]`, n));
			}
			return i;
		}
		(!E(e) || Object.getOwnPropertySymbols(e).length > 0) && T(`${t} 必须是合法 JSON 对象`, "ARCHIVE_V2_NOT_JSON");
		let r = {};
		for (let i of Reflect.ownKeys(e)) {
			let a = Object.getOwnPropertyDescriptor(e, i);
			(typeof i != "string" || !a?.enumerable || !Object.hasOwn(a, "value")) && T(`${t} 必须是合法 JSON 对象`, "ARCHIVE_V2_NOT_JSON"), Object.defineProperty(r, i, {
				value: D(a.value, `${t}.${i}`, n),
				enumerable: !0,
				configurable: !0,
				writable: !0
			});
		}
		return r;
	} finally {
		n.delete(e);
	}
}
function O(e, t) {
	E(e) || T(`${t} 必须是对象`, "ARCHIVE_V2_CONTAINER_INVALID");
}
function k(e, t) {
	Array.isArray(e) || T(`${t} 必须是数组`, "ARCHIVE_V2_CONTAINER_INVALID");
}
function A(e, t) {
	(typeof e != "string" || !e.trim()) && T(`${t} 必须是非空字符串`, "ARCHIVE_V2_FIELD_INVALID");
}
function j(e, t) {
	O(e, t);
	for (let n of [
		"kind",
		"locator",
		"fingerprint"
	]) typeof e[n] != "string" && T(`${t}.${n} 必须是字符串`, "ARCHIVE_V2_FIELD_INVALID");
}
function M(e, t, n) {
	O(e, t), Object.hasOwn(e, "value") || T(`${t}.value 缺失`, "ARCHIVE_V2_FIELD_INVALID"), A(e.origin, `${t}.origin`), k(e.sourceRefs, `${t}.sourceRefs`), e.sourceRefs.forEach((e, n) => j(e, `${t}.sourceRefs[${n}]`)), typeof e.userProtected != "boolean" && T(`${t}.userProtected 必须是布尔值`, "ARCHIVE_V2_FIELD_INVALID"), n === "string" && typeof e.value != "string" && T(`${t}.value 必须是字符串`, "ARCHIVE_V2_FIELD_INVALID"), n === "string-array" && (!Array.isArray(e.value) || e.value.some((e) => typeof e != "string")) && T(`${t}.value 必须是字符串数组`, "ARCHIVE_V2_FIELD_INVALID");
}
function N(e, t, n) {
	if (O(e, n), e.identityId !== t && T(`${n}.identityId 与索引不一致`, "ARCHIVE_V2_PEOPLE_INVALID"), Object.hasOwn(e, "followed") && typeof e.followed != "boolean" && T(`${n}.followed 必须是布尔值`, "ARCHIVE_V2_FIELD_INVALID"), Object.hasOwn(e, "sourceRefs") && k(e.sourceRefs, `${n}.sourceRefs`), Object.hasOwn(e, "displayName") && M(e.displayName, `${n}.displayName`, "string"), Object.hasOwn(e, "aliases") && M(e.aliases, `${n}.aliases`, "string-array"), Object.hasOwn(e, "fields")) {
		O(e.fields, `${n}.fields`);
		for (let t of Object.keys(e.fields)) M(e.fields[t], `${n}.fields.${t}`);
	}
}
function P(e) {
	O(e, "archive.people"), k(e.order, "archive.people.order"), O(e.byId, "archive.people.byId");
	let t = /* @__PURE__ */ new Set();
	for (let n of e.order) A(n, "archive.people.order identityId"), t.has(n) && T("archive.people.order 不得重复", "ARCHIVE_V2_PEOPLE_INVALID"), t.add(n);
	let n = Object.keys(e.byId);
	(n.length !== t.size || n.some((e) => !t.has(e))) && T("archive.people.order 与 byId 不一致", "ARCHIVE_V2_PEOPLE_INVALID");
	for (let t of e.order) Object.hasOwn(e.byId, t) || T("archive.people.order 指向不存在的人物", "ARCHIVE_V2_PEOPLE_INVALID"), N(e.byId[t], t, `archive.people.byId.${t}`);
}
function F(e, t) {
	O(e, "archive");
	for (let t of Reflect.ownKeys(e)) (typeof t != "string" || !C.has(t)) && T("archive 包含未知顶层字段", "ARCHIVE_V2_ROOT_KEY_UNKNOWN");
	return e.schemaVersion !== 1 && T("archive.schemaVersion 不受支持", "ARCHIVE_V2_SCHEMA_UNSUPPORTED"), e.kind !== "myriad-knots-archive" && T("archive.kind 不匹配", "ARCHIVE_V2_KIND_MISMATCH"), A(e.chatId, "archive.chatId"), t !== void 0 && e.chatId !== t && T("archive.chatId 与当前聊天不一致", "ARCHIVE_V2_CHAT_MISMATCH"), O(e.identity, "archive.identity"), A(e.identity.characterLocator, "archive.identity.characterLocator"), A(e.identity.personaLocator, "archive.identity.personaLocator"), typeof e.identity.personaSummary != "string" && T("archive.identity.personaSummary 必须是字符串", "ARCHIVE_V2_FIELD_INVALID"), O(e.initialization, "archive.initialization"), e.initialization.confirmedAt !== null && typeof e.initialization.confirmedAt != "string" && T("archive.initialization.confirmedAt 必须是 null 或字符串", "ARCHIVE_V2_FIELD_INVALID"), k(e.initialization.sources, "archive.initialization.sources"), Object.hasOwn(e.initialization, "sourceFingerprint") && A(e.initialization.sourceFingerprint, "archive.initialization.sourceFingerprint"), e.initialization.sources.forEach((e, t) => {
		let n = `archive.initialization.sources[${t}]`;
		O(e, n);
		for (let t of [
			"kind",
			"locator",
			"fingerprint",
			"content"
		]) typeof e[t] != "string" && T(`${n}.${t} 必须是字符串`, "ARCHIVE_V2_FIELD_INVALID");
	}), P(e.people), k(e.events, "archive.events"), O(e.bonds, "archive.bonds"), O(e.nextSteps, "archive.nextSteps"), k(e.nextSteps.items, "archive.nextSteps.items"), O(e.progress, "archive.progress"), e.progress.lastConfirmedFloor !== null && (!Number.isInteger(e.progress.lastConfirmedFloor) || e.progress.lastConfirmedFloor < 0) && T("archive.progress.lastConfirmedFloor 必须是 null 或非负整数", "ARCHIVE_V2_FIELD_INVALID"), e;
}
function I(e, { expectedChatId: t } = {}) {
	try {
		return F(D(e), t);
	} catch (e) {
		throw e instanceof w ? e : new w("archive 无法安全验证或复制", "ARCHIVE_V2_CLONE_FAILED");
	}
}
//#endregion
//#region src/archive-v2-dossier-composition.js
var L = Object.freeze([
	"gender",
	"age",
	"appearance",
	"personality",
	"identity",
	"abilities",
	"likes",
	"dislikes",
	"principles",
	"relationships",
	"nsfwPreferences"
]);
new Set(L);
//#endregion
//#region src/ui/archive-v2-dossier-view.js
var R = Object.freeze({
	gender: "性别",
	age: "年龄",
	appearance: "外貌",
	personality: "性格",
	identity: "身份",
	abilities: "能力",
	likes: "喜欢",
	dislikes: "讨厌",
	principles: "原则",
	relationships: "关系",
	nsfwPreferences: "亲密偏好"
}), z = Object.freeze({
	card: "角色卡",
	greeting: "开场白",
	worldbook: "世界书",
	chat: "历史记忆"
}), B = 4;
function ee(e, t) {
	if (typeof e != "function") throw TypeError(`${t} 必须是函数`);
}
function V(e) {
	let t = e?.displayName?.value;
	return typeof t == "string" && t.trim() ? t.trim() : "未命名人物";
}
function H(e) {
	return e?.followed === !0;
}
function te(e) {
	if (e?.origin === "user" || e?.userProtected === !0) return "用户填写";
	let t = [];
	for (let n of Array.isArray(e?.sourceRefs) ? e.sourceRefs : []) {
		let e = z[n?.kind];
		e && !t.includes(e) && t.push(e);
	}
	return t.join("·") || "来源未记录";
}
function ne(e) {
	return {
		conflict: "档案已在其他操作中变化，本次没有覆盖。",
		stale: "当前聊天已经变化，迟到结果不会保存。",
		disabled: "千千结当前未启用，本次没有保存。",
		busy: "另一项档案操作尚未完成。",
		error: "操作没有完成，原档案保持不变。"
	}[e] ?? "操作没有完成，原档案保持不变。";
}
function re({ actions: e, documentRef: t = globalThis.document } = {}) {
	for (let [t, n] of [
		[e?.updatePerson, "actions.updatePerson"],
		[e?.renamePerson, "actions.renamePerson"],
		[e?.setFollowed, "actions.setFollowed"]
	]) ee(t, n);
	if (!t || typeof t.createElement != "function") throw TypeError("documentRef 必须能创建元素");
	let n = null, r = "dossier", i = !1, a = !1, o = null, s = 0, c = null, l = /* @__PURE__ */ new Map(), u = /* @__PURE__ */ new Map(), d = (e, n = "", r = "") => {
		let i = t.createElement(e);
		return n && (i.className = n), r !== "" && (i.textContent = r), i;
	}, f = (e, t, n, r = !1) => {
		let i = d("button", t, e);
		return i.type = "button", i.disabled = r, i.addEventListener("click", () => {
			i.disabled || n();
		}), i;
	}, p = () => {
		try {
			c?.requestRender?.();
		} catch {}
	};
	function m() {
		let e = c?.readResult?.archive;
		return (Array.isArray(e?.people?.order) ? e.people.order : []).map((t) => e.people.byId?.[t]).filter(Boolean);
	}
	function h(e) {
		let t = e.filter(H);
		return t.some((e) => e.identityId === n) || (n = t[0]?.identityId ?? null, i = !1, l.clear()), !n && r === "dossier" && (r = "fateBook"), t;
	}
	function g(e, t, n = () => {}) {
		if (a || c?.busy) return;
		let r = s;
		a = !0, o = {
			kind: "info",
			text: "正在使用档案 revision 安全保存…"
		}, p(), Promise.resolve().then(e).then((e) => {
			r === s && (a = !1, ["saved", "ready"].includes(e?.status) ? (o = {
				kind: "success",
				text: e.changed === !1 ? "内容没有变化。" : t
			}, n(e), e.archive && c?.onArchiveChange?.(e)) : o = {
				kind: "error",
				text: ne(e?.status)
			}, p());
		}, () => {
			r === s && (a = !1, o = {
				kind: "error",
				text: ne("error")
			}, p());
		});
	}
	function _(e) {
		return d("small", "basic-source", te(e));
	}
	function v(e, t) {
		let n = d("div", "basic-field");
		if (n.append(d("span", "basic-label", R[e])), i) {
			let r = d([
				"gender",
				"age",
				"identity"
			].includes(e) ? "input" : "textarea");
			r.value = l.has(e) ? l.get(e) : String(t?.value ?? ""), r.dataset.field = e, r.addEventListener("input", () => l.set(e, r.value)), n.append(r);
		} else {
			let e = typeof t?.value == "string" ? t.value : "";
			n.append(d("p", `basic-value${e ? "" : " missing"}`, e || "未提及")), n.append(_(t));
		}
		return n;
	}
	function y(t) {
		let n = d("section", "basic-info"), r = d("div", "basic-info-head"), s = d("div");
		s.append(d("h3", "", "基础信息"), d("p", "", "姓名与 11 项基础人设；用户修改会被保护。"));
		let u = d("div", i ? "basic-edit-actions" : "basic-info-actions"), m = a || c?.busy;
		i ? u.append(f("保存修改", "primary-action", () => {
			let n = (l.get("displayName") ?? V(t)).trim();
			if (!n) {
				o = {
					kind: "error",
					text: "人物姓名不能为空。"
				}, p();
				return;
			}
			let r = Object.fromEntries(L.map((e) => [e, l.get(e) ?? ""]).filter(([e, n]) => String(t.fields?.[e]?.value ?? "") !== n));
			g(() => e.updatePerson({
				identityId: t.identityId,
				...n === V(t) ? {} : { displayName: n },
				fields: r
			}), "基础信息已保存。", () => {
				i = !1, l.clear();
			});
		}, m), f("取消", "secondary-action", () => {
			i = !1, l.clear(), o = null, p();
		}, m)) : u.append(f("编辑", "secondary-action", () => {
			i = !0, o = null, l.clear(), l.set("displayName", V(t));
			for (let e of L) l.set(e, String(t.fields?.[e]?.value ?? ""));
			p();
		}, m)), r.append(s, u), n.append(r);
		let h = d("div", "basic-fields"), y = d("div", "basic-field");
		if (y.append(d("span", "basic-label", "姓名")), i) {
			let e = d("input");
			e.value = l.get("displayName") ?? V(t), e.dataset.field = "displayName", e.addEventListener("input", () => l.set("displayName", e.value)), y.append(e);
		} else y.append(d("p", "basic-value", V(t)), _(t.displayName));
		let b = d("div", "basic-row basic-row-three");
		b.append(y, v("gender", t.fields?.gender), v("age", t.fields?.age)), h.append(b);
		for (let e of L.filter((e) => !["gender", "age"].includes(e))) {
			let n = d("div", "basic-row basic-row-one");
			n.append(v(e, t.fields?.[e])), h.append(n);
		}
		return n.append(h), o && n.append(d("p", `basic-message ${o.kind}`, o.text)), n;
	}
	function b() {
		let e = c?.followedProfileResult ?? { status: "idle" }, t = e.status ?? "idle", n = m().filter(H).some((e) => L.some((t) => {
			let n = e.fields?.[t]?.value;
			return typeof n == "string" && n.trim() !== "";
		})), r = [
			"idle",
			"ready",
			"saved"
		].includes(t);
		if (n && r) return null;
		let i = d("section", "generation-banner"), o = a || c?.busy;
		if (r) {
			i.append(d("h3", "", "生成基础人设")), i.append(d("p", "", "先生成全部关注人物的内存草稿，你确认后才会写入。"));
			let t = d("div", "generation-actions");
			return t.append(f("生成基础人设", "primary-action", () => c?.generateFollowedProfiles?.(), o || e.followedCount === 0)), i.append(t), i;
		}
		if (t === "empty") return i.append(d("h3", "", "当前没有关注人物"), d("p", "", "可在因缘簿中将静默人物设为关注。")), i;
		if (t === "running" || t === "saving") return i.append(d("h3", "", t === "running" ? "正在生成基础人设" : "正在保存基础人设"), d("p", "", "切换聊天或禁用插件时，迟到结果不会覆盖当前档案。")), i;
		if (t === "draft") {
			i.append(d("h3", "", "基础人设草稿"), d("p", "", "以下只是内存草稿，保存时仍会保护用户手工字段。"));
			for (let t of Array.isArray(e.draft?.people) ? e.draft.people : []) {
				let e = d("div", "pending-card");
				e.append(d("b", "", t.displayName || "未命名人物"));
				for (let n of L) {
					let r = t.fields?.[n]?.value;
					typeof r == "string" && r.trim() && e.append(d("p", "pending-value", `${R[n]}：${r}`));
				}
				i.append(e);
			}
			let t = d("div", "generation-actions");
			return t.append(f("保存基础人设", "primary-action", () => c?.commitFollowedProfiles?.(), o)), i.append(t), i;
		}
		if (i.append(d("h3", "", "基础人设未保存"), d("p", "", {
			conflict: "档案在草稿生成后已变化，本次没有覆盖。",
			stale: "当前聊天已经变化。",
			disabled: "千千结当前未启用。",
			memory_not_ready: "记忆扫描尚未完成。",
			people_missing: "人物整理结果不可用。"
		}[t] ?? "本次操作没有完成，正式档案没有改变。")), ![
			"stale",
			"disabled",
			"memory_not_ready",
			"people_missing"
		].includes(t)) {
			let e = d("div", "generation-actions");
			e.append(f("重新生成基础人设", "primary-action", () => c?.generateFollowedProfiles?.(), o)), i.append(e);
		}
		return i;
	}
	function x(e) {
		if (!e) return d("p", "layer-empty", "还没有关注人物。请打开“因缘簿”选择一位人物。");
		let t = d("section", "dossier-card"), n = d("header", "profile-summary");
		n.append(d("span", "subject-tag tag-c", "C"));
		let r = d("div");
		r.append(d("h2", "", V(e)), d("p", "", "当前关注人物的稳定关系档案")), n.append(r), t.append(n);
		let i = b();
		i && t.append(i), t.append(y(e));
		let a = d("section", "dynamic-info"), o = d("div", "dynamic-info-head"), s = d("div");
		return s.append(d("h3", "", "动态信息"), d("p", "", "事件、关系与下一步仍使用 V2 档案，本批不扩展未实现业务。")), o.append(s), a.append(o, d("p", "layer-empty", "动态状态尚未接入。")), t.append(a), t;
	}
	function S(e, t) {
		let a = d("section", "people-content more-view"), o = d("div", "content-heading"), s = e.filter((e) => !t.includes(e.identityId));
		o.append(d("h2", "", `更多人物（${s.length}）`), d("p", "", "选择后回到该人物档案。")), a.append(o);
		let c = d("div", "more-list");
		for (let e of s) c.append(f(V(e), "more-person", () => {
			n = e.identityId, r = "dossier", i = !1, p();
		}));
		return s.length || c.append(d("p", "layer-empty", "所有关注人物都已在快捷栏中。")), a.append(c), a;
	}
	function C(t) {
		let n = d("section", "people-content fate-book-view"), r = d("div", "content-heading"), i = t.filter(H).length;
		r.append(d("h2", "", "因缘簿"), d("p", "", `当前关注 ${i} 人 · 静默 ${t.length - i} 人。“关注”只表示进入千人主列表，不代表恋爱关系已经成立。`)), n.append(r);
		let s = d("div", "people-list");
		for (let n of t) {
			let t = d("article", "module person-card"), r = d("div", "fate-person-head"), i = d("div");
			i.append(d("b", "fate-person-name", V(n)), d("small", "fate-person-state", H(n) ? "当前关注" : "静默人物")), r.append(i, d("span", `subject-tag ${H(n) ? "tag-c" : "tag-u"}`, H(n) ? "C" : "静")), t.append(r);
			let l = d("div", "fate-person-rename"), m = d("input");
			m.value = u.get(n.identityId) ?? V(n), m.setAttribute("aria-label", `修改${V(n)}的姓名`), m.addEventListener("input", () => u.set(n.identityId, m.value)), l.append(m, f("保存名称", "person-action", () => {
				let t = (u.get(n.identityId) ?? m.value).trim();
				if (!t) {
					o = {
						kind: "error",
						text: "人物姓名不能为空。"
					}, p();
					return;
				}
				g(() => e.renamePerson({
					identityId: n.identityId,
					displayName: t
				}), "人物姓名已保存。", () => u.delete(n.identityId));
			}, a || c?.busy)), t.append(l);
			let h = d("div", "person-actions");
			h.append(f(H(n) ? "转为静默" : "设为关注", "person-action", () => {
				g(() => e.setFollowed({
					identityId: n.identityId,
					followed: !H(n)
				}), H(n) ? "已转为静默人物。" : "已设为关注人物。");
			}, a || c?.busy)), t.append(h), s.append(t);
		}
		return t.length || s.append(d("p", "pool-empty", "正式档案中还没有人物。")), n.append(s), o && n.append(d("p", `basic-message ${o.kind}`, o.text)), n;
	}
	function w(e = {}) {
		c = e;
		let t = m(), a = h(t), s = d("section", "people-page archive-v2-dossier");
		s.__stageKey = "archive-ready";
		let l = d("div", "profile-rail-shell"), u = d("div", "profile-switcher");
		u.setAttribute("role", "tablist");
		let g = a.slice(0, B), _ = a.find((e) => e.identityId === n);
		_ && !g.includes(_) && (g = [...g.slice(0, 3), _]);
		let v = g.map((e) => e.identityId);
		for (let e of g) {
			let t = r === "dossier" && e.identityId === n, a = f("", `profile-tab${t ? " active" : ""}`, () => {
				n = e.identityId, r = "dossier", i = !1, o = null, p();
			});
			a.dataset.profileId = e.identityId, a.setAttribute("role", "tab"), a.setAttribute("aria-selected", String(t)), a.append(d("span", "subject-tag tag-c", "C"), d("span", "profile-tab-name", V(e))), u.append(a);
		}
		let y = d("div", "profile-tools");
		for (let [e, t] of [["more", "更多"], ["fateBook", "因缘簿"]]) y.append(f(t, `profile-tool${r === e ? " active" : ""}`, () => {
			r = r === e && n ? "dossier" : e, i = !1, o = null, p();
		}));
		return l.append(u, y), s.append(l), Array.isArray(c?.readResult?.warnings) && c.readResult.warnings.length && s.append(d("p", "basic-message error", "当前身份与建档时有所变化，请确认人物后再继续。")), r === "more" ? s.append(S(a, v)) : r === "fateBook" ? s.append(C(t)) : s.append(x(_)), s;
	}
	function T() {
		s += 1, a = !1, i = !1, o = null, l.clear(), u.clear();
	}
	return Object.freeze({
		render: w,
		invalidate: T
	});
}
//#endregion
//#region src/ui/archive-v2-initialization-view.js
var ie = Object.freeze([
	["sources", "来源"],
	["candidates", "人物"],
	["profiles", "档案"],
	["completed", "完成"]
]), ae = Object.freeze({
	gender: "性别",
	age: "年龄",
	appearance: "外貌",
	personality: "性格",
	identity: "身份",
	abilities: "能力",
	likes: "喜欢",
	dislikes: "讨厌",
	principles: "原则",
	relationships: "关系"
}), oe = Object.freeze({
	...ae,
	nsfwPreferences: "亲密偏好"
}), se = Object.freeze({
	card: "角色卡",
	greeting: "开场白",
	worldbook: "世界书",
	chat: "聊天正文"
});
function ce(e, t) {
	if (typeof e != "function") throw TypeError(`${t} 必须是函数`);
}
function le(e, t = "操作没有完成，当前内容已保留，请重试。") {
	let n = typeof e?.code == "string" ? e.code : "";
	return n.includes("NO_SOURCES") ? "请至少选择一个可用来源。" : n.includes("CHAT_RANGE") ? "聊天楼层范围无效，请检查开始和结束楼层。" : n.includes("CONTEXT") ? "当前聊天已经变化，请重新打开此页面。" : n.includes("BUSY") ? "当前操作尚未完成，请稍候。" : t;
}
function ue(e) {
	return e === "conflict" ? "档案在保存时发生冲突，当前编辑已保留，请重试。" : e === "stale" ? "当前聊天已经变化，请重新打开此页面。" : e === "disabled" ? "千千结当前未启用，当前编辑已保留。" : "";
}
function de(e) {
	return e === "greeting_transient_swipe_mismatch" ? "开场白正在切换，本次没有采用不稳定内容。" : e === "chat_swipe_unstable" ? "部分聊天楼层正在切换，本次已安全跳过。" : typeof e == "string" && e.includes("worldbook") ? "部分世界书未读取，不影响其他可用来源。" : "部分来源未读取，不影响其他可用来源。";
}
function fe(e) {
	return String(e ?? "").split(/[\n,，]/).map((e) => e.trim()).filter(Boolean);
}
function pe({ composition: e, memory: t, followedProfiles: n, dossier: r, dossierViewFactory: i = re, documentRef: a = globalThis.document, onArchiveReady: o = () => {}, onCompleted: s = () => {} } = {}) {
	let c = e?.flow, l = [
		"inspect",
		"start",
		"getState"
	].every((e) => typeof t?.[e] == "function"), u = l && typeof t?.consolidatePeople == "function" && typeof t?.confirmPeople == "function", d = [
		"inspect",
		"generate",
		"commit",
		"getState"
	].every((e) => typeof n?.[e] == "function");
	for (let [t, n] of [
		[e?.readArchive, "composition.readArchive"],
		[e?.currentIdentity, "composition.currentIdentity"],
		[c?.getState, "flow.getState"],
		[c?.loadSources, "flow.loadSources"],
		[c?.setSourceSelected, "flow.setSourceSelected"],
		[c?.recognizeCandidates, "flow.recognizeCandidates"],
		[c?.setCandidateSelected, "flow.setCandidateSelected"],
		[c?.renameCandidate, "flow.renameCandidate"],
		[c?.setCandidateAliases, "flow.setCandidateAliases"],
		[c?.mergeCandidates, "flow.mergeCandidates"],
		[c?.removeCandidate, "flow.removeCandidate"],
		[c?.generateProfiles, "flow.generateProfiles"],
		[c?.setProfileField, "flow.setProfileField"],
		[c?.backToSources, "flow.backToSources"],
		[c?.backToCandidates, "flow.backToCandidates"],
		[c?.commitInitialization, "flow.commitInitialization"]
	]) ce(t, n);
	if (!a || typeof a.createElement != "function") throw TypeError("documentRef 必须能创建元素");
	if (ce(o, "onArchiveReady"), ce(s, "onCompleted"), r !== void 0 && typeof i != "function") throw TypeError("dossierViewFactory 必须是函数");
	let f = r === void 0 ? null : i({
		actions: r,
		documentRef: a
	}), p = null, m = null, h = null, g = null, _ = !1, v = !1, y = 0, b = !1, x = !1, S = "idle", C = null, w = null, T = null, E = null, D = null, O = null, k = null, A = null, j = null, M = "", N = null, P = null, F = "", L = "idle", R = !1, z = -1, B = 0, ee = [], V = /* @__PURE__ */ new Map(), H = /* @__PURE__ */ new Map(), te = /* @__PURE__ */ new Map(), ne = "", pe = {
		start: "",
		end: ""
	}, U = (e, t = "", n = "") => {
		let r = a.createElement(e);
		return t && (r.className = t), n !== "" && (r.textContent = n), r;
	}, W = (e, ...t) => {
		for (let n of t) n != null && e.append(n);
		return e;
	}, me = (e, t, n) => {
		e.addEventListener(t, n), ee.push(() => e.removeEventListener(t, n));
	}, he = () => {
		for (let e of ee.splice(0)) e();
	}, ge = (e) => _ && !v && e === y && p !== null;
	function _e(e) {
		for (let t = e; t; t = t.parentNode) if (t === p) return !0;
		return !1;
	}
	function ve(e, t) {
		return t && (e.dataset.focusKey = t, e.setAttribute("data-focus-key", t)), e;
	}
	function ye() {
		let e = a.activeElement;
		return _e(e) && typeof e?.dataset?.focusKey == "string" ? e.dataset.focusKey : "";
	}
	function be(e) {
		return !e || !g ? null : [...g.querySelectorAll("[data-focus-key]")].find((t) => t.dataset.focusKey === e) ?? null;
	}
	function xe(e, t, n) {
		let r = H.get(e);
		return r?.has(t) ? r.get(t) : n;
	}
	function Se(e, t, n) {
		let r = H.get(e);
		r || (r = /* @__PURE__ */ new Map(), H.set(e, r)), r.set(t, n);
	}
	function G(e, t, n, r = !1, i = "") {
		let a = ve(U("button", t, e), i);
		return a.type = "button", a.disabled = r, me(a, "click", () => {
			if (!_ || a.disabled) return;
			let e = tt();
			if (b || e.busy === !0 || P) {
				Z({ restoreFocusKey: ye() });
				return;
			}
			n();
		}), a;
	}
	function Ce(e) {
		if (M) return M;
		if (l && S === "memory") {
			if (w?.status === "checking") return "正在检查已有扫描进度。";
			if (w?.status === "scanning") return "记忆扫描正在后台进行。";
			if (w?.status === "interrupted") return "扫描可以从已保存的批次继续。";
			if (w?.status === "ready") return "记忆扫描已经完成。";
		}
		if (d && S === "ready") {
			if (k?.status === "running") return "正在生成关注人物的基础人设。";
			if (k?.status === "saving") return "正在保存基础人设。";
			if (k?.status === "draft") return "基础人设草稿已生成，确认后才会保存。";
			if (k?.status === "saved") return "基础人设已经保存。";
			if (k?.status === "error") return "基础人设操作没有完成，正式档案没有改变。";
		}
		return x ? "正在处理，请稍候。" : S === "loading" ? "正在读取当前档案。" : e?.stage === "sources" ? "请确认本次用于建档的来源。" : e?.stage === "candidates" ? "请决定要收入档案的人物。" : e?.stage === "profiles" ? "请审核基础档案，确认后再保存。" : e?.stage === "completed" ? "档案已经建立。" : "";
	}
	function we(e) {
		if (l) {
			m.replaceChildren();
			return;
		}
		let t = Math.max(0, ie.findIndex(([t]) => t === e)), n = U("ol", "qqj-v2-progress-list");
		ie.forEach(([e, r], i) => {
			let a = U("li", "qqj-v2-progress-step");
			i < t && (a.className += " is-complete"), i === t && (a.className += " is-current", a.setAttribute("aria-current", "step")), W(a, U("span", "qqj-v2-knot", String(i + 1)), U("span", "qqj-v2-step-label", r)), n.append(a);
		}), m.replaceChildren(n);
	}
	function K(e, t, n) {
		let r = U("header", "qqj-v2-heading"), i = U("h2", "qqj-v2-title", e);
		return i.tabIndex = -1, W(r, i, U("p", "qqj-v2-intro", t)), r.__heading = i, r.__stageKey = n, r;
	}
	function Te() {
		return S === "loading" || S === "idle" ? K("正在打开千千结", "只读取当前聊天的建档状态，不会调用 AI 或写入内容。", "loading") : S === "disabled" ? K("千千结当前未启用", "启用后重新打开此页面，即可继续整理当前聊天。", "disabled") : S === "stale" ? K("当前聊天已经变化", "请重新打开初次建档页面，旧结果不会进入新聊天。", "stale") : S === "error" ? K("暂时无法读取档案", "读取没有完成，请稍后重新打开此页面。", "read-error") : S === "ready" ? je() : Ye();
	}
	function Ee(e) {
		let t = /* @__PURE__ */ new Set([
			"idle",
			"ready",
			"empty",
			"running",
			"draft",
			"saving",
			"saved",
			"error",
			"conflict",
			"stale",
			"disabled",
			"source_changed",
			"memory_not_ready",
			"people_missing",
			"uninitialized"
		]), n = e && typeof e == "object" ? e : {};
		return Object.freeze({
			status: t.has(n.status) ? n.status : "error",
			followedCount: Number.isSafeInteger(n.followedCount) ? Math.max(0, n.followedCount) : 0,
			enrichedCount: Number.isSafeInteger(n.enrichedCount) ? Math.max(0, n.enrichedCount) : 0,
			savedFieldCount: Number.isSafeInteger(n.savedFieldCount) ? Math.max(0, n.savedFieldCount) : 0,
			protectedFieldCount: Number.isSafeInteger(n.protectedFieldCount) ? Math.max(0, n.protectedFieldCount) : 0,
			draft: n.draft && typeof n.draft == "object" ? n.draft : null
		});
	}
	function De(e) {
		let t = (Array.isArray(e?.people?.order) ? e.people.order : []).map((t) => e?.people?.byId?.[t]).filter((e) => e?.followed === !0), n = t.filter((e) => Object.values(e?.fields ?? {}).some((e) => {
			let t = e?.value;
			return typeof t == "string" && t.trim() !== "";
		})).length;
		return Ee({
			status: t.length ? "ready" : "empty",
			followedCount: t.length,
			enrichedCount: n
		});
	}
	function Oe(e) {
		if (e?.status !== "created" || !Number.isSafeInteger(e.revision) || e.revision < 1) return null;
		let t;
		try {
			t = I(e.archive);
		} catch {
			return null;
		}
		return {
			status: "ready",
			archive: t,
			revision: e.revision,
			warnings: Array.isArray(e.warnings) ? e.warnings : []
		};
	}
	function ke(e) {
		return Array.isArray(e?.people) ? e.people.reduce((e, t) => e + Object.keys(t?.fields ?? {}).length, 0) : 0;
	}
	function Ae(e) {
		let t = Array.isArray(e?.people) ? e.people : [], n = U("div", "qqj-v2-followed-profile-list");
		for (let e of t) {
			let t = U("section", "qqj-v2-followed-profile-person");
			t.append(U("h4", "qqj-v2-followed-profile-name", e.displayName || "未命名人物"));
			let r = U("dl", "qqj-v2-followed-profile-fields");
			for (let t of Object.keys(oe)) {
				let n = e?.fields?.[t]?.value;
				typeof n != "string" || !n.trim() || W(r, U("dt", "qqj-v2-followed-profile-field-name", oe[t]), U("dd", "qqj-v2-followed-profile-field-value", n));
			}
			t.append(r), n.append(t);
		}
		return n;
	}
	function q() {
		let e = k ?? Ee({ status: "idle" }), t = U("section", "qqj-v2-followed-profiles");
		if (t.append(U("h3", "qqj-v2-subtitle", "关注人物基础人设")), ["idle", "ready"].includes(e.status)) {
			t.append(U("p", "qqj-v2-reason", "一次为全部关注人物生成基础人设草稿，确认前不会写入档案。"));
			let n = U("div", "qqj-v2-actions");
			return n.append(G("生成基础人设", "qqj-v2-button qqj-v2-primary", Ke, b || e.followedCount === 0, "followed-profiles:generate")), t.append(n), t;
		}
		if (e.status === "empty") return t.append(U("p", "qqj-v2-reason", "当前没有关注人物，无需生成基础人设。")), t;
		if (e.status === "running") return t.append(U("p", "qqj-v2-reason", "正在为全部关注人物生成基础人设。关闭面板不会取消本次请求。")), t;
		if (e.status === "saving") return t.append(U("p", "qqj-v2-reason", "正在使用档案 revision 安全保存，请稍候。")), t;
		if (e.status === "saved") return t.append(U("p", "qqj-v2-count", `已保存 ${e.savedFieldCount} 个字段`)), e.protectedFieldCount && t.append(U("p", "qqj-v2-reason", `另有 ${e.protectedFieldCount} 个用户保护字段保持不变。`)), t;
		if (e.status === "draft") {
			let n = ke(e.draft);
			t.append(U("p", "qqj-v2-reason", "以下内容只是内存草稿，点击保存后才会写入正式档案。")), t.append(Ae(e.draft));
			let r = U("div", "qqj-v2-actions");
			return r.append(G("保存基础人设", "qqj-v2-button qqj-v2-primary", qe, b || n === 0, "followed-profiles:commit")), n === 0 && r.append(U("p", "qqj-v2-reason", "本次没有可靠字段，请重新生成。")), t.append(r), t;
		}
		let n = {
			conflict: "档案在草稿生成后已经变化，本次没有覆盖，请重新生成。",
			source_changed: "聊天记忆已经变化，本次没有生成草稿。",
			memory_not_ready: "聊天记忆扫描尚未完成，暂时不能补全人设。",
			people_missing: "人物整理结果不可用，暂时不能补全人设。",
			stale: "当前聊天已经变化，迟到结果不会进入新聊天。",
			disabled: "千千结当前未启用。",
			error: "基础人设操作没有完成，正式档案没有改变。"
		}[e.status] ?? "基础人设操作没有完成，正式档案没有改变。";
		if (t.append(U("p", "qqj-v2-warning", n)), ![
			"disabled",
			"stale",
			"memory_not_ready",
			"people_missing"
		].includes(e.status)) {
			let e = U("div", "qqj-v2-actions");
			e.append(G("重新生成基础人设", "qqj-v2-button qqj-v2-primary", Ke, b, "followed-profiles:retry")), t.append(e);
		}
		return t;
	}
	function je() {
		if (f) return f.render({
			readResult: C,
			followedProfileResult: k ?? Ee({ status: "idle" }),
			busy: b || Le() !== null,
			generateFollowedProfiles: Ke,
			commitFollowedProfiles: qe,
			onArchiveChange(e) {
				C = {
					status: "ready",
					archive: e.archive,
					revision: e.revision,
					warnings: Array.isArray(e.warnings) ? e.warnings : []
				};
				try {
					o(e);
				} catch {}
			},
			requestRender() {
				Z();
			}
		});
		let e = U("section", "qqj-v2-ready"), t = K("档案已建立", "当前聊天已有千千结档案，本页只展示安全摘要。", "archive-ready");
		e.append(t);
		let n = C?.archive, r = Array.isArray(n?.people?.order) ? n.people.order : [], i = r.filter((e) => n?.people?.byId?.[e]?.followed !== !1), a = r.filter((e) => n?.people?.byId?.[e]?.followed === !1);
		if (e.append(U("p", "qqj-v2-count", `关注 ${i.length} 人 · 静默 ${a.length} 人`)), i.length) {
			let t = U("ul", "qqj-v2-name-list");
			for (let e of i) {
				let r = n?.people?.byId?.[e]?.displayName?.value;
				t.append(U("li", "", typeof r == "string" && r.trim() ? r : "未命名人物"));
			}
			e.append(t);
		}
		if (a.length) {
			let t = U("details", "qqj-v2-memory-silent");
			t.append(U("summary", "", `静默人物（${a.length}）`));
			let r = U("ul", "qqj-v2-name-list");
			for (let e of a) {
				let t = n?.people?.byId?.[e]?.displayName?.value;
				r.append(U("li", "", typeof t == "string" && t.trim() ? t : "未命名人物"));
			}
			t.append(r), e.append(t);
		}
		return Array.isArray(C?.warnings) && C.warnings.length && e.append(U("p", "qqj-v2-warning", "当前身份与建档时有所变化，请确认人物后再继续。")), d && e.append(q()), e;
	}
	function J(e) {
		let t = /* @__PURE__ */ new Set([
			"idle",
			"checking",
			"uninitialized",
			"scanning",
			"interrupted",
			"ready",
			"conflict",
			"source_changed",
			"stale",
			"disabled",
			"error"
		]), n = e && typeof e == "object" ? e : {}, r = t.has(n.status) ? n.status : "error", i = (e, t) => Number.isSafeInteger(e) ? e : t, a = /* @__PURE__ */ new Set([
			"idle",
			"uninitialized",
			"running",
			"ready",
			"error",
			"committing",
			"conflict",
			"committed",
			"stale",
			"disabled"
		]);
		return Object.freeze({
			status: r,
			targetFloor: n.targetFloor === null ? null : i(n.targetFloor, null),
			eligibleFloorCount: n.eligibleFloorCount === null ? null : i(n.eligibleFloorCount, null),
			completedBatches: Math.max(0, i(n.completedBatches, 0)),
			totalBatches: Math.max(0, i(n.totalBatches, 0)),
			currentBatchIndex: n.currentBatchIndex === null ? null : i(n.currentBatchIndex, null),
			overRecommendedLimit: n.overRecommendedLimit === !0,
			peopleStatus: a.has(n.peopleStatus) ? n.peopleStatus : "uninitialized",
			peopleResult: n.peopleResult && typeof n.peopleResult == "object" ? n.peopleResult : null,
			followedCount: Math.max(0, i(n.followedCount, 0)),
			silentCount: Math.max(0, i(n.silentCount, 0))
		});
	}
	function Me(e) {
		let t = U("div", "qqj-v2-memory-progress"), n = Math.min(e.completedBatches, e.totalBatches);
		t.append(U("p", "qqj-v2-memory-progress-copy", `已完成 ${n} / ${e.totalBatches} 批`));
		let r = U("progress", "qqj-v2-memory-progress-meter");
		return r.max = Math.max(1, e.totalBatches), r.value = n, r.setAttribute("aria-label", "记忆扫描进度"), r.setAttribute("aria-valuemin", "0"), r.setAttribute("aria-valuemax", String(e.totalBatches)), r.setAttribute("aria-valuenow", String(n)), t.append(r), Number.isSafeInteger(e.currentBatchIndex) && t.append(U("p", "qqj-v2-memory-current", `正在处理第 ${e.currentBatchIndex + 1} 批`)), t;
	}
	function Ne(e) {
		let t = U("div", "qqj-v2-actions");
		return t.append(G(e, "qqj-v2-button qqj-v2-primary", Ve, x || X() !== null, "memory:start")), t;
	}
	function Pe() {
		let e = w ?? J({ status: "error" }), t = U("section", "qqj-v2-memory");
		if (e.status === "uninitialized") {
			t.append(K("扫描当前聊天的记忆", "千千结会按顺序处理当前完整聊天，并在每批完成后保存进度。关闭面板不会中断后台扫描。", "memory-preview"));
			let n = U("div", "qqj-v2-memory-facts");
			return W(n, U("p", "qqj-v2-count", `截至第 ${e.targetFloor} 楼`), U("p", "qqj-v2-count", `共 ${e.eligibleFloorCount ?? 0} 个 AI 正文楼层`), U("p", "qqj-v2-count", `预计 ${e.totalBatches} 批`)), t.append(n), e.overRecommendedLimit && t.append(U("p", "qqj-v2-warning", "当前有效 AI 楼层超过 500 层，扫描可能耗时较长，且人物整理精度可能受到影响。")), t.append(Ne("开始扫描记忆")), t;
		}
		if ([
			"checking",
			"scanning",
			"interrupted",
			"idle"
		].includes(e.status)) return t.append(K(e.status === "interrupted" ? "继续扫描聊天记忆" : "正在扫描聊天记忆", "进度按批保存。你可以关闭面板，后台扫描会继续运行。", "memory-scanning")), t.append(Me(e)), !T && [
			"idle",
			"scanning",
			"interrupted"
		].includes(e.status) && t.append(Ne("继续扫描")), t;
		if (e.status === "ready") return u ? Y(e) : (t.append(K("记忆扫描完成，等待人物整理", "当前批次记忆已经安全保存。本阶段不会展示或推断人物名单。", "memory-ready")), t.append(Me(e)), t);
		let n = {
			conflict: ["扫描进度保存发生冲突", "旧进度没有被覆盖，请重新打开后继续。"],
			source_changed: ["聊天正文已经变化", "旧扫描进度没有被覆盖，请确认当前聊天后再继续。"],
			stale: ["当前聊天已经变化", "迟到的扫描结果不会进入新聊天，请重新打开此页面。"],
			disabled: ["千千结当前未启用", "启用后重新打开此页面，即可继续扫描。"],
			error: ["暂时无法扫描记忆", "操作没有完成，已保存的批次不会丢失。请手动重新扫描，不会自动重试。"]
		}, [r, i] = n[e.status] ?? n.error;
		return t.append(K(r, i, `memory-${e.status}`)), e.status === "error" && t.append(Ne("重新扫描")), t;
	}
	function Fe(e) {
		let t = Array.isArray(e.peopleResult?.people) ? e.peopleResult.people : [], n = `${e.peopleResult?.scanId ?? ""}\u0000${e.peopleResult?.sourceFingerprint ?? ""}`;
		if (ne !== n) {
			te.clear();
			for (let e of t) te.set(e.localId, e.recommendation === "romance_candidate");
			ne = n;
		}
		return t;
	}
	function Ie(e, t) {
		let n = U("article", "qqj-v2-memory-person"), r = `qqj-v2-memory-person-${++B}`, i = U("label", "qqj-v2-memory-person-choice");
		i.htmlFor = r;
		let a = ve(U("input", "qqj-v2-checkbox"), `memory-person:${e.localId}`);
		return a.id = r, a.type = "checkbox", a.checked = te.get(e.localId) === !0, a.disabled = x || ["committing", "committed"].includes(t.peopleStatus), me(a, "change", () => {
			te.set(e.localId, a.checked), Z({ restoreFocusKey: `memory-person:${e.localId}` });
		}), W(i, a, U("strong", "", e.displayName)), n.append(i), n;
	}
	function Y(e) {
		let t = U("section", "qqj-v2-memory qqj-v2-memory-people");
		if (["idle", "uninitialized"].includes(e.peopleStatus)) {
			t.append(K("记忆扫描完成，可以整理人物", "点击后只需一次 AI 调用：它会读取已保存的批次，归并全部人物并给出攻略对象建议。", "memory-people-uninitialized")), t.append(Me(e));
			let n = U("div", "qqj-v2-actions");
			return n.append(G("整理人物", "qqj-v2-button qqj-v2-primary", Ue, x || E !== null, "memory:people:start")), t.append(n), t;
		}
		if (e.peopleStatus === "running") return t.append(K("正在整理千人", "关闭面板不会中断；切换聊天或禁用插件会使旧结果失效。", "memory-people-running")), t.append(Me(e)), t;
		if (e.peopleStatus === "error") {
			t.append(K("人物整理没有完成", "已保存的批次没有改变。你可以手动重新整理，不会自动重试。", "memory-people-error"));
			let e = U("div", "qqj-v2-actions");
			return e.append(G("重新整理", "qqj-v2-button qqj-v2-primary", Ue, x, "memory:people:retry")), t.append(e), t;
		}
		if (e.peopleStatus === "committed") {
			t.append(K("人物已经写入档案", "关注人物会进入千人主列表；静默人物保留在同一档案中，不消耗下一批人设补全。", "memory-people-committed")), t.append(U("p", "qqj-v2-count", `关注 ${e.followedCount} 人 · 静默 ${e.silentCount} 人`));
			let n = U("details", "qqj-v2-memory-silent");
			n.append(U("summary", "", `静默人物（${e.silentCount}）`));
			let r = Fe(e).filter((e) => !te.get(e.localId)), i = U("ul", "qqj-v2-name-list");
			for (let e of r) i.append(U("li", "", e.displayName));
			return n.append(i), t.append(n), t;
		}
		let n = Fe(e);
		t.append(K(e.peopleStatus === "conflict" ? "正式档案已经存在" : "选择要关注的人物", e.peopleStatus === "conflict" ? "候选草稿仍然保留，本次没有覆盖已有 archive-v2。" : "请选择要关注的人物，其余人物将暂时静默。", `memory-people-${e.peopleStatus}`));
		let r = U("div", "qqj-v2-memory-people-list");
		for (let t of n) r.append(Ie(t, e));
		t.append(r);
		let i = [...te.values()].filter(Boolean).length;
		if (t.append(U("p", "qqj-v2-selection-count", `已选择关注 ${i} 人；其余 ${n.length - i} 人将静默保存`)), e.peopleStatus !== "conflict") {
			let n = U("div", "qqj-v2-actions");
			n.append(G(e.peopleStatus === "committing" ? "正在确认" : "确认关注人物", "qqj-v2-button qqj-v2-primary", We, x || e.peopleStatus === "committing", "memory:people:confirm")), t.append(n);
		}
		return t;
	}
	let X = () => T || E || D, Le = () => A || j;
	function Re() {
		O !== null && ((a.defaultView?.clearInterval ?? globalThis.clearInterval)(O), O = null);
	}
	function ze() {
		if (!(!_ || v || !p || !X())) try {
			w = J(t.getState()), S = "memory", Z();
		} catch {}
	}
	function Be() {
		O !== null || !_ || !X() || (O = (a.defaultView?.setInterval ?? globalThis.setInterval)(ze, 350), O?.unref?.());
	}
	function Ve() {
		if (!l || !_ || v || X()) return;
		b = !0, M = "";
		let e;
		try {
			e = Promise.resolve(t.start());
		} catch {
			e = Promise.reject(/* @__PURE__ */ Error("memory start failed"));
		}
		T = e;
		try {
			w = J(t.getState());
		} catch {
			w = J({ status: "checking" });
		}
		S = "memory", Be(), Z({ restoreFocusKey: "memory:start" }), e.then((e) => ({
			ok: !0,
			result: e
		}), () => ({ ok: !1 })).then((t) => {
			T === e && (T = null, Re(), !(!_ || v || !p) && (b = !1, w = J(t.ok ? t.result : { status: "error" }), S = "memory", Z({ restoreFocusKey: "memory:start" })));
		});
	}
	function He(e, n, r, { notify: i = !1 } = {}) {
		n.then((e) => ({
			ok: !0,
			result: e
		}), () => ({
			ok: !1,
			result: { status: "error" }
		})).then((a) => {
			if (e() !== n || (E === n && (E = null), D === n && (D = null), Re(), !_ || v || !p)) return;
			b = !1;
			try {
				w = J(t.getState());
			} catch {
				w = J(a.ok ? a.result : {
					status: "ready",
					peopleStatus: "error"
				});
			}
			let c = i && a.ok ? Oe(a.result) : null;
			if (c ? (C = c, S = "ready", d && (k = De(c.archive))) : S = "memory", Z({ restoreFocusKey: c ? "" : r }), c) {
				try {
					s(a.result);
				} catch {}
				try {
					o(a.result);
				} catch {}
			}
		});
	}
	function Ue() {
		if (!u || !_ || v || X()) return;
		b = !0, M = "";
		let e;
		try {
			e = Promise.resolve(t.consolidatePeople());
		} catch {
			e = Promise.reject(/* @__PURE__ */ Error("memory people failed"));
		}
		E = e;
		try {
			w = J(t.getState());
		} catch {
			w = J({
				status: "ready",
				peopleStatus: "running"
			});
		}
		S = "memory", Be(), Z({ restoreFocusKey: "memory:people:start" }), He(() => E, e, "memory:people:start");
	}
	function We() {
		if (!u || !_ || v || X()) return;
		b = !0, M = "";
		let e = [...te].filter(([, e]) => e).map(([e]) => e), n;
		try {
			n = Promise.resolve(t.confirmPeople({ selectedLocalIds: e }));
		} catch {
			n = Promise.reject(/* @__PURE__ */ Error("memory commit failed"));
		}
		D = n;
		try {
			w = J(t.getState());
		} catch {
			w = J({
				status: "ready",
				peopleStatus: "committing"
			});
		}
		S = "memory", Be(), Z({ restoreFocusKey: "memory:people:confirm" }), He(() => D, n, "memory:people:confirm", { notify: !0 });
	}
	function Ge(e, t, r) {
		t.then((e) => ({
			ok: !0,
			result: e
		}), () => ({
			ok: !1,
			result: { status: "error" }
		})).then((i) => {
			if (e() === t && (A === t && (A = null), j === t && (j = null), !(!_ || v || !p))) {
				b = X() !== null || P !== null;
				try {
					k = Ee(n.getState());
				} catch {
					k = Ee(i.ok ? i.result : { status: "error" });
				}
				if (i.ok && i.result?.status === "saved" && i.result.archive) {
					C = {
						status: "ready",
						archive: i.result.archive,
						revision: i.result.revision,
						warnings: Array.isArray(i.result.warnings) ? i.result.warnings : []
					};
					try {
						o(i.result);
					} catch {}
				}
				Z({ restoreFocusKey: r });
			}
		});
	}
	function Ke() {
		if (!d || !_ || v || Le() || X()) return;
		b = !0, M = "";
		let e;
		try {
			e = Promise.resolve(n.generate());
		} catch {
			e = Promise.reject(/* @__PURE__ */ Error("followed profile generation failed"));
		}
		A = e;
		try {
			k = Ee(n.getState());
		} catch {
			k = Ee({ status: "running" });
		}
		Z({ restoreFocusKey: "followed-profiles:generate" }), Ge(() => A, e, "followed-profiles:generate");
	}
	function qe() {
		if (!d || !_ || v || Le() || X()) return;
		b = !0, M = "";
		let e;
		try {
			e = Promise.resolve(n.commit());
		} catch {
			e = Promise.reject(/* @__PURE__ */ Error("followed profile commit failed"));
		}
		j = e;
		try {
			k = Ee(n.getState());
		} catch {
			k = Ee({ status: "saving" });
		}
		Z({ restoreFocusKey: "followed-profiles:commit" }), Ge(() => j, e, "followed-profiles:commit");
	}
	function Je() {
		let e = pe.start.trim(), t = pe.end.trim();
		if (!e && !t) return {
			ok: !0,
			value: void 0
		};
		if (!e || !t || !/^\d+$/.test(e) || !/^\d+$/.test(t)) return { ok: !1 };
		let n = Number(e), r = Number(t);
		return !Number.isSafeInteger(n) || !Number.isSafeInteger(r) || n > r ? { ok: !1 } : {
			ok: !0,
			value: {
				start: n,
				end: r
			}
		};
	}
	function Ye() {
		let e = U("section", "qqj-v2-uninitialized");
		e.append(K("为当前聊天建立千千结", "先由你选择来源，AI 只识别人选并起草基础字段；最终内容仍由你确认。整个过程可以返回上一步。", "uninitialized"));
		let t = U("details", "qqj-v2-chat-range");
		t.append(U("summary", "", "加入聊天正文（可选）"));
		let n = U("div", "qqj-v2-range-fields");
		for (let e of ["start", "end"]) {
			let t = `qqj-v2-range-${e}-${++B}`, r = U("label", "qqj-v2-field-label", e === "start" ? "开始楼层" : "结束楼层");
			r.htmlFor = t;
			let i = ve(U("input", "qqj-v2-number-input"), `range:${e}`);
			i.id = t, i.type = "number", i.min = "0", i.inputMode = "numeric", i.value = pe[e], me(i, "input", () => {
				pe[e] = i.value;
			}), W(n, r, i);
		}
		t.append(n);
		let r = G("选择建档来源", "qqj-v2-button qqj-v2-primary", () => {
			let e = Je();
			if (!e.ok) {
				M = "请完整填写有效的开始和结束楼层，且开始不能晚于结束。", Z();
				return;
			}
			it(() => e.value === void 0 ? c.loadSources() : c.loadSources({ chatRange: e.value }));
		}, x, "uninitialized:load"), i = U("div", "qqj-v2-actions");
		return i.append(r), W(e, t, i), e;
	}
	function Xe(e) {
		let t = U("section", "qqj-v2-sources");
		t.append(K("选择建档来源", "只有勾选的可用来源才会交给 AI；正文、内部位置与指纹不会显示在这里。", "sources"));
		let n = U("div", "qqj-v2-source-list"), r = Array.isArray(e.sources) ? e.sources : [];
		for (let e of r) {
			let t = `qqj-v2-source-${++B}`, r = U("label", `qqj-v2-source-row${e.availability === "disabled" ? " is-disabled" : ""}`);
			r.htmlFor = t;
			let i = ve(U("input", "qqj-v2-checkbox"), `source:${e.id}:selected`);
			i.id = t, i.type = "checkbox", i.checked = e.selected === !0, i.disabled = x || e.availability === "disabled", me(i, "change", () => at(() => c.setSourceSelected(e.id, i.checked)));
			let a = U("span", "qqj-v2-source-copy");
			W(a, U("strong", "", typeof e.label == "string" ? e.label : "未命名来源"), U("small", "", e.availability === "disabled" ? `${se[e.kind] || "其他来源"} · 当前不可用` : se[e.kind] || "其他来源")), W(r, i, a), n.append(r);
		}
		t.append(n);
		let i = r.filter((e) => e.selected === !0 && e.availability !== "disabled").length;
		if (t.append(U("p", "qqj-v2-selection-count", `已选择 ${i} 项可用来源`)), Array.isArray(e.warnings)) for (let n of e.warnings) t.append(U("p", "qqj-v2-warning", de(n?.code)));
		let a = U("div", "qqj-v2-actions");
		return a.append(G("识别人选", "qqj-v2-button qqj-v2-primary", () => it(() => c.recognizeCandidates()), x || i === 0, "sources:recognize")), t.append(a), t;
	}
	function Ze(e) {
		let t = V.get(e.candidateId);
		return t || (t = {
			name: e.displayName,
			aliases: Array.isArray(e.aliases) ? e.aliases.join("，") : "",
			targetId: ""
		}, V.set(e.candidateId, t)), t;
	}
	function Qe(e) {
		let t = U("section", "qqj-v2-candidates");
		t.append(K("确认要收入档案的人物", "名称和别名可以直接修改；合并只处理你明确选择的一对人物。", "candidates"));
		let n = Array.isArray(e.candidateReview?.candidates) ? e.candidateReview.candidates : [], r = U("div", "qqj-v2-candidate-list");
		for (let e of n) {
			let t = Ze(e), i = U("article", "qqj-v2-candidate"), a = `qqj-v2-candidate-selected-${++B}`, o = U("label", "qqj-v2-candidate-choice");
			o.htmlFor = a;
			let s = ve(U("input", "qqj-v2-checkbox"), `candidate:${e.candidateId}:selected`);
			s.id = a, s.type = "checkbox", s.checked = e.selected === !0, s.disabled = x, me(s, "change", () => at(() => c.setCandidateSelected(e.candidateId, s.checked))), W(o, s, U("strong", "", "收入档案")), i.append(o);
			let l = `qqj-v2-name-${++B}`, u = U("label", "qqj-v2-field-label", "人物名称");
			u.htmlFor = l;
			let d = ve(U("input", "qqj-v2-text-input"), `candidate:${e.candidateId}:name`);
			d.id = l, d.value = t.name, d.disabled = x, me(d, "input", () => {
				t.name = d.value;
			});
			let f = `qqj-v2-aliases-${++B}`, p = U("label", "qqj-v2-field-label", "别名（换行或逗号分隔）");
			p.htmlFor = f;
			let m = ve(U("textarea", "qqj-v2-textarea qqj-v2-alias-input"), `candidate:${e.candidateId}:aliases`);
			m.id = f, m.value = t.aliases, m.disabled = x, me(m, "input", () => {
				t.aliases = m.value;
			}), W(i, u, d, p, m), typeof e.reason == "string" && e.reason && i.append(U("p", "qqj-v2-reason", e.reason));
			let h = U("div", "qqj-v2-row-actions");
			h.append(G("保存名称", "qqj-v2-button qqj-v2-secondary", () => at(() => {
				c.renameCandidate(e.candidateId, t.name), c.setCandidateAliases(e.candidateId, fe(t.aliases)), V.delete(e.candidateId);
			}), x, `candidate:${e.candidateId}:save`)), h.append(G("移除", "qqj-v2-button qqj-v2-danger", () => at(() => {
				c.removeCandidate(e.candidateId), V.delete(e.candidateId);
			}), x, `candidate:${e.candidateId}:remove`)), i.append(h);
			let g = n.filter((t) => t.candidateId !== e.candidateId);
			if (g.length) {
				let n = U("label", "qqj-v2-field-label", "合并到另一人物"), r = `qqj-v2-merge-${++B}`;
				n.htmlFor = r;
				let a = ve(U("select", "qqj-v2-select"), `candidate:${e.candidateId}:merge-target`);
				a.id = r, a.disabled = x;
				let o = U("option", "", "请选择目标人物");
				o.value = "", a.append(o);
				for (let e of g) {
					let n = U("option", "", e.displayName);
					n.value = e.candidateId, t.targetId === e.candidateId && (n.selected = !0), a.append(n);
				}
				a.value = t.targetId, me(a, "change", () => {
					t.targetId = a.value, Z({ restoreFocusKey: ye() });
				});
				let s = G("确认合并", "qqj-v2-button qqj-v2-secondary", () => at(() => {
					c.mergeCandidates({
						targetId: t.targetId,
						sourceIds: [e.candidateId]
					}), V.clear();
				}), x || !t.targetId, `candidate:${e.candidateId}:merge`);
				W(i, n, a, s);
			}
			r.append(i);
		}
		t.append(r);
		let i = n.filter((e) => e.selected === !0).length;
		t.append(U("p", "qqj-v2-selection-count", `已选择 ${i} 人`));
		let a = U("div", "qqj-v2-actions");
		return a.append(G("返回来源", "qqj-v2-button qqj-v2-secondary", () => at(() => {
			c.backToSources(), V.clear();
		}), x, "candidates:back")), a.append(G("生成基础档案", "qqj-v2-button qqj-v2-primary", () => it(() => (H.clear(), c.generateProfiles()), { kind: "generate" }), x || i === 0, "candidates:generate")), t.append(a), t;
	}
	function $e(e) {
		let t = U("section", "qqj-v2-profiles");
		t.append(K("审核基础档案", "AI 草稿不会自动保存。请检查文字，确认后才建立正式档案。", "profiles"));
		let n = Array.isArray(e.profileReview?.people) ? e.profileReview.people : [];
		n.forEach((e, n) => {
			let r = U("details", "qqj-v2-profile");
			r.open = n === 0, r.append(U("summary", "", typeof e.displayName == "string" ? e.displayName : "未命名人物"));
			let i = U("div", "qqj-v2-profile-fields");
			for (let [t, r] of Object.entries(ae)) {
				let a = `qqj-v2-profile-${n}-${t}-${++B}`, o = U("label", "qqj-v2-field-label", r);
				o.htmlFor = a;
				let s = ve(U("textarea", "qqj-v2-textarea qqj-v2-profile-input"), `profile:${e.identityId}:${t}`);
				s.id = a;
				let c = typeof e.fields?.[t]?.value == "string" ? e.fields[t].value : "";
				s.value = xe(e.identityId, t, c), s.disabled = x, s.dataset.identityId = e.identityId, s.dataset.field = t, me(s, "input", () => Se(e.identityId, t, s.value)), W(i, o, s);
			}
			r.append(i), t.append(r);
		});
		let r = U("div", "qqj-v2-actions");
		return r.append(G("返回人物", "qqj-v2-button qqj-v2-secondary", () => at(() => {
			c.backToCandidates(), H.clear();
		}), x, "profiles:back")), r.append(G("确认并建立档案", "qqj-v2-button qqj-v2-primary", () => ot(), x || n.length === 0, "profiles:commit")), t.append(r), t;
	}
	function et(e) {
		let t = U("section", "qqj-v2-completed");
		t.append(K("档案已经建立", "人物与基础档案已保存。之后可以在千千结中继续整理关系和事件。", "completed"));
		let n = e.result?.archive?.people?.order;
		return t.append(U("p", "qqj-v2-count", `已建立 ${Array.isArray(n) ? n.length : 0} 人的档案`)), t;
	}
	function tt() {
		try {
			return c.getState();
		} catch {
			return { stage: "idle" };
		}
	}
	function Z({ restoreFocusKey: e = "" } = {}) {
		if (!p || v) return;
		he(), B = 0;
		let t = tt();
		L === "profiles" && t.stage !== "profiles" && H.clear(), L === "completed" && t.stage !== "completed" && (R = !1), L = t.stage, x = b || t.busy === !0 || P !== null, p.setAttribute("aria-busy", x || S === "loading" ? "true" : "false");
		let n, r = S;
		l && S === "memory" ? (n = Pe(), r = `memory-${w?.status ?? "error"}`) : S === "uninitialized" && t.stage === "sources" ? (n = Xe(t), r = "sources") : S === "uninitialized" && t.stage === "candidates" ? (n = Qe(t), r = "candidates") : S === "uninitialized" && t.stage === "profiles" ? (n = $e(t), r = "profiles") : S === "uninitialized" && t.stage === "completed" ? (n = et(t), r = "completed") : n = Te(), we(ie.some(([e]) => e === r) ? r : "sources");
		let i = Ce(t), a = S === "ready";
		p.className = `qqj-v2-initialization${a && !i ? " is-ready-quiet" : ""}`, m.hidden = a || m.children.length === 0, h.textContent = i, h.hidden = !i, g.replaceChildren(n);
		let c = n.__stageKey || n.__heading?.__stageKey || n.querySelector?.("header")?.__stageKey || r, u = n.__heading || n.querySelector?.("header")?.__heading;
		_ && e && c === F ? (be(e) || u)?.focus?.() : _ && c !== F && u?.focus?.(), F = c;
		let d = t.result;
		if (_ && r === "completed" && ["created", "already_initialized"].includes(d?.status) && !R) {
			R = !0;
			try {
				s(d);
			} catch {}
			try {
				o(d);
			} catch {}
		}
	}
	function nt(e) {
		let t = ue(e?.status);
		t && (M = t);
	}
	function rt(e, t) {
		return e.settled.then((n) => ge(t) ? (b = !1, n.ok ? (e.kind === "commit" && ["created", "already_initialized"].includes(n.result?.status) && H.clear(), nt(n.result), Z({ restoreFocusKey: e.focusKey }), n.result) : (M = le(n.error), Z({ restoreFocusKey: e.focusKey }), { status: "error" })) : n.ok ? n.result : { status: "stale" });
	}
	function it(e, { kind: t = "" } = {}) {
		let n = tt();
		if (b || n.busy === !0 || P || !_) return Promise.resolve({ status: "ignored" });
		let r = y, i = ye();
		b = !0, M = "", Z({ restoreFocusKey: i });
		let a = {
			kind: t,
			focusKey: i,
			settled: Promise.resolve().then(e).then((e) => ({
				ok: !0,
				result: e
			}), (e) => ({
				ok: !1,
				error: e
			}))
		};
		return P = a, a.settled.then(() => {
			P === a && (P = null);
		}), rt(a, r);
	}
	function at(e) {
		let t = tt();
		if (b || t.busy === !0 || P || !_) return;
		let n = ye();
		try {
			M = "", e();
		} catch (e) {
			M = le(e);
		}
		Z({ restoreFocusKey: n });
	}
	function ot() {
		let t = tt();
		if (b || t.busy === !0 || P || !_ || !g) return;
		let n = ye();
		try {
			let t = c.getState(), n = Array.isArray(t.profileReview?.people) ? t.profileReview.people : [], r = new Map(n.map((e) => [e.identityId, e])), i = g.querySelectorAll(".qqj-v2-profile-input");
			for (let e of i) {
				let t = e.dataset.identityId, n = e.dataset.field, i = r.get(t)?.fields?.[n]?.value;
				typeof i == "string" && e.value !== i && c.setProfileField({
					identityId: t,
					field: n,
					value: e.value
				});
			}
			let a = e.currentIdentity();
			it(() => c.commitInitialization({ identity: a }), { kind: "commit" });
		} catch (e) {
			M = le(e), Z({ restoreFocusKey: n });
		}
	}
	function st(e) {
		if (v) throw Error("视图已经销毁");
		if (!e || typeof e.append != "function" && typeof e.appendChild != "function") throw TypeError("mount container 无效");
		y += 1, _ = !1, N = null, b = !1, x = !1, he(), f?.invalidate?.(), p?.remove?.(), p = U("section", "qqj-v2-initialization"), p.hidden = !0, p.setAttribute("role", "region"), p.setAttribute("aria-label", "千千结初次建档"), p.setAttribute("aria-busy", "false");
		let t = U("link", "qqj-v2-style");
		return t.rel = "stylesheet", t.href = new URL("data:text/css;base64,LnFxai12Mi1pbml0aWFsaXphdGlvbiB7CiAgLS1xcWotdjItcGFwZXI6IHZhcigtLXBhbmVsLCAjZmJmY2ZlKTsKICAtLXFxai12Mi1wYXBlci0yOiB2YXIoLS1wYW5lbC0yLCAjZjFmNGY5KTsKICAtLXFxai12Mi1pbms6IHZhcigtLWluaywgIzIzMjYyZCk7CiAgLS1xcWotdjItbXV0ZWQ6IHZhcigtLXNvZnQsICM2YTcwNzkpOwogIC0tcXFqLXYyLWxpbmU6IHZhcigtLWxpbmUsIHJnYmEoMzUsIDM4LCA0NSwgMC4xKSk7CiAgLS1xcWotdjItYWNjZW50OiB2YXIoLS1jcmltc29uLCAjYjIzYTQ4KTsKICAtLXFxai12Mi1kYW5nZXI6IHZhcigtLWNyaW1zb24sICNiMjNhNDgpOwogIGJveC1zaXppbmc6IGJvcmRlci1ib3g7CiAgd2lkdGg6IG1pbigxMDAlLCA1MHJlbSk7CiAgbWFyZ2luOiAwIGF1dG87CiAgcGFkZGluZzogY2xhbXAoMXJlbSwgM3Z3LCAycmVtKTsKICBjb2xvcjogdmFyKC0tcXFqLXYyLWluayk7CiAgYmFja2dyb3VuZDogdmFyKC0tcXFqLXYyLXBhcGVyKTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1xcWotdjItbGluZSk7CiAgYm9yZGVyLXJhZGl1czogMXJlbTsKfQoKLnFxai12Mi1pbml0aWFsaXphdGlvbiAqIHsKICBib3gtc2l6aW5nOiBib3JkZXItYm94Owp9CgoucXFqLXYyLWluaXRpYWxpemF0aW9uLmlzLXJlYWR5LXF1aWV0IHsKICBwYWRkaW5nLWJsb2NrLXN0YXJ0OiAwOwp9CgoucXFqLXYyLXByb2dyZXNzW2hpZGRlbl0sCi5xcWotdjItc3RhdHVzW2hpZGRlbl0gewogIGRpc3BsYXk6IG5vbmU7Cn0KCi5xcWotdjItcHJvZ3Jlc3MgewogIG1hcmdpbi1ibG9jay1lbmQ6IDEuNXJlbTsKfQoKLnFxai12Mi1wcm9ncmVzcy1saXN0IHsKICBkaXNwbGF5OiBncmlkOwogIGdyaWQtdGVtcGxhdGUtY29sdW1uczogcmVwZWF0KDQsIG1pbm1heCgwLCAxZnIpKTsKICBnYXA6IDAuNXJlbTsKICBtYXJnaW46IDA7CiAgcGFkZGluZzogMDsKICBsaXN0LXN0eWxlOiBub25lOwp9CgoucXFqLXYyLXByb2dyZXNzLXN0ZXAgewogIHBvc2l0aW9uOiByZWxhdGl2ZTsKICBkaXNwbGF5OiBncmlkOwogIGp1c3RpZnktaXRlbXM6IGNlbnRlcjsKICBnYXA6IDAuMzVyZW07CiAgbWluLXdpZHRoOiAwOwogIGNvbG9yOiB2YXIoLS1xcWotdjItbXV0ZWQpOwogIHRleHQtYWxpZ246IGNlbnRlcjsKfQoKLnFxai12Mi1wcm9ncmVzcy1zdGVwOjpiZWZvcmUgewogIHBvc2l0aW9uOiBhYnNvbHV0ZTsKICB6LWluZGV4OiAwOwogIHRvcDogMXJlbTsKICBsZWZ0OiBjYWxjKC01MCUgLSAwLjI1cmVtKTsKICB3aWR0aDogY2FsYygxMDAlICsgMC41cmVtKTsKICBoZWlnaHQ6IDFweDsKICBiYWNrZ3JvdW5kOiB2YXIoLS1xcWotdjItbGluZSk7CiAgY29udGVudDogJyc7Cn0KCi5xcWotdjItcHJvZ3Jlc3Mtc3RlcDpmaXJzdC1jaGlsZDo6YmVmb3JlIHsKICBkaXNwbGF5OiBub25lOwp9CgoucXFqLXYyLXByb2dyZXNzLXN0ZXAuaXMtY3VycmVudCwKLnFxai12Mi1wcm9ncmVzcy1zdGVwLmlzLWNvbXBsZXRlIHsKICBjb2xvcjogdmFyKC0tcXFqLXYyLWluayk7Cn0KCi5xcWotdjIta25vdCB7CiAgcG9zaXRpb246IHJlbGF0aXZlOwogIHotaW5kZXg6IDE7CiAgZGlzcGxheTogZ3JpZDsKICB3aWR0aDogMnJlbTsKICBoZWlnaHQ6IDJyZW07CiAgcGxhY2UtaXRlbXM6IGNlbnRlcjsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1xcWotdjItbGluZSk7CiAgYm9yZGVyLXJhZGl1czogNTAlOwogIGJhY2tncm91bmQ6IHZhcigtLXFxai12Mi1wYXBlcik7CiAgZm9udC12YXJpYW50LW51bWVyaWM6IHRhYnVsYXItbnVtczsKfQoKLnFxai12Mi1wcm9ncmVzcy1zdGVwLmlzLWN1cnJlbnQgLnFxai12Mi1rbm90LAoucXFqLXYyLXByb2dyZXNzLXN0ZXAuaXMtY29tcGxldGUgLnFxai12Mi1rbm90IHsKICBib3JkZXItY29sb3I6IHZhcigtLXFxai12Mi1hY2NlbnQpOwogIGNvbG9yOiB2YXIoLS1xcWotdjItYWNjZW50KTsKfQoKLnFxai12Mi1zdGVwLWxhYmVsIHsKICBvdmVyZmxvdzogaGlkZGVuOwogIG1heC13aWR0aDogMTAwJTsKICBmb250LXNpemU6IDAuNzhyZW07CiAgdGV4dC1vdmVyZmxvdzogZWxsaXBzaXM7CiAgd2hpdGUtc3BhY2U6IG5vd3JhcDsKfQoKLnFxai12Mi1zdGF0dXMgewogIG1pbi1oZWlnaHQ6IDEuNGVtOwogIG1hcmdpbi1ibG9jay1lbmQ6IDAuNzVyZW07CiAgY29sb3I6IHZhcigtLXFxai12Mi1tdXRlZCk7CiAgZm9udC1zaXplOiAwLjlyZW07Cn0KCi5xcWotdjItaGVhZGluZyB7CiAgbWFyZ2luLWJsb2NrLWVuZDogMS4yNXJlbTsKfQoKLnFxai12Mi10aXRsZSB7CiAgbWFyZ2luOiAwOwogIGZvbnQtZmFtaWx5OiAnTm90byBTZXJpZiBTQycsICdTb25ndGkgU0MnLCBTaW1TdW4sIHNlcmlmOwogIGZvbnQtc2l6ZTogY2xhbXAoMS4zNXJlbSwgM3Z3LCAxLjg1cmVtKTsKICBmb250LXdlaWdodDogNjAwOwogIGxldHRlci1zcGFjaW5nOiAwLjA0ZW07Cn0KCi5xcWotdjItaW50cm8sCi5xcWotdjItcmVhc29uLAoucXFqLXYyLWNvdW50LAoucXFqLXYyLXNlbGVjdGlvbi1jb3VudCwKLnFxai12Mi1tZW1vcnktcHJvZ3Jlc3MtY29weSwKLnFxai12Mi1tZW1vcnktY3VycmVudCB7CiAgbWFyZ2luOiAwLjU1cmVtIDAgMDsKICBsaW5lLWhlaWdodDogMS42NTsKfQoKLnFxai12Mi1pbnRybywKLnFxai12Mi1yZWFzb24gewogIGNvbG9yOiB2YXIoLS1xcWotdjItbXV0ZWQpOwp9CgoucXFqLXYyLW1lbW9yeS1mYWN0cyB7CiAgZGlzcGxheTogZ3JpZDsKICBncmlkLXRlbXBsYXRlLWNvbHVtbnM6IHJlcGVhdCgzLCBtaW5tYXgoMCwgMWZyKSk7CiAgZ2FwOiAwLjc1cmVtOwp9CgoucXFqLXYyLW1lbW9yeS1mYWN0cyAucXFqLXYyLWNvdW50LAoucXFqLXYyLW1lbW9yeS1wcm9ncmVzcyB7CiAgcGFkZGluZzogMC44NXJlbTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1xcWotdjItbGluZSk7CiAgYm9yZGVyLXJhZGl1czogMC43cmVtOwogIGJhY2tncm91bmQ6IHZhcigtLXFxai12Mi1wYXBlci0yKTsKfQoKLnFxai12Mi1tZW1vcnktZmFjdHMgLnFxai12Mi1jb3VudCB7CiAgbWFyZ2luOiAwOwogIHRleHQtYWxpZ246IGNlbnRlcjsKfQoKLnFxai12Mi1tZW1vcnktcHJvZ3Jlc3MtbWV0ZXIgewogIHdpZHRoOiAxMDAlOwogIGhlaWdodDogMC43cmVtOwogIG1hcmdpbi1ibG9jay1zdGFydDogMC42NXJlbTsKICBhY2NlbnQtY29sb3I6IHZhcigtLXFxai12Mi1hY2NlbnQpOwp9CgoucXFqLXYyLW1lbW9yeS1jdXJyZW50IHsKICBjb2xvcjogdmFyKC0tcXFqLXYyLW11dGVkKTsKfQoKLnFxai12Mi1zb3VyY2UtbGlzdCwKLnFxai12Mi1jYW5kaWRhdGUtbGlzdCwKLnFxai12Mi1wcm9maWxlLWZpZWxkcywKLnFxai12Mi1tZW1vcnktcGVvcGxlLWxpc3QgewogIGRpc3BsYXk6IGdyaWQ7CiAgZ2FwOiAwLjc1cmVtOwp9CgoucXFqLXYyLXNvdXJjZS1yb3csCi5xcWotdjItY2FuZGlkYXRlLAoucXFqLXYyLXByb2ZpbGUsCi5xcWotdjItY2hhdC1yYW5nZSwKLnFxai12Mi1tZW1vcnktcGVyc29uLAoucXFqLXYyLW1lbW9yeS1zaWxlbnQgewogIGRpc3BsYXk6IGJsb2NrOwogIHBhZGRpbmc6IDAuOXJlbTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1xcWotdjItbGluZSk7CiAgYm9yZGVyLXJhZGl1czogMC43cmVtOwogIGJhY2tncm91bmQ6IHZhcigtLXFxai12Mi1wYXBlci0yKTsKfQoKLnFxai12Mi1zb3VyY2Utcm93IHsKICBkaXNwbGF5OiBmbGV4OwogIG1pbi1oZWlnaHQ6IDMuMjVyZW07CiAgYWxpZ24taXRlbXM6IGNlbnRlcjsKICBnYXA6IDAuNzVyZW07CiAgY3Vyc29yOiBwb2ludGVyOwp9CgoucXFqLXYyLXNvdXJjZS1yb3cuaXMtZGlzYWJsZWQgewogIGN1cnNvcjogbm90LWFsbG93ZWQ7CiAgb3BhY2l0eTogMC42MjsKfQoKLnFxai12Mi1zb3VyY2UtY29weSB7CiAgZGlzcGxheTogZ3JpZDsKICBtaW4td2lkdGg6IDA7CiAgZ2FwOiAwLjJyZW07Cn0KCi5xcWotdjItc291cmNlLWNvcHkgc3Ryb25nIHsKICBvdmVyZmxvdy13cmFwOiBhbnl3aGVyZTsKICB3b3JkLWJyZWFrOiBicmVhay13b3JkOwp9CgoucXFqLXYyLXNvdXJjZS1jb3B5IHNtYWxsIHsKICBjb2xvcjogdmFyKC0tcXFqLXYyLW11dGVkKTsKfQoKLnFxai12Mi1jaGVja2JveCB7CiAgd2lkdGg6IDEuMTVyZW07CiAgaGVpZ2h0OiAxLjE1cmVtOwogIGZsZXg6IDAgMCBhdXRvOwogIGFjY2VudC1jb2xvcjogdmFyKC0tcXFqLXYyLWFjY2VudCk7Cn0KCi5xcWotdjItY2FuZGlkYXRlLAoucXFqLXYyLXByb2ZpbGUgewogIG1hcmdpbi1ibG9jay1lbmQ6IDAuNzVyZW07Cn0KCi5xcWotdjItY2FuZGlkYXRlLWNob2ljZSB7CiAgZGlzcGxheTogZmxleDsKICBtaW4taGVpZ2h0OiAyLjc1cmVtOwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiAwLjZyZW07Cn0KCi5xcWotdjItbWVtb3J5LXBlcnNvbi1jaG9pY2UgewogIGRpc3BsYXk6IGZsZXg7CiAgbWluLWhlaWdodDogMi41cmVtOwogIGFsaWduLWl0ZW1zOiBjZW50ZXI7CiAgZ2FwOiAwLjY1cmVtOwp9CgoucXFqLXYyLW1lbW9yeS1zaWxlbnQgewogIG1hcmdpbi1ibG9jay1zdGFydDogMC45cmVtOwp9CgoucXFqLXYyLW1lbW9yeS1zaWxlbnQgc3VtbWFyeSB7CiAgbWluLWhlaWdodDogMi41cmVtOwogIHBhZGRpbmctYmxvY2s6IDAuNTVyZW07CiAgY3Vyc29yOiBwb2ludGVyOwogIGZvbnQtd2VpZ2h0OiA2MDA7Cn0KCi5xcWotdjItZm9sbG93ZWQtcHJvZmlsZXMgewogIG1hcmdpbi1ibG9jay1zdGFydDogMS4yNXJlbTsKICBwYWRkaW5nLWJsb2NrLXN0YXJ0OiAxcmVtOwogIGJvcmRlci1ibG9jay1zdGFydDogMXB4IHNvbGlkIHZhcigtLXFxai12Mi1saW5lKTsKfQoKLnFxai12Mi1mb2xsb3dlZC1wcm9maWxlLWxpc3QgewogIGRpc3BsYXk6IGdyaWQ7CiAgZ2FwOiAwLjc1cmVtOwogIG1hcmdpbi1ibG9jay1zdGFydDogMC43NXJlbTsKfQoKLnFxai12Mi1mb2xsb3dlZC1wcm9maWxlLXBlcnNvbiB7CiAgcGFkZGluZzogMC44NXJlbTsKICBib3JkZXI6IDFweCBzb2xpZCB2YXIoLS1xcWotdjItbGluZSk7CiAgYm9yZGVyLXJhZGl1czogMC43cmVtOwogIGJhY2tncm91bmQ6IHZhcigtLXFxai12Mi1wYXBlci0yKTsKfQoKLnFxai12Mi1mb2xsb3dlZC1wcm9maWxlLW5hbWUgewogIG1hcmdpbjogMCAwIDAuNjVyZW07Cn0KCi5xcWotdjItZm9sbG93ZWQtcHJvZmlsZS1maWVsZHMgewogIGRpc3BsYXk6IGdyaWQ7CiAgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiBtaW5tYXgoNC41cmVtLCBhdXRvKSBtaW5tYXgoMCwgMWZyKTsKICBnYXA6IDAuNDVyZW0gMC43NXJlbTsKICBtYXJnaW46IDA7Cn0KCi5xcWotdjItZm9sbG93ZWQtcHJvZmlsZS1maWVsZC1uYW1lLAoucXFqLXYyLWZvbGxvd2VkLXByb2ZpbGUtZmllbGQtdmFsdWUgewogIG1hcmdpbjogMDsKICBvdmVyZmxvdy13cmFwOiBhbnl3aGVyZTsKfQoKLnFxai12Mi1mb2xsb3dlZC1wcm9maWxlLWZpZWxkLW5hbWUgewogIGNvbG9yOiB2YXIoLS1xcWotdjItbXV0ZWQpOwogIGZvbnQtd2VpZ2h0OiA2MDA7Cn0KCi5xcWotdjItZmllbGQtbGFiZWwgewogIGRpc3BsYXk6IGJsb2NrOwogIG1hcmdpbjogMC43cmVtIDAgMC4zNXJlbTsKICBmb250LXNpemU6IDAuOXJlbTsKICBmb250LXdlaWdodDogNjAwOwp9CgoucXFqLXYyLXRleHQtaW5wdXQsCi5xcWotdjItbnVtYmVyLWlucHV0LAoucXFqLXYyLXRleHRhcmVhLAoucXFqLXYyLXNlbGVjdCB7CiAgd2lkdGg6IDEwMCU7CiAgbWluLWhlaWdodDogMi43NXJlbTsKICBwYWRkaW5nOiAwLjY1cmVtIDAuNzVyZW07CiAgY29sb3I6IHZhcigtLXFxai12Mi1pbmspOwogIGJhY2tncm91bmQ6IHZhcigtLXFxai12Mi1wYXBlcik7CiAgYm9yZGVyOiAxcHggc29saWQgdmFyKC0tcXFqLXYyLWxpbmUpOwogIGJvcmRlci1yYWRpdXM6IDAuNXJlbTsKICBmb250OiBpbmhlcml0Owp9CgoucXFqLXYyLXRleHRhcmVhIHsKICBtaW4taGVpZ2h0OiA1LjVyZW07CiAgcmVzaXplOiB2ZXJ0aWNhbDsKICBsaW5lLWhlaWdodDogMS41NTsKfQoKLnFxai12Mi1yYW5nZS1maWVsZHMgewogIGRpc3BsYXk6IGdyaWQ7CiAgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiByZXBlYXQoMiwgbWlubWF4KDAsIDFmcikpOwogIGdhcDogMCAwLjc1cmVtOwp9CgoucXFqLXYyLWNoYXQtcmFuZ2Ugc3VtbWFyeSwKLnFxai12Mi1wcm9maWxlIHN1bW1hcnkgewogIG1pbi1oZWlnaHQ6IDIuNzVyZW07CiAgcGFkZGluZy1ibG9jazogMC42NXJlbTsKICBjdXJzb3I6IHBvaW50ZXI7CiAgZm9udC13ZWlnaHQ6IDYwMDsKfQoKLnFxai12Mi1hY3Rpb25zLAoucXFqLXYyLXJvdy1hY3Rpb25zIHsKICBkaXNwbGF5OiBmbGV4OwogIGZsZXgtd3JhcDogd3JhcDsKICBqdXN0aWZ5LWNvbnRlbnQ6IGZsZXgtZW5kOwogIGdhcDogMC42NXJlbTsKICBtYXJnaW4tYmxvY2stc3RhcnQ6IDEuMXJlbTsKfQoKLnFxai12Mi1idXR0b24gewogIG1pbi1oZWlnaHQ6IDIuNzVyZW07CiAgcGFkZGluZzogMC42NXJlbSAxcmVtOwogIGJvcmRlcjogMXB4IHNvbGlkIHZhcigtLXFxai12Mi1saW5lKTsKICBib3JkZXItcmFkaXVzOiAwLjU1cmVtOwogIGNvbG9yOiB2YXIoLS1xcWotdjItaW5rKTsKICBiYWNrZ3JvdW5kOiB0cmFuc3BhcmVudDsKICBmb250OiBpbmhlcml0OwogIGZvbnQtd2VpZ2h0OiA2MDA7CiAgY3Vyc29yOiBwb2ludGVyOwp9CgoucXFqLXYyLWJ1dHRvbjpkaXNhYmxlZCB7CiAgY3Vyc29yOiBub3QtYWxsb3dlZDsKICBvcGFjaXR5OiAwLjU7Cn0KCi5xcWotdjItcHJpbWFyeSB7CiAgYm9yZGVyLWNvbG9yOiB2YXIoLS1xcWotdjItYWNjZW50KTsKICBjb2xvcjogY29sb3ItbWl4KGluIHNyZ2IsIHZhcigtLXFxai12Mi1hY2NlbnQpIDgyJSwgd2hpdGUpOwp9CgoucXFqLXYyLWRhbmdlciB7CiAgYm9yZGVyLWNvbG9yOiBjb2xvci1taXgoaW4gc3JnYiwgdmFyKC0tcXFqLXYyLWRhbmdlcikgNjAlLCB0cmFuc3BhcmVudCk7CiAgY29sb3I6IHZhcigtLXFxai12Mi1kYW5nZXIpOwp9CgoucXFqLXYyLXdhcm5pbmcgewogIG1hcmdpbjogMC43NXJlbSAwIDA7CiAgcGFkZGluZzogMC43cmVtIDAuOHJlbTsKICBib3JkZXItaW5saW5lLXN0YXJ0OiAzcHggc29saWQgdmFyKC0tcXFqLXYyLWFjY2VudCk7CiAgY29sb3I6IHZhcigtLXFxai12Mi1tdXRlZCk7CiAgbGluZS1oZWlnaHQ6IDEuNTU7Cn0KCi5xcWotdjItbmFtZS1saXN0IHsKICBtYXJnaW46IDAuNzVyZW0gMCAwOwogIHBhZGRpbmctaW5saW5lLXN0YXJ0OiAxLjRyZW07CiAgbGluZS1oZWlnaHQ6IDEuNzsKfQoKLnFxai12Mi1idXR0b246Zm9jdXMtdmlzaWJsZSwKLnFxai12Mi1jaGVja2JveDpmb2N1cy12aXNpYmxlLAoucXFqLXYyLXRleHQtaW5wdXQ6Zm9jdXMtdmlzaWJsZSwKLnFxai12Mi1udW1iZXItaW5wdXQ6Zm9jdXMtdmlzaWJsZSwKLnFxai12Mi10ZXh0YXJlYTpmb2N1cy12aXNpYmxlLAoucXFqLXYyLXNlbGVjdDpmb2N1cy12aXNpYmxlLAoucXFqLXYyLWNoYXQtcmFuZ2Ugc3VtbWFyeTpmb2N1cy12aXNpYmxlLAoucXFqLXYyLXByb2ZpbGUgc3VtbWFyeTpmb2N1cy12aXNpYmxlLAoucXFqLXYyLW1lbW9yeS1zaWxlbnQgc3VtbWFyeTpmb2N1cy12aXNpYmxlIHsKICBvdXRsaW5lOiAycHggc29saWQgdmFyKC0tcXFqLXYyLWFjY2VudCk7CiAgb3V0bGluZS1vZmZzZXQ6IDJweDsKfQoKQG1lZGlhIChtYXgtd2lkdGg6IDUyMHB4KSB7CiAgLnFxai12Mi1pbml0aWFsaXphdGlvbiB7CiAgICBwYWRkaW5nOiAxcmVtIDAuOHJlbTsKICAgIGJvcmRlci1yYWRpdXM6IDAuN3JlbTsKICB9CgogIC5xcWotdjItc3RlcC1sYWJlbCB7CiAgICBmb250LXNpemU6IDAuN3JlbTsKICB9CgogIC5xcWotdjItcmFuZ2UtZmllbGRzIHsKICAgIGdyaWQtdGVtcGxhdGUtY29sdW1uczogMWZyOwogIH0KCiAgLnFxai12Mi1tZW1vcnktZmFjdHMgewogICAgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnI7CiAgfQoKICAucXFqLXYyLWFjdGlvbnMsCiAgLnFxai12Mi1yb3ctYWN0aW9ucyB7CiAgICBkaXNwbGF5OiBncmlkOwogICAgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOiAxZnI7CiAgfQoKICAucXFqLXYyLWJ1dHRvbiB7CiAgICB3aWR0aDogMTAwJTsKICB9Cn0KCkBtZWRpYSAocHJlZmVycy1yZWR1Y2VkLW1vdGlvbjogcmVkdWNlKSB7CiAgLnFxai12Mi1pbml0aWFsaXphdGlvbiAqLAogIC5xcWotdjItaW5pdGlhbGl6YXRpb24gKjo6YmVmb3JlLAogIC5xcWotdjItaW5pdGlhbGl6YXRpb24gKjo6YWZ0ZXIgewogICAgc2Nyb2xsLWJlaGF2aW9yOiBhdXRvICFpbXBvcnRhbnQ7CiAgICB0cmFuc2l0aW9uLWR1cmF0aW9uOiAwLjAxbXMgIWltcG9ydGFudDsKICAgIGFuaW1hdGlvbi1kdXJhdGlvbjogMC4wMW1zICFpbXBvcnRhbnQ7CiAgICBhbmltYXRpb24taXRlcmF0aW9uLWNvdW50OiAxICFpbXBvcnRhbnQ7CiAgfQp9Cg==", "" + import.meta.url).href, m = U("nav", "qqj-v2-progress"), m.setAttribute("aria-label", "建档进度"), h = U("div", "qqj-v2-status"), h.setAttribute("role", "status"), h.setAttribute("aria-live", "polite"), g = U("div", "qqj-v2-content"), W(p, t, m, h, g), typeof e.append == "function" ? e.append(p) : e.appendChild(p), Z(), p;
	}
	function ct() {
		if (v) return Promise.reject(/* @__PURE__ */ Error("视图已经销毁"));
		if (!p) return Promise.reject(/* @__PURE__ */ Error("视图尚未挂载"));
		if (_ && N) return N;
		_ = !0, p.hidden = !1;
		let r = ++y;
		return b = P !== null || X() !== null || Le() !== null, S = "loading", C = null, M = "", F = "", z = -1, Z(), P && rt(P, r), X() && Be(), N = Promise.resolve().then(() => e.readArchive()).then(async (e) => {
			if (!ge(r)) return e;
			if (C = e, l && e?.status === "uninitialized") {
				if (X()) {
					try {
						w = J(t.getState());
					} catch {
						w = J({ status: "checking" });
					}
					return S = "memory", b = !0, Be(), Z(), w;
				}
				let e;
				try {
					e = await t.inspect();
				} catch {
					e = { status: "error" };
				}
				return ge(r) ? (w = J(e), S = "memory", b = X() !== null, X() && Be(), Z(), e) : e;
			}
			if (S = [
				"ready",
				"uninitialized",
				"disabled",
				"stale"
			].includes(e?.status) ? e.status : "error", S === "ready" && d) {
				let e;
				try {
					e = Le() ? n.getState() : await n.inspect();
				} catch {
					e = { status: "error" };
				}
				if (!ge(r)) return e;
				k = Ee(e), b = P !== null || X() !== null || Le() !== null;
			}
			if (Z(), S === "ready" && z !== r) {
				z = r;
				try {
					o(e);
				} catch {}
			}
			return e;
		}).catch(() => ge(r) ? (S = "error", M = "读取档案没有完成，请重新打开此页面。", Z(), { status: "error" }) : { status: "stale" }), N;
	}
	function lt() {
		!p || v || (_ = !1, y += 1, N = null, b = !1, x = !1, Re(), he(), f?.invalidate?.(), p.hidden = !0);
	}
	function ut() {
		v || (_ = !1, v = !0, y += 1, N = null, P = null, b = !1, x = !1, Re(), T = null, E = null, D = null, w = null, A = null, j = null, k = null, te.clear(), ne = "", f?.invalidate?.(), he(), V.clear(), H.clear(), p?.remove?.(), p = null, m = null, h = null, g = null);
	}
	return Object.freeze({
		mount: st,
		activate: ct,
		deactivate: lt,
		destroy: ut
	});
}
//#endregion
//#region src/bootstrap.js
function U({ formal: e, people: t, sourceCatalog: n, settings: r, apiTools: i, loadState: a, initialRelations: o, reviewActions: s, onPluginEnabledChange: c, archiveV2Composition: l, archiveV2Memory: u, archiveV2FollowedProfiles: d, archiveV2Dossier: m, archiveV2ViewFactory: h = pe, documentRef: g = globalThis.document, panelFactory: _ = p, fabFactory: v = y, wandInstaller: x = b, enableFab: C = !1 } = {}) {
	if (!g) return {
		setState() {},
		show() {}
	};
	let w = g.getElementById("qqj-panel-host");
	if (w) return w.__qqjInstance;
	let T = l ? h({
		composition: l,
		memory: u,
		followedProfiles: d,
		dossier: m,
		documentRef: g
	}) : void 0, E = () => r?.isEnabled?.() !== !1, D = 0, O = () => E() ? { status: "stale" } : { status: "disabled" }, k = async (e, r) => {
		let i = () => E() && r === D;
		if (!i() || typeof t?.getPeople != "function") return i() ? e : O();
		let a = await t.getPeople();
		if (!i()) return O();
		let o = [
			"uninitialized",
			"preparing",
			"deleting",
			"restoring",
			"renaming",
			"conflict",
			"stale"
		].includes(a?.status), s = o && typeof n?.getState == "function" ? await n.getState({ formalState: e }) : null;
		if (!i()) return O();
		if (!o || typeof t.identify != "function") return {
			...e,
			people: a,
			...s ? { sourceCatalog: s } : {}
		};
		if (typeof n?.getState == "function") return {
			...e,
			people: {
				...a,
				recognitionRequired: !0
			},
			sourceCatalog: s || {
				status: "uninitialized",
				stage: "uninitialized",
				candidates: [],
				permit: { status: "none" }
			}
		};
		try {
			let n = await t.identify({ onPhase: (t) => {
				i() && N({
					...e,
					status: t
				});
			} });
			if (!i()) return O();
			let r = n?.status === "people_error" ? n : await t.getPeople();
			return i() ? {
				...e,
				people: {
					...r,
					warnings: [...new Map([...r?.warnings || [], ...n?.warnings || []].map((e) => [e.code || JSON.stringify(e), e])).values()].slice(0, 80)
				},
				...n?.status === "conflict" ? { peopleError: "人物改名恢复发生冲突，请稍后重试" } : {},
				...n?.peopleError ? { peopleError: n.peopleError } : {},
				peopleRecognitionFailed: n?.status === "people_error" || !!n?.peopleError
			} : O();
		} catch (t) {
			return i() ? {
				...e,
				status: ["ready", "route_ready"].includes(e?.status) ? e.status : "people_error",
				people: a,
				peopleError: S(t),
				peopleRecognitionFailed: !0
			} : O();
		}
	}, A, j = async ({ announceLoading: t = !1, allowIdentification: n = !1, retryRecognition: r = !1 } = {}) => {
		let i = ++D;
		if (!E()) {
			let e = { status: "disabled" };
			return i === D && A?.setState(e), e;
		}
		t && A?.setState({ status: "loading" });
		try {
			let t = typeof a == "function" ? await a({
				setState: (e) => {
					E() && i === D && N(e);
				},
				isCurrent: () => E() && i === D,
				allowIdentification: n,
				retryRecognition: r
			}) : await k(typeof e?.getFormalState == "function" ? await e.getFormalState() : { status: "error" }, i), o = E() && i === D ? t : O();
			return i === D && N(o), o;
		} catch {
			let e = E() ? { status: "error" } : { status: "disabled" };
			return i === D && N(e), e;
		}
	}, M = (e) => {
		let t = E();
		t || A?.setState({ status: "disabled" }), A.host.style.display = "block", A.show(e?.currentTarget || e?.target || g.activeElement), t && j();
	};
	A = _({
		formal: e,
		people: t,
		sourceCatalog: n,
		settings: r,
		apiTools: i,
		loadState: typeof a == "function" ? j : void 0,
		initialRelations: o,
		reviewActions: s,
		onPluginEnabledChange: c,
		archiveV2InitializationView: T,
		onClose: () => {
			D += 1, A.host.style.display = "none";
		}
	});
	let N = (e) => {
		if (A.setState(e) !== !1 && e?.status === "people_error") {
			let t = A.root?.querySelector?.(".view"), n = g.createElement?.("p");
			n && (n.className = "error", n.textContent = f(e.peopleError), t?.append?.(n));
		}
	};
	A.host.style.display = "none", g.body.append(A.host);
	let P = C || typeof g.createElement != "function" ? v({ onClick: M }) : { host: null };
	P.host && (P.host.style ||= {}, P.host.style.display = E() ? "" : "none", g.body.append(P.host)), x(M), g.addEventListener("keydown", (e) => {
		e.key === "Escape" && !A.host.hidden && A.close();
	});
	let F = (e) => {
		D += 1, P.host?.style && (P.host.style.display = e ? "" : "none"), e || (A.invalidateInitialization?.(), N({ status: "disabled" }));
	}, I = {
		...A,
		fab: P,
		setState: N,
		setEnabled: F,
		show: M
	};
	return A.host.__qqjInstance = I, I;
}
//#endregion
export { U as bootstrap };
