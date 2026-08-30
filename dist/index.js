//#region src/ui/panel.html?raw
var e = "qqj-panel-pos", t = "qqj-panel-size", n = (e) => Number.isFinite(Number(e)), r = (e, t, n) => Math.min(n, Math.max(t, e)), i = (e, t) => ({
	width: Math.max(0, Number(e) || 0),
	height: Math.max(0, Number(t) || 0)
});
function a(e, t, a = null) {
	let o = i(e, t), s = Math.max(0, o.width - 20), c = Math.max(0, o.height - 20), l = Math.min(500, s), u = Math.min(420, c), d = n(a?.width) && Number(a.width) > 0 ? Number(a.width) : 720, f = Math.min(780, Math.max(0, o.height - 80)), p = n(a?.height) && Number(a.height) > 0 ? Number(a.height) : f;
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
	let c = i(e, t), l = Math.max(0, c.width - Math.max(0, Number(a) || 0)), u = Math.max(0, c.height - Math.max(0, Number(o) || 0)), d = Math.min(10, l), f = Math.max(d, l - 10), p = Math.min(10, u), m = Math.max(p, u - 10), h = r(l - 20, d, f), g = r(40, p, m);
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
		let t = v(), n = Math.max(0, t.width - m.left - 10), i = Math.max(0, t.height - m.top - 10), a = Math.min(500, n), o = Math.min(420, i), s = r(m.width + e.x - m.startX, a, n), c = r(m.height + e.y - m.startY, o, i);
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
];
function d({ formal: e, people: t, settings: n, apiTools: r, loadState: i, initialRelations: a, reviewActions: o, onPluginEnabledChange: s, onClose: c } = {}) {
	let d = document.createElement("div");
	d.id = "qqj-panel-host", d.hidden = !0, d.setAttribute("aria-hidden", "true");
	let f = d.attachShadow({ mode: "open" });
	f.innerHTML = "<style>:host{--panel:#fbfcfe;--panel-2:#f1f4f9;--ink:#23262d;--soft:#6a7079;--faint:#a2a8b2;--line:#23262d1a;--crimson:#b23a48;--u:#3e6b8c;--c:#b0784a;color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif;display:block}*{box-sizing:border-box}.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;animation:.35s both in;overflow:hidden;box-shadow:0 24px 70px #23262d2e,0 4px 14px #23262d12}.panel.is-gesturing{-webkit-user-select:none;user-select:none}.topbar{touch-action:none;cursor:grab;-webkit-user-select:none;user-select:none;align-items:center;gap:14px;padding:15px 18px 0;display:flex}.brand{align-items:baseline;gap:7px;display:flex}.mark,.tab,.empty h2,.choice strong,.module b{font-family:宋体,Songti SC,SimSun,serif}.mark{letter-spacing:.06em;font-size:17px;font-weight:700}.em{color:var(--crimson)}.sub{color:var(--faint);letter-spacing:.22em;font:10px ui-monospace,monospace}.close{color:var(--soft);cursor:pointer;background:0 0;border:0;width:28px;height:28px;margin-left:auto;font-size:24px;line-height:1}.close:focus-visible,.tab:focus-visible,.choice:focus-visible,.init:focus-visible,.person-action:focus-visible,summary:focus-visible{outline:2px solid var(--crimson);outline-offset:2px}.tabs{border-bottom:1px solid var(--line);gap:2px;margin-top:8px;padding:6px 12px 0 14px;display:flex}.tab{color:var(--faint);cursor:pointer;background:0 0;border:0;padding:8px 12px 12px;font-size:14px;position:relative}.tab.active{color:var(--ink);font-weight:600}.tab.active:after{content:\"\";background:linear-gradient(var(--crimson),transparent);width:2px;height:12px;position:absolute;bottom:-1px;left:50%;transform:translate(-50%)}.body{max-height:74vh;padding:16px 18px 20px;overflow:auto}.status-line{color:var(--soft);align-items:center;gap:7px;min-height:18px;font-size:11px;display:flex}.status-dot{background:var(--faint);border-radius:50%;width:7px;height:7px}.status-dot.ready{background:#5b8c6e}.status-dot.warn{background:var(--crimson)}.status-meta{color:var(--faint);margin-left:auto;font:10px ui-monospace,monospace}.view{padding-top:10px}.empty{text-align:center;border-top:1px solid var(--line);margin-top:8px;padding:30px 8px 24px}.empty h2{margin:5px 0 8px;font-size:19px}.empty p{color:var(--soft);max-width:340px;margin:0 auto;font-size:12px;line-height:1.7}.eyebrow{letter-spacing:.12em;color:var(--crimson);font:10px ui-monospace,monospace}.choices{grid-template-columns:1fr 1fr;gap:8px;margin:20px 0 14px;display:grid}.choice{text-align:left;border:1px solid var(--line);background:var(--panel-2);cursor:pointer;color:var(--ink);border-radius:9px;padding:13px 12px;position:relative}.choice:hover,.choice.selected{background:#b23a480f;border-color:#b23a4873}.choice input{opacity:0;position:absolute}.choice strong{margin-bottom:4px;font-size:14px;display:block}.choice span{color:var(--soft);font-size:10.5px;line-height:1.5;display:block}.init{border:1px solid var(--crimson);background:var(--crimson);color:#fff;cursor:pointer;border-radius:8px;padding:8px 15px;font-size:12px}.init:disabled{opacity:.45;cursor:not-allowed}.people-list{text-align:left;gap:8px;margin-top:18px;display:grid}.people-list h3{color:var(--soft);margin:0 0 2px;font-size:12px;font-weight:600}.person-card{padding:12px 13px}.person-actions{flex-wrap:wrap;gap:6px;margin-top:10px;display:flex}.person-action{border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer;border-radius:7px;padding:5px 9px;font-size:11px}.person-action:hover{color:var(--crimson);border-color:#b23a4873}.shelved-people{text-align:left;border-top:1px solid var(--line);margin-top:18px;padding-top:12px}.shelved-people summary{cursor:pointer;color:var(--soft);font-size:12px}.modules{grid-template-columns:1fr 1fr;gap:9px;margin-top:15px;display:grid}.module{border:1px solid var(--line);background:linear-gradient(#b23a480a,#0000);border-radius:10px;padding:15px 13px}.module b{font-size:14px}.module small{color:var(--faint);margin-top:7px;font-size:10.5px;display:block}.footer{border-top:1px solid var(--line);background:var(--panel-2);align-items:center;gap:12px;padding:11px 18px;display:flex}.legend{color:var(--faint);gap:10px;font-size:10px;display:flex}.legend span{align-items:center;gap:3px;display:inline-flex}.legend i{border-radius:2px;width:7px;height:7px}.u{background:var(--u)}.c{background:var(--c)}.crimson{background:var(--crimson)}.foot-note{color:var(--faint);margin-left:auto;font-size:10px}@keyframes in{0%{opacity:0}to{opacity:1}}@media (width<=540px){.panel{border-radius:14px;min-height:0;box-shadow:0 15px 45px #23262d2e}.body{max-height:none}.choices,.modules{grid-template-columns:1fr}}@media (prefers-reduced-motion:reduce){*,:before,:after{transition-duration:.01ms!important;animation-duration:.01ms!important}}:host{--success:#3f7356;--field:#fff}.settings-btn{width:36px;height:36px;color:var(--soft);cursor:pointer;background:0 0;border:1px solid #0000;border-radius:50%;flex:0 0 36px;margin:-7px -8px -7px 0;font-size:16px;line-height:1}.panel-resize-handle{width:44px;height:44px;color:var(--faint);cursor:nwse-resize;touch-action:none;background:0 0;border:1px solid #0000;border-radius:10px;flex:0 0 44px;justify-content:center;align-items:center;margin:-11px 0 -11px -4px;font-size:20px;line-height:1;display:inline-flex}.panel-resize-handle:hover{color:var(--crimson);background:#b23a4812;border-color:#b23a4824}.panel-resize-handle:focus-visible{outline:2px solid var(--crimson);outline-offset:2px}.settings-btn:hover{color:var(--crimson);background:#b23a4812;border-color:#b23a4824}.settings-btn:focus-visible,.open-settings:focus-visible,.settings-view button:focus-visible,.settings-view input:focus-visible,.settings-view select:focus-visible,.settings-view textarea:focus-visible{outline:2px solid var(--crimson);outline-offset:2px}.open-settings{border:1px solid var(--crimson);color:var(--crimson);cursor:pointer;background:0 0;border-radius:8px;margin-top:18px;padding:8px 15px;font-size:12px}.settings-view{text-align:left;padding:10px 2px 4px}.settings-heading{justify-content:space-between;align-items:flex-start;gap:14px;padding:4px 2px 14px;display:flex}.settings-heading h2{margin:4px 0 0;font:700 19px 宋体,Songti SC,SimSun,serif}.master-switch{border:1px solid var(--line);background:var(--panel-2);min-height:36px;color:var(--soft);white-space:nowrap;cursor:pointer;border-radius:18px;align-items:center;gap:7px;padding:7px 10px;font-size:11px;display:flex}.master-switch input,.check-field input{accent-color:var(--crimson)}.api-source-card{background:linear-gradient(105deg,#b23a4814,#3e6b8c09);border:1px solid #b23a482e;border-radius:10px;gap:4px;margin-bottom:14px;padding:13px 14px 13px 17px;display:grid;position:relative}.api-source-card:before{content:\"\";background:var(--crimson);border-radius:0 3px 3px 0;width:3px;position:absolute;top:12px;bottom:12px;left:0}.api-source-card span{color:var(--soft);font-size:10px}.api-source-card strong{font-size:13px}.api-source-card small{color:var(--faint);font-size:10px;line-height:1.5}.settings-section{border:1px solid var(--line);background:var(--panel-2);border-radius:11px;gap:10px;margin-top:14px;padding:14px;display:grid}.section-title{justify-content:space-between;align-items:start;gap:10px;display:flex}.section-title b{font-size:12px;display:block}.section-title small{color:var(--faint);margin-top:3px;font-size:10px;line-height:1.45;display:block}.field{color:var(--soft);gap:5px;font-size:10.5px;display:grid}.field input,.field select,.field textarea{border:1px solid var(--line);background:var(--field);width:100%;min-width:0;color:var(--ink);border-radius:7px;padding:8px 9px;font:12px -apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif}.field textarea{resize:vertical;line-height:1.5}.key-row,.model-row{grid-template-columns:minmax(0,1fr) auto auto;gap:6px;display:grid}.model-row{grid-template-columns:minmax(0,1fr) auto}.key-row button,.model-row button,.preset-actions button,.model-results button,.secondary-action,.primary-action{border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer;border-radius:7px;padding:7px 9px;font-size:10.5px}.preset-actions{flex-wrap:wrap;gap:6px;margin-top:-3px;display:flex}.preset-actions button{padding:5px 8px}.advanced{border-top:1px solid var(--line);padding-top:9px}.advanced summary{cursor:pointer;color:var(--soft);font-size:11px}.advanced[open] summary{margin-bottom:10px}.advanced-row{grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:10px;margin-top:9px;display:grid}.check-field{min-height:34px;color:var(--soft);align-items:center;gap:6px;font-size:11px;display:flex}.settings-actions{grid-template-columns:1fr 1.35fr;gap:8px;margin-top:14px;display:grid}.secondary-action,.primary-action{min-height:36px;font-size:12px}.primary-action{border-color:var(--crimson);background:var(--crimson);color:#fff}.settings-view button:disabled{opacity:.5;cursor:wait}.settings-result{min-height:18px;color:var(--soft);margin:8px 2px 0;font-size:10.5px;line-height:1.5}.settings-result.success{color:var(--success)}.settings-result.error{color:var(--crimson)}.model-results{flex-wrap:wrap;gap:5px;max-height:140px;display:flex;overflow:auto}.model-results[hidden]{display:none}.model-results button{text-overflow:ellipsis;white-space:nowrap;max-width:100%;overflow:hidden}@media (width<=540px){.footer{padding-bottom:max(11px,env(safe-area-inset-bottom,0px))}.legend{display:none}.foot-note{margin-left:auto}.settings-view{padding-bottom:4px}.settings-heading{align-items:center}.settings-section{padding:12px}.advanced-row{grid-template-columns:1fr}.check-field{min-height:auto}.key-row{grid-template-columns:minmax(0,1fr) auto}.key-row [data-action=key-clear]{grid-column:2}.settings-actions{background:linear-gradient(transparent,var(--panel) 30%);padding-top:8px;position:sticky;bottom:0}}.people-page{text-align:left;gap:13px;display:grid}.generation-banner{border:1px solid #b23a4833;border-left:2px solid var(--crimson);background:var(--panel-2);border-radius:0 9px 9px 0;padding:13px 14px 13px 17px;position:relative}.generation-banner h3{margin:0;font:700 14px 宋体,Songti SC,SimSun,serif}.generation-banner p{color:var(--soft);margin:5px 0 0;font-size:11px;line-height:1.6}.generation-banner .generation-hint{color:var(--crimson)}.generation-actions{flex-wrap:wrap;gap:7px;margin-top:10px;display:flex}.generation-actions button{min-height:32px;padding:6px 10px}.generation-banner .source-change-summary{color:var(--ink);font-weight:600}.profile-rail-shell{grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:7px;min-width:0;display:grid}.profile-switcher{overscroll-behavior-inline:contain;scrollbar-width:thin;gap:7px;min-width:0;padding:2px 0 5px;display:flex;overflow-x:auto}.profile-tab{border:1px solid var(--line);background:var(--panel);min-height:34px;color:var(--soft);cursor:pointer;border-radius:8px;flex:none;align-items:center;gap:6px;padding:6px 10px;font-size:11px;display:inline-flex;position:relative}.profile-tab.active{color:var(--ink);background:#b23a480e;border-color:#b23a4857}.profile-tab-name{text-overflow:ellipsis;white-space:nowrap;max-width:150px;overflow:hidden}.profile-update-dot{background:var(--crimson);pointer-events:none;border-radius:50%;width:6px;height:6px;position:absolute;top:4px;right:4px}.profile-tools{grid-template-columns:repeat(2,54px);gap:7px;padding:2px 0 5px;display:grid}.profile-tool{border:1px solid var(--line);background:var(--panel);width:54px;min-height:34px;color:var(--soft);white-space:nowrap;cursor:pointer;border-radius:8px;justify-content:center;align-items:center;padding:6px;font-size:11px;font-weight:600;display:inline-flex}.profile-tool.active{color:var(--ink);background:#b23a480e;border-color:#b23a4857}.profile-tab:focus-visible,.profile-tool:focus-visible,.more-person:focus-visible,.pending-actions button:focus-visible,.people-pool>summary:focus-visible,.basic-info button:focus-visible,.basic-info input:focus-visible,.basic-info textarea:focus-visible,.dynamic-info button:focus-visible,.dynamic-info textarea:focus-visible{outline:2px solid var(--crimson);outline-offset:2px}.subject-tag{border-radius:5px;justify-content:center;align-items:center;min-width:22px;height:20px;padding:0 5px;font:700 10px ui-monospace,monospace;display:inline-flex}.tag-u{color:var(--u);background:#3e6b8c1c}.tag-c{color:var(--c);background:#b0784a1f}.dossier-card{border-left:2px solid var(--crimson);gap:11px;padding-left:13px;display:grid}.profile-summary{align-items:flex-start;gap:9px;padding:3px 1px 1px;display:flex}.profile-summary h2{margin:0;font:700 18px 宋体,Songti SC,SimSun,serif}.profile-summary p{color:var(--soft);margin:3px 0 0;font-size:10.5px;line-height:1.5}.profile-layer{border:1px solid var(--line);background:var(--panel);border-radius:9px;padding:12px}.profile-layer.facts{background:#6a707909}.profile-layer.interpretations{background:#3e6b8c09}.profile-layer-head{border-bottom:1px solid var(--line);align-items:baseline;gap:7px;padding-bottom:8px;display:flex}.profile-layer-head h3,.section-heading h3{margin:0;font:700 13px 宋体,Songti SC,SimSun,serif}.profile-layer-head p{color:var(--faint);margin:0;font-size:9.5px;line-height:1.4}.fact-item{border-bottom:1px solid var(--line);padding:9px 0}.fact-item:last-child{border-bottom:0;padding-bottom:1px}.fact-value,.pending-value{color:var(--ink);overflow-wrap:anywhere;margin:0;font-size:12px;line-height:1.65}.fact-source,.fact-target{color:var(--faint);margin:5px 7px 0 0;font:9.5px ui-monospace,monospace;display:inline-block}.fact-target{color:var(--soft)}.layer-empty,.pool-empty{color:var(--soft);margin:9px 0 1px;font-size:11px;line-height:1.6}.pending-section{gap:8px;display:grid}.section-heading{align-items:baseline;gap:7px;display:flex}.section-heading span{color:var(--faint);font-size:9.5px}.pending-card{border:1px solid #b23a482e;border-left:2px solid var(--crimson);background:var(--panel);border-radius:0 9px 9px 0;padding:12px 12px 12px 14px}.pending-reason{color:var(--soft);overflow-wrap:anywhere;margin:6px 0 0;font-size:10.5px;line-height:1.55}.pending-meta{color:var(--faint);flex-wrap:wrap;gap:5px 9px;margin-top:8px;font:9.5px ui-monospace,monospace;display:flex}.pending-actions{gap:7px;margin-top:10px;display:flex}.pending-actions button{min-height:32px;padding:6px 10px}.pending-card[data-busy=true]{opacity:.72}.review-error{margin:0}.people-pool{border-top:1px solid var(--line);padding-top:11px}.people-pool>summary{cursor:pointer;color:var(--soft);font:600 12px 宋体,Songti SC,SimSun,serif}.people-pool[open]>summary{color:var(--ink)}.pool-intro{color:var(--soft);margin:8px 0 0;font-size:10.5px;line-height:1.6}.people-pool .people-list{margin-top:12px}.people-pool .person-card{background:var(--panel-2)}.people-content{border:1px solid var(--line);background:var(--panel);border-radius:9px;gap:11px;min-width:0;padding:12px;display:grid}.content-heading{border-bottom:1px solid var(--line);gap:4px;padding-bottom:9px;display:grid}.content-heading h2{margin:0;font:700 15px 宋体,Songti SC,SimSun,serif}.content-heading p{color:var(--soft);margin:0;font-size:10.5px;line-height:1.6}.more-list{gap:7px;display:grid}.more-person{border:1px solid var(--line);background:var(--panel-2);width:100%;min-width:0;min-height:36px;color:var(--ink);text-align:left;cursor:pointer;border-radius:8px;align-items:center;gap:7px;padding:7px 9px;font-size:11px;display:flex}.more-person:hover{color:var(--crimson);border-color:#b23a4857}.fate-book-view .people-list{margin-top:2px}.fate-book-view .person-card{background:var(--panel-2)}.basic-info{border:1px solid var(--line);background:linear-gradient(145deg,#b0784a0f,#0000);border-radius:9px;gap:11px;padding:12px;display:grid}.basic-info-head{justify-content:space-between;align-items:flex-start;gap:10px;display:flex}.basic-info-head h3{margin:0;font:700 13px 宋体,Songti SC,SimSun,serif}.basic-info-head p{color:var(--soft);margin:4px 0 0;font-size:9.5px;line-height:1.5}.basic-info-actions,.basic-edit-actions{flex-wrap:wrap;gap:6px;display:flex}.basic-info-actions{justify-content:flex-end}.basic-fields,.basic-row{gap:8px;min-width:0;max-width:100%;display:grid}.basic-row-three{grid-template-columns:repeat(3,minmax(0,1fr))}.basic-row-two{grid-template-columns:repeat(2,minmax(0,1fr))}.basic-row-one{grid-template-columns:minmax(0,1fr)}.basic-field{border:1px solid var(--line);background:var(--panel);overflow-wrap:anywhere;border-radius:7px;min-width:0;max-width:100%;padding:8px 9px;overflow:hidden}.basic-label{color:var(--soft);overflow-wrap:anywhere;margin-bottom:4px;font-size:9.5px;display:block}.basic-value{overflow-wrap:anywhere;margin:0;font-size:11.5px;line-height:1.55}.basic-value.missing{color:var(--faint)}.basic-source{color:var(--faint);overflow-wrap:anywhere;margin-top:5px;font-size:9px;line-height:1.4;display:block}.basic-field input,.basic-field textarea{border:1px solid var(--line);background:var(--field);width:100%;min-width:0;max-width:100%;color:var(--ink);border-radius:6px;padding:7px 8px;font:11.5px -apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif;display:block}.basic-field textarea{resize:vertical;min-height:64px;line-height:1.5}.basic-message{color:var(--soft);margin:0;font-size:10.5px;line-height:1.5}.basic-message.success{color:var(--success)}.basic-message.error{color:var(--crimson)}.dynamic-info{background:linear-gradient(145deg,#3e6b8c0f,#0000);border:1px solid #3e6b8c2e;border-radius:9px;gap:11px;min-width:0;max-width:100%;padding:12px;display:grid}.dynamic-info-head{justify-content:space-between;align-items:flex-start;gap:10px;min-width:0;display:flex}.dynamic-info-head h3{margin:0;font:700 13px 宋体,Songti SC,SimSun,serif}.dynamic-info-head p{color:var(--soft);margin:4px 0 0;font-size:9.5px;line-height:1.5}.dynamic-info-actions,.dynamic-edit-actions{flex-wrap:wrap;gap:6px;display:flex}.dynamic-info-actions{justify-content:flex-end}.dynamic-fields,.dynamic-row{gap:8px;min-width:0;max-width:100%;display:grid}.dynamic-row-one{grid-template-columns:minmax(0,1fr)}.dynamic-row-two{grid-template-columns:repeat(2,minmax(0,1fr))}.dynamic-field{border:1px solid var(--line);background:var(--panel);overflow-wrap:anywhere;border-radius:7px;min-width:0;max-width:100%;padding:8px 9px;overflow:hidden}.dynamic-label{color:var(--soft);overflow-wrap:anywhere;margin-bottom:4px;font-size:9.5px;display:block}.dynamic-value{overflow-wrap:anywhere;margin:0;font-size:11.5px;line-height:1.55}.dynamic-value.missing{color:var(--faint)}.dynamic-source{color:var(--faint);overflow-wrap:anywhere;margin-top:5px;font-size:9px;line-height:1.4;display:block}.dynamic-field textarea{border:1px solid var(--line);background:var(--field);width:100%;min-width:0;max-width:100%;min-height:64px;color:var(--ink);resize:vertical;border-radius:6px;padding:7px 8px;font:11.5px/1.5 -apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif;display:block}.dynamic-message{color:var(--soft);overflow-wrap:anywhere;margin:0;font-size:10.5px;line-height:1.5}.dynamic-message.success{color:var(--success)}.dynamic-message.error{color:var(--crimson)}@media (width<=390px){.body{padding-left:14px;padding-right:14px}.dossier-card{padding-left:10px}.profile-layer{padding:10px}.pending-actions,.generation-actions{grid-template-columns:1fr;display:grid}.pending-actions button,.generation-actions button{width:100%}.profile-layer-head,.section-heading{gap:3px;display:grid}.basic-info{padding:10px}.basic-info-head{display:grid}.basic-info-actions,.basic-edit-actions{grid-template-columns:1fr;width:100%;display:grid}.basic-info-actions button,.basic-edit-actions button{width:100%}.basic-fields,.basic-row{gap:5px}.basic-field{padding:7px 6px}.basic-label{font-size:9px}.basic-value,.basic-field input,.basic-field textarea{font-size:10.5px}.dynamic-info{padding:10px}.dynamic-info-head{display:grid}.dynamic-info-actions,.dynamic-edit-actions{grid-template-columns:1fr;width:100%;display:grid}.dynamic-info-actions button,.dynamic-edit-actions button{width:100%}.dynamic-fields,.dynamic-row{gap:5px}.dynamic-row-two{grid-template-columns:minmax(0,1fr)}.dynamic-field{padding:7px 6px}.dynamic-label{font-size:9px}.dynamic-value,.dynamic-field textarea{font-size:10.5px}.profile-rail-shell,.profile-switcher{gap:5px}.profile-tools{grid-template-columns:repeat(2,50px);gap:5px}.profile-tool{width:50px}.profile-tab-name{max-width:118px}.people-content{padding:10px}}@media (width<=640px){.topbar{touch-action:auto;cursor:default;-webkit-user-select:auto;user-select:auto}.panel-resize-handle{display:none}}:host{position:fixed;inset:0;z-index:1001;width:100dvw;height:100dvh;pointer-events:none;background:transparent}:host([hidden]){display:none!important;pointer-events:none!important}.panel{position:fixed;top:40px;right:20px;width:720px;height:min(780px,calc(100dvh - 80px));max-width:calc(100dvw - 20px);max-height:calc(100dvh - 20px);display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;pointer-events:auto}.body{min-height:0;max-height:none;overflow-y:auto}.tabs{min-width:0;overflow-x:auto;flex-wrap:nowrap}.tab{flex:0 0 auto}@media(max-width:640px){.panel{top:calc(20px + env(safe-area-inset-top,0px));left:50%;right:auto;bottom:auto;transform:translateX(-50%);width:calc(100dvw - 20px);max-width:calc(100dvw - 20px);height:calc(100dvh - 40px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));max-height:calc(100dvh - 40px - env(safe-area-inset-top,0px) - env(safe-area-inset-bottom,0px));min-height:0;border-radius:14px}.body{min-height:0;overflow-y:auto}.choices{grid-template-columns:1fr}.tab{padding-left:9px;padding-right:9px}}</style><section class=\"panel\" role=\"dialog\" aria-modal=\"true\" aria-labelledby=\"qqj-dialog-title\">\n<header class=\"topbar\"><div class=\"brand\"><span class=\"mark\" id=\"qqj-dialog-title\">千<span class=\"em\">千</span>结</span><span class=\"sub\">QIANQIANJIE</span></div><button class=\"icon-btn close\" type=\"button\" aria-label=\"关闭\">×</button></header>\n<nav class=\"tabs\" role=\"tablist\" aria-label=\"档案模块\"><button class=\"tab active\" role=\"tab\" aria-selected=\"true\" data-tab=\"people\">千人</button><button class=\"tab\" role=\"tab\" aria-selected=\"false\" data-tab=\"bonds\">双丝网</button><button class=\"tab\" role=\"tab\" aria-selected=\"false\" data-tab=\"milestones\">千事</button><button class=\"tab\" role=\"tab\" aria-selected=\"false\" data-tab=\"knots\">千结</button></nav>\n<main class=\"body\"><div class=\"status-line\"><span class=\"status-dot\"></span><span class=\"status-label\">正在读取当前聊天</span><span class=\"status-meta\"></span></div><div class=\"view\"></div></main>\n<footer class=\"footer\"><span class=\"legend\"><span><i class=\"u\"></i>你</span><span><i class=\"c\"></i>角色</span><span><i class=\"crimson\"></i>关系档案</span></span><span class=\"source-badge source-formal\">FORMAL</span><span class=\"foot-note\">本地界面 · 正式状态</span><button class=\"panel-resize-handle\" type=\"button\" aria-label=\"调整千千结面板大小\" title=\"拖动调整面板大小\">↘</button><button class=\"settings-btn\" type=\"button\" aria-label=\"打开千千结设置\" title=\"设置\">⚙</button></footer>\n</section>\n";
	let p = f.querySelector(".view"), m = f.querySelector(".status-label"), h = f.querySelector(".status-meta"), g = f.querySelector(".status-dot"), _ = { status: "loading" }, v = null, y = !1, b = null, x = "people", S = "people", C = "", w = 0, T = 0, E = 0, D = null, O = !1, k = !1, A = null, j = !1, M = !1, N = null, P = /* @__PURE__ */ new Map(), F = /* @__PURE__ */ new Map(), I = null, L = null, R = !1, z = null, B = null, ee = () => [...f.querySelectorAll("button,input,select,textarea,[href],[tabindex]:not([tabindex=\"-1\"])")].filter((e) => !e.disabled && e.offsetParent !== null), V = () => {
		E += 1, k = !1, M = !1, O = !1, j = !1, A = null, N = null;
	}, H = () => {
		T += 1, V(), z = null, L?.disconnect?.(), L = null, B?.cancelGesture?.(), d.hidden = !0, d.setAttribute("aria-hidden", "true");
		let e = b;
		b = null, c?.(), e?.focus?.();
	}, te = (e) => Array.isArray(e) ? e.map(te) : !e || typeof e != "object" ? e : Object.fromEntries(Object.keys(e).sort().map((t) => [t, te(e[t])])), ne = (e) => JSON.stringify(te(e)), re = (e) => String(e?.chatId || e?.peopleFoundation?.state?.chatId || e?.people?.chatId || "unknown-chat"), ie = (e, t) => [...e.filter((e) => e !== t), t], U = (e) => {
		let t = (Array.isArray(e?.people?.confirmed) ? e.people.confirmed : []).filter((e) => e.selection?.status === "selected"), n = new Set(t.map((e) => e.identityId)), r = (Array.isArray(e?.peopleFoundation?.profiles) ? e.peopleFoundation.profiles : []).filter((e) => e?.subject === "character" && n.has(e.identityId));
		return {
			selectedCharacters: t,
			selectedIds: n,
			profiles: r,
			profileMap: new Map(r.map((e) => [e.identityId, e]))
		};
	}, ae = () => I ? P.get(I) : null, oe = (e, t) => {
		let n = new Map(t.map((e, t) => [e.identityId, t])), r = new Map(e.updatedOrder.map((e, t) => [e, t])), i = new Map(e.viewedOrder.map((e, t) => [e, t]));
		return t.map((e) => e.identityId).sort((t, a) => t === e.selectedProfileId ? -1 : a === e.selectedProfileId ? 1 : Number(e.unreadUpdatedIds.has(a)) - Number(e.unreadUpdatedIds.has(t)) || (r.get(a) ?? -1) - (r.get(t) ?? -1) || (i.get(a) ?? -1) - (i.get(t) ?? -1) || n.get(t) - n.get(a));
	}, se = (e, t) => {
		let n = new Set(e.railIds);
		return t.map((e) => e.identityId).filter((e) => n.has(e));
	}, ce = (e) => {
		if (e?.peopleFoundation?.status !== "ready" || !Array.isArray(e.peopleFoundation.profiles)) return null;
		let t = re(e), { profiles: n, profileMap: r } = U(e), i = new Set(n.map((e) => e.identityId)), a = P.get(t);
		if (a) {
			a.railIds = a.railIds.filter((e) => i.has(e)), a.viewedOrder = a.viewedOrder.filter((e) => i.has(e)), a.updatedOrder = a.updatedOrder.filter((e) => i.has(e)), a.unreadUpdatedIds = new Set([...a.unreadUpdatedIds].filter((e) => i.has(e)));
			let e = F.get(t);
			if (e) for (let t of [...e.keys()]) i.has(t) || e.delete(t);
			for (let e of [...a.profileFingerprints.keys()]) i.has(e) || a.profileFingerprints.delete(e);
			for (let e of n) {
				let t = ne(e), n = a.profileFingerprints.get(e.identityId);
				n !== void 0 && n !== t && (a.updatedOrder = ie(a.updatedOrder, e.identityId), a.unreadUpdatedIds.add(e.identityId), a.railIds.includes(e.identityId) || a.railIds.push(e.identityId)), n === void 0 && !a.railIds.includes(e.identityId) && a.railIds.push(e.identityId), a.profileFingerprints.set(e.identityId, t);
			}
			if ((!a.selectedProfileId || !r.has(a.selectedProfileId)) && (a.selectedProfileId = n[0]?.identityId || null), a.selectedProfileId && !a.railIds.includes(a.selectedProfileId) && a.railIds.unshift(a.selectedProfileId), n.length <= 2) a.railIds = n.map((e) => e.identityId);
			else if (a.railIds.length < 2) {
				for (let e of oe(a, n)) if (a.railIds.includes(e) || a.railIds.push(e), a.railIds.length >= 2) break;
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
				profileFingerprints: new Map(n.map((e) => [e.identityId, ne(e)]))
			}, P.set(t, a);
		}
		return I = t, a;
	}, le = (e) => ({
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
	})[String(e?.code || "")] || "连接失败，请检查 API 配置后重试。", W = (e, t, n) => {
		let r = document.createElement("option");
		return r.value = t, r.textContent = n, e?.append?.(r), r;
	}, G = () => {
		let e = Number(p.querySelector?.("[data-setting=\"timeout\"]")?.value);
		return {
			url: p.querySelector?.("[data-setting=\"url\"]")?.value?.trim?.() || "",
			key: C,
			model: p.querySelector?.("[data-setting=\"model\"]")?.value?.trim?.() || "",
			excludeParams: p.querySelector?.("[data-setting=\"exclude\"]")?.value || "",
			timeoutSec: e,
			stream: p.querySelector?.("[data-setting=\"stream\"]")?.checked === !0
		};
	}, ue = () => {
		let e = p.querySelector?.("[data-setting=\"source\"]")?.value || "auto";
		return e.startsWith("seven:") ? {
			apiMode: "seven-preset",
			selectedSevenDaysPresetId: e.slice(6)
		} : e === "local" ? {
			apiMode: "local",
			selectedSevenDaysPresetId: "",
			localConfig: G()
		} : e === "tavern" ? {
			apiMode: "tavern",
			selectedSevenDaysPresetId: ""
		} : {
			apiMode: "auto",
			selectedSevenDaysPresetId: ""
		};
	}, K = (e, t = "") => {
		let n = p.querySelector?.(".settings-result");
		n && (n.textContent = e, n.className = `settings-result ${t}`.trim());
	}, de = (e) => {
		let t = p.querySelector?.("[data-setting=\"url\"]"), n = p.querySelector?.("[data-setting=\"model\"]"), r = p.querySelector?.("[data-setting=\"exclude\"]"), i = p.querySelector?.("[data-setting=\"timeout\"]"), a = p.querySelector?.("[data-setting=\"stream\"]"), o = p.querySelector?.("[data-setting=\"key\"]");
		t && (t.value = e?.url || ""), n && (n.value = e?.model || ""), r && (r.value = (e?.excludeParams || []).join("\n")), i && (i.value = String(e?.timeoutSec || 180)), a && (a.checked = e?.stream === !0), C = e?.key || "", o && (o.value = "", o.placeholder = C ? "已保存（输入新值可替换）" : "输入 API Key", o.type = "password");
	}, q = () => {
		let e = ++w;
		if (!n?.get) {
			K("设置存储暂不可用。", "error");
			return;
		}
		x = "settings", f.querySelectorAll(".tab").forEach((e) => {
			e.classList.toggle("active", !1), e.setAttribute("aria-selected", "false");
		});
		let t = n.get(), i = n.localConfig(), a = r?.describe?.() || {
			sourceLabel: "尚未解析",
			sevenDaysPresets: []
		};
		m.textContent = "千千结设置", h.textContent = "LOCAL", g.className = `status-dot ${t.pluginEnabled === !1 ? "warn" : "ready"}`, p.innerHTML = "<section class=\"settings-view\"><div class=\"settings-heading\"><div><div class=\"eyebrow\">THREAD CONTROL</div><h2>连接与总开关</h2></div><label class=\"master-switch\"><input data-setting=\"enabled\" type=\"checkbox\"><span>启用千千结</span></label></div><div class=\"api-source-card\"><span>当前请求来源</span><strong class=\"api-source-label\"></strong><small>构画配置只读继承，密钥不会复制到千千结。</small></div><label class=\"field\"><span>API 来源</span><select data-setting=\"source\"></select></label><section class=\"settings-section\"><div class=\"section-title\"><div><b>千千结本地 API</b><small>构画不可用时自动接力，也可手动选择。</small></div></div><label class=\"field\"><span>本地预设</span><select data-setting=\"local-preset\"></select></label><div class=\"preset-actions\"><button type=\"button\" data-action=\"preset-new\">新增</button><button type=\"button\" data-action=\"preset-update\">更新</button><button type=\"button\" data-action=\"preset-rename\">改名</button><button type=\"button\" data-action=\"preset-delete\">删除</button></div><label class=\"field\"><span>Base URL</span><input data-setting=\"url\" type=\"url\" autocomplete=\"off\" placeholder=\"https://api.example.com/v1\"></label><label class=\"field\"><span>API Key</span><span class=\"key-row\"><input data-setting=\"key\" type=\"password\" autocomplete=\"new-password\"><button type=\"button\" data-action=\"key-toggle\" aria-label=\"显示或隐藏 Key\">显示</button><button type=\"button\" data-action=\"key-clear\">清除</button></span></label><label class=\"field\"><span>模型</span><span class=\"model-row\"><input data-setting=\"model\" type=\"text\" autocomplete=\"off\" placeholder=\"gpt-4o-mini\"><button type=\"button\" data-action=\"models\">拉取模型</button></span></label><div class=\"model-results\" hidden></div><details class=\"advanced\"><summary>高级设置</summary><label class=\"field\"><span>剔除参数（每行一个）</span><textarea data-setting=\"exclude\" rows=\"3\" placeholder=\"frequency_penalty\"></textarea></label><div class=\"advanced-row\"><label class=\"field\"><span>超时（5–600 秒）</span><input data-setting=\"timeout\" type=\"number\" min=\"5\" max=\"600\"></label><label class=\"check-field\"><input data-setting=\"stream\" type=\"checkbox\"><span>流式响应</span></label></div></details></section><div class=\"settings-actions\"><button class=\"secondary-action\" type=\"button\" data-action=\"test\">测试连接</button><button class=\"primary-action\" type=\"button\" data-action=\"save\">保存设置</button></div><p class=\"settings-result\" role=\"status\" aria-live=\"polite\"></p></section>";
		let o = p.querySelector("[data-setting=\"enabled\"]");
		o && (o.checked = t.pluginEnabled !== !1);
		let c = p.querySelector(".api-source-label");
		c && (c.textContent = a.sourceLabel);
		let l = p.querySelector("[data-setting=\"source\"]");
		W(l, "auto", "自动继承构画");
		for (let e of a.sevenDaysPresets || []) W(l, `seven:${e.id}`, `构画预设 · ${e.name}`);
		W(l, "local", "千千结本地 API"), W(l, "tavern", "酒馆当前模型"), l && (l.value = t.apiMode === "seven-preset" ? `seven:${t.selectedSevenDaysPresetId}` : t.apiMode || "auto");
		let u = p.querySelector("[data-setting=\"local-preset\"]");
		W(u, "", "当前本地配置");
		for (let e of n.presets()) W(u, e.id, e.name);
		u && (u.value = t.apiPresetActiveId || "");
		let d = n.presets().find((e) => e.id === t.apiPresetActiveId);
		de(d || i);
		let _ = t.pluginEnabled !== !1, v = p.querySelector("[data-action=\"test\"]"), y = p.querySelector("[data-action=\"models\"]");
		v && (v.disabled = !_), y && (y.disabled = !_), u?.addEventListener("change", () => {
			let e = n.presets().find((e) => e.id === u.value);
			de(e || n.localConfig());
		}), p.querySelector("[data-setting=\"key\"]")?.addEventListener("input", (e) => {
			C = e.target.value;
		}), p.querySelector("[data-action=\"key-toggle\"]")?.addEventListener("click", (e) => {
			let t = p.querySelector("[data-setting=\"key\"]");
			t && (t.type === "password" ? (!t.value && C && (t.value = C), t.type = "text", e.currentTarget.textContent = "隐藏") : (C = t.value, t.value = "", t.type = "password", t.placeholder = C ? "已保存（输入新值可替换）" : "输入 API Key", e.currentTarget.textContent = "显示"));
		}), p.querySelector("[data-action=\"key-clear\"]")?.addEventListener("click", () => {
			C = "";
			let e = p.querySelector("[data-setting=\"key\"]");
			e && (e.value = "", e.placeholder = "输入 API Key"), K("保存后会清除千千结本地 Key。");
		}), p.querySelector("[data-action=\"preset-new\"]")?.addEventListener("click", () => {
			let e = globalThis.prompt?.("新预设名称", "新预设")?.trim();
			if (!e) return;
			let t = n.upsertPreset(e, G());
			n.update({ apiPresetActiveId: t }), q(), K(`已新增本地预设「${e}」。`, "success");
		}), p.querySelector("[data-action=\"preset-update\"]")?.addEventListener("click", () => {
			let e = p.querySelector("[data-setting=\"local-preset\"]")?.value, t = n.presets().find((t) => t.id === e);
			if (!t) return K("请先选择要更新的本地预设。", "error");
			n.upsertPreset(t.name, G(), e), q(), K(`已更新本地预设「${t.name}」。`, "success");
		}), p.querySelector("[data-action=\"preset-rename\"]")?.addEventListener("click", () => {
			let e = p.querySelector("[data-setting=\"local-preset\"]")?.value, t = n.presets().find((t) => t.id === e);
			if (!t) return K("请先选择要改名的本地预设。", "error");
			let r = globalThis.prompt?.("新的预设名称", t.name)?.trim();
			r && (n.renamePreset(e, r), q(), K(`已改名为「${r}」。`, "success"));
		}), p.querySelector("[data-action=\"preset-delete\"]")?.addEventListener("click", () => {
			let e = p.querySelector("[data-setting=\"local-preset\"]")?.value, t = n.presets().find((t) => t.id === e);
			if (!t) return K("请先选择要删除的本地预设。", "error");
			globalThis.confirm?.(`删除本地预设「${t.name}」？`) && (n.deletePreset(e), q(), K("本地预设已删除。", "success"));
		}), p.querySelector("[data-action=\"save\"]")?.addEventListener("click", async () => {
			let e = G();
			if (!Number.isInteger(e.timeoutSec) || e.timeoutSec < 5 || e.timeoutSec > 600) return K("超时时间必须是 5–600 秒的整数。", "error");
			let t = ue(), r = n.isEnabled();
			n.update({
				...t,
				pluginEnabled: o?.checked !== !1,
				apiUrl: e.url,
				apiKey: e.key,
				apiModel: e.model,
				apiExcludeParams: e.excludeParams,
				apiTimeoutSec: e.timeoutSec,
				apiStream: e.stream,
				apiPresetActiveId: p.querySelector("[data-setting=\"local-preset\"]")?.value || ""
			});
			let i = n.isEnabled();
			r !== i && await s?.(i), q(), K("设置已保存。", "success");
		}), p.querySelector("[data-action=\"test\"]")?.addEventListener("click", async (t) => {
			if (!n.isEnabled()) {
				K("千千结已关闭；启用并保存后才能测试连接。", "error");
				return;
			}
			let i = ue();
			t.currentTarget.disabled = !0, K("正在发送不含聊天与人物数据的短测试…");
			try {
				let t = await r?.testConnection?.(i);
				e === w && n.isEnabled() && K(`连接成功 · ${t?.model || "当前模型"}`, "success");
			} catch (t) {
				e === w && n.isEnabled() && K(le(t), "error");
			} finally {
				e === w && n.isEnabled() && (t.currentTarget.disabled = !1);
			}
		}), p.querySelector("[data-action=\"models\"]")?.addEventListener("click", async (t) => {
			if (!n.isEnabled()) {
				K("千千结已关闭；启用并保存后才能读取模型列表。", "error");
				return;
			}
			let i = ue();
			t.currentTarget.disabled = !0, K("正在读取模型列表…");
			try {
				let t = await r?.fetchModels?.(i), a = p.querySelector(".model-results");
				if (!a || e !== w || !n.isEnabled()) return;
				a.replaceChildren(), a.hidden = !1;
				for (let e of t || []) {
					let t = document.createElement("button");
					t.type = "button", t.textContent = e, t.addEventListener("click", () => {
						let t = p.querySelector("[data-setting=\"model\"]");
						t && (t.value = e);
					}), a.append(t);
				}
				K(`已读取 ${t?.length || 0} 个模型。`, "success");
			} catch (t) {
				e === w && n.isEnabled() && K(le(t), "error");
			} finally {
				e === w && n.isEnabled() && (t.currentTarget.disabled = !1);
			}
		});
	}, fe = () => {
		p.innerHTML = "<div class=\"empty\"><div class=\"eyebrow\">FIRST THREAD</div><h2>先为这段关系选一种形状</h2><p>选择只决定档案的起始方式，之后仍可以在正式数据中继续补充。</p><div class=\"choices\">" + u.map((e) => "<label class=\"choice\"><input type=\"radio\" name=\"qqj-card-type\" value=\"" + e[0] + "\"><strong>" + e[1] + "</strong><span>" + e[2] + "</span></label>").join("") + "</div><button class=\"init\" type=\"button\" disabled>初始化档案</button></div>", p.querySelectorAll("input").forEach((e) => e.addEventListener("change", () => {
			v = e.value, p.querySelectorAll(".choice").forEach((e) => e.classList.toggle("selected", e.querySelector("input").checked)), p.querySelector(".init").disabled = !1;
		})), p.querySelector(".init").addEventListener("click", async () => {
			if (!(y || !v)) {
				y = !0, p.querySelector(".init").disabled = !0, m.textContent = "正在写入正式档案";
				try {
					Q(await e.initializeCard({ cardType: v }));
				} catch {
					Q({ status: "error" });
				} finally {
					y = !1;
				}
			}
		});
	}, J = (e, t, n) => {
		let r = document.createElement("button");
		return r.type = "button", r.className = "person-action", r.dataset[t] = n, r.textContent = e, r;
	}, Y = (e, t, n) => {
		let r = document.createElement(e);
		return t && (r.className = t), n !== void 0 && (r.textContent = n), r;
	}, pe = (e) => {
		e.querySelectorAll("[data-edit]").forEach((e) => e.addEventListener("click", async () => {
			let n = Array.isArray(_.people?.confirmed) ? _.people.confirmed : [], r = globalThis.prompt?.("新的显示名", n.find((t) => t.identityId === e.dataset.edit)?.displayName ?? "");
			r?.trim() && t?.editDisplayName && await $(() => t.editDisplayName({
				identityId: e.dataset.edit,
				displayName: r
			}));
		})), e.querySelectorAll("[data-select]").forEach((e) => e.addEventListener("click", () => $(() => t.select({ identityId: e.dataset.select })))), e.querySelectorAll("[data-unselect]").forEach((e) => e.addEventListener("click", () => $(() => t.unselect({ identityId: e.dataset.unselect })))), e.querySelectorAll("[data-shelve]").forEach((e) => e.addEventListener("click", async () => {
			globalThis.confirm?.("搁置后人物会从主列表隐藏，但可随时恢复。继续吗？") && t?.shelve && await $(() => t.shelve({ identityId: e.dataset.shelve }));
		})), e.querySelectorAll("[data-restore]").forEach((e) => e.addEventListener("click", () => $(() => t.restore({ identityId: e.dataset.restore }))));
	}, me = (e) => {
		let t = Array.isArray(_.people?.confirmed) ? _.people.confirmed : [], n = Array.isArray(_.people?.candidate) ? _.people.candidate : [], r = Array.isArray(_.people?.shelved) ? _.people.shelved : [], i = Array.isArray(_.people?.warnings) ? _.people.warnings : [], a = i.some((e) => String(e?.code || "").startsWith("NORMALIZATION_")), o = i.some((e) => !String(e?.code || "").startsWith("NORMALIZATION_"));
		if (o && e.append(Y("p", "error", "部分原设来源当前不可用，已按其余来源继续。")), a && e.append(Y("p", "error", "部分人物格式已自动修正或跳过。")), _.peopleError && e.append(Y("p", "error", _.peopleError)), t.length) {
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
				o.className = "person-actions", o.append(J(i ? "取消选择" : "选择", i ? "unselect" : "select", e.identityId), J("改名", "edit", e.identityId), J("搁置", "shelve", e.identityId)), t.append(r, a, o), n.append(t);
			}), e.append(n);
		} else !o && !_.peopleError && e.append(Y("p", "pool-empty", "当前来源尚未登记明确人物。"));
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
				a.className = "person-actions", a.append(J("恢复", "restore", e.identityId)), t.append(n, r, a), i.append(t);
			}), t.append(i), e.append(t);
		}
		pe(e);
	}, he = (e) => ({
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
	})[e] || ["首次档案尚未完成", "重新加载后再试。"], ge = (e) => {
		let t = [...new Set((Array.isArray(e?.sourceRefs) ? e.sourceRefs : []).map((e) => ({
			persona: "Persona",
			card: "角色卡",
			greeting: "开场白",
			worldbook: "世界书",
			chat: "稳定聊天",
			memory: "柏宝书记忆"
		})[e?.kind]).filter(Boolean))];
		return t.length ? t.join(" · ") : "来源未标注";
	}, _e = async (e) => {
		if (y || !a?.[e]) return;
		y = !0, D = e === "resume" ? "applying" : e === "adoptCurrentSources" ? "adopting_sources" : "generating";
		let t = ++T;
		Z();
		try {
			if (await a[e](), t !== T || d.hidden) return;
			D = null, y = !1, await i?.();
		} finally {
			t === T && (y = !1, D && (D = null, Z()));
		}
	}, ve = () => {
		a?.cancel && (T += 1, a.cancel(), y = !1, D = "cancelled", Z());
	}, ye = [
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
	], be = [
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
	], xe = async (e) => {
		if (y || k || M || !a?.extractBasicInfo) return;
		k = !0, A = {
			kind: "",
			text: "正在提取基础信息…"
		}, Z();
		let t = ++E;
		try {
			let n = await a.extractBasicInfo({ identityId: e.identityId });
			if (t !== E || d.hidden) return;
			if (n?.status === "ready") {
				let e = Number(n.acceptedFields) || 0, t = Number(n.rejectedFields) || 0;
				A = e === 0 && t > 0 ? {
					kind: "error",
					text: `AI 返回了 ${t} 项，但格式未能采用；原有基础信息保持不变。`
				} : {
					kind: "success",
					text: n.emptyResult ? "提取完成，没有发现可可靠填写的新信息。" : `提取完成，采用了 ${e} 项。`
				}, k = !1, await i?.();
			} else A = {
				kind: "error",
				text: n?.status === "conflict" ? "档案刚刚发生变化，请重新加载后再试。" : n?.status === "no_selected_character" ? "当前没有已选择人物，请先到人物池选择 C。" : "提取失败，原有基础信息保持不变。"
			};
		} catch {
			t === E && (A = {
				kind: "error",
				text: "提取失败，原有基础信息保持不变。"
			});
		} finally {
			t === E && (k = !1, Z());
		}
	}, Se = async (e, n, r) => {
		if (y || k || M) return;
		let o = new Map([...r.querySelectorAll("[data-basic-field]")].map((e) => [e.dataset.basicField, e]));
		k = !0, A = {
			kind: "",
			text: "正在保存基础信息…"
		}, Z();
		let s = ++E;
		try {
			let r = o.get("name")?.value?.trim?.() || "";
			if (!r) throw Error("姓名不能为空");
			if (r !== n) {
				let n = await t?.editDisplayName?.({
					identityId: e.identityId,
					displayName: r
				});
				if (n?.status === "conflict" || n?.status === "future_schema_readonly") throw Error("姓名保存冲突");
			}
			for (let [t] of ye.slice(1)) {
				let n = o.get(t)?.value ?? "", r = e.basicFields?.[t]?.value ?? "";
				if (String(n).replace(/\r\n?/g, "\n").trim() !== String(r).replace(/\r\n?/g, "\n").trim() && (await a?.saveBasicField?.({
					identityId: e.identityId,
					field: t,
					value: n
				}))?.status !== "ready") throw Error("字段保存冲突");
			}
			if (s !== E || d.hidden) return;
			O = !1, A = {
				kind: "success",
				text: "基础信息已保存；用户填写内容不会被重新提取覆盖。"
			}, k = !1, await i?.();
		} catch (e) {
			s === E && (A = {
				kind: "error",
				text: e?.message === "姓名不能为空" ? "姓名不能为空。" : "保存未全部完成；部分已成功字段可能已保存，请重新加载确认。"
			});
		} finally {
			s === E && (k = !1, Z());
		}
	}, Ce = (e, t) => {
		let n = Y("section", "basic-info"), r = Y("div", "basic-info-head"), i = Y("div");
		i.append(Y("h3", "", "基础信息"), Y("p", "", "只记录稳定且有依据的角色信息；缺失不会猜测。")), r.append(i);
		let a = Y("div", "basic-info-actions");
		if (!O) {
			let t = Object.values(e.basicFields || {}).some((e) => e?.value), n = Y("button", "secondary-action", k ? "正在提取…" : t ? "重新提取" : "提取基础信息");
			n.type = "button", n.disabled = k || M, n.addEventListener("click", () => xe(e));
			let r = Y("button", "secondary-action", "编辑");
			r.type = "button", r.disabled = k || M, r.addEventListener("click", () => {
				O = !0, A = null, Z();
			}), a.append(n, r);
		}
		r.append(a), n.append(r);
		let o = Y("div", "basic-fields"), s = ([n, r]) => {
			let i = Y("div", "basic-field");
			i.append(Y("span", "basic-label", r));
			let a = n === "name" ? t : e.basicFields?.[n]?.value;
			if (O) {
				let e = document.createElement(n === "name" || ["gender", "age"].includes(n) ? "input" : "textarea");
				e.dataset.basicField = n, e.value = a || "", e.maxLength = n === "name" ? 120 : 2400, e.setAttribute("aria-label", r), i.append(e);
			} else i.append(Y("p", `basic-value ${a ? "" : "missing"}`.trim(), a || "未提及")), n !== "name" && a && i.append(Y("small", "basic-source", e.basicFields?.[n]?.provenance === "user" ? "用户填写" : ge(e.basicFields?.[n])));
			return i;
		}, c = new Map(ye.map((e) => [e[0], e]));
		for (let e of be) {
			let t = e.length === 3 ? "basic-row-three" : e.length === 2 ? "basic-row-two basic-preference-row" : "basic-row-one basic-relationships-row", n = Y("div", `basic-row ${t}`);
			for (let t of e) n.append(s(c.get(t)));
			o.append(n);
		}
		if (n.append(o), O) {
			let r = Y("div", "basic-edit-actions"), i = Y("button", "primary-action", k ? "正在保存…" : "保存基础信息"), a = Y("button", "secondary-action", "取消");
			i.type = a.type = "button", i.disabled = a.disabled = k, i.addEventListener("click", () => Se(e, t, n)), a.addEventListener("click", () => {
				O = !1, A = null, Z();
			}), r.append(i, a), n.append(r);
		}
		return A && n.append(Y("p", `basic-message ${A.kind}`.trim(), A.text)), n;
	}, we = [
		["personalityState", "当前性格状态"],
		["currentGoals", "当前目标"],
		["currentSituation", "当前处境"],
		["currentSecrets", "当前秘密"],
		["wellbeing", "当前身心状态"],
		["stableChanges", "长期稳定变化"]
	], Te = [
		["personalityState"],
		["currentGoals", "currentSituation"],
		["currentSecrets"],
		["wellbeing", "stableChanges"]
	], Ee = async (e) => {
		if (y || k || M || !a?.updateDynamicFields) return;
		M = !0, N = {
			kind: "",
			text: "正在更新动态状态…"
		}, Z();
		let t = ++E;
		try {
			let n = await a.updateDynamicFields({ identityId: e.identityId });
			if (t !== E || d.hidden) return;
			if (n?.status === "ready") {
				let e = Number(n.acceptedFields) || 0, t = Number(n.rejectedFields) || 0;
				N = e === 0 && t > 0 ? {
					kind: "error",
					text: `AI 返回了 ${t} 项动态状态，但格式或范围未能采用；原有状态保持不变。`
				} : {
					kind: "success",
					text: n.emptyResult ? "更新完成，没有发现可可靠填写的当前状态。" : `更新完成，采用了 ${e} 项动态状态。`
				}, M = !1, await i?.();
			} else N = {
				kind: "error",
				text: n?.status === "conflict" ? "档案刚刚发生变化，请重新加载后再试。" : n?.status === "no_selected_character" ? "当前没有已选择人物，请先到人物池选择 C。" : "动态状态更新失败，原有内容保持不变。"
			};
		} catch {
			t === E && (N = {
				kind: "error",
				text: "动态状态更新失败，原有内容保持不变。"
			});
		} finally {
			t === E && (M = !1, Z());
		}
	}, De = async (e, t) => {
		if (y || k || M) return;
		let n = new Map([...t.querySelectorAll("[data-dynamic-field]")].map((e) => [e.dataset.dynamicField, e]));
		M = !0, N = {
			kind: "",
			text: "正在保存当前状态…"
		}, Z();
		let r = ++E;
		try {
			for (let [t] of we) {
				let r = n.get(t)?.value ?? "", i = e.dynamicFields?.[t]?.value ?? "";
				if (String(r).replace(/\r\n?/g, "\n").trim() !== String(i).replace(/\r\n?/g, "\n").trim() && (await a?.saveDynamicField?.({
					identityId: e.identityId,
					field: t,
					value: r
				}))?.status !== "ready") throw Error("字段保存冲突");
			}
			if (r !== E || d.hidden) return;
			j = !1, N = {
				kind: "success",
				text: "当前状态已保存；用户填写内容不会被 AI 更新覆盖。"
			}, M = !1, await i?.();
		} catch {
			r === E && (N = {
				kind: "error",
				text: "保存未全部完成；部分已成功字段可能已保存，请重新加载确认。"
			});
		} finally {
			r === E && (M = !1, Z());
		}
	}, Oe = (e) => {
		let t = Y("section", "dynamic-info"), n = Y("div", "dynamic-info-head"), r = Y("div");
		r.append(Y("h3", "", "当前状态"), Y("p", "", "记录这个 C 当前仍成立的个人状态；不记录对 U 的态度或关系阶段。")), n.append(r);
		let i = Y("div", "dynamic-info-actions");
		if (!j) {
			let t = Y("button", "secondary-action", M ? "正在更新…" : "更新动态状态");
			t.type = "button", t.disabled = M || k, t.addEventListener("click", () => Ee(e));
			let n = Y("button", "secondary-action", "编辑");
			n.type = "button", n.disabled = M || k, n.addEventListener("click", () => {
				j = !0, N = null, Z();
			}), i.append(t, n);
		}
		n.append(i), t.append(n);
		let a = Y("div", "dynamic-fields"), o = new Map(we.map((e) => [e[0], e])), s = ([t, n]) => {
			let r = Y("div", "dynamic-field");
			r.append(Y("span", "dynamic-label", n));
			let i = e.dynamicFields?.[t]?.value;
			if (j) {
				let e = document.createElement("textarea");
				e.dataset.dynamicField = t, e.value = i || "", e.maxLength = 2400, e.setAttribute("aria-label", n), r.append(e);
			} else r.append(Y("p", `dynamic-value ${i ? "" : "missing"}`.trim(), i || "未提及")), i && r.append(Y("small", "dynamic-source", e.dynamicFields?.[t]?.provenance === "user" ? "用户填写" : ge(e.dynamicFields?.[t])));
			return r;
		};
		for (let e of Te) {
			let t = Y("div", `dynamic-row ${e.length === 2 ? "dynamic-row-two" : "dynamic-row-one"}`);
			for (let n of e) t.append(s(o.get(n)));
			a.append(t);
		}
		if (t.append(a), j) {
			let n = Y("div", "dynamic-edit-actions"), r = Y("button", "primary-action", M ? "正在保存…" : "保存当前状态"), i = Y("button", "secondary-action", "取消");
			r.type = i.type = "button", r.disabled = i.disabled = M, r.addEventListener("click", () => De(e, t)), i.addEventListener("click", () => {
				j = !1, N = null, Z();
			}), n.append(r, i), t.append(n);
		}
		return N && t.append(Y("p", `dynamic-message ${N.kind}`.trim(), N.text)), t;
	}, ke = (e, t) => {
		let n = _.initialRelations || _.peopleFoundation?.state?.initialGeneration || {
			status: "uninitialized",
			completedMemberIds: []
		}, r = n.lastAttempt || _.peopleFoundation?.state?.lastAttempt, a = r?.action === "adopt_current_sources" && r?.status === "ready", o = D || (a && ["blocked_source_changed", "uninitialized"].includes(n.status) ? "adopted_sources" : n.status) || "uninitialized", s = new Set(n.completedMemberIds || []), c = e.some((e) => !s.has(e)), l = r?.emptyResult === !0;
		if (o === "ready" && !c && !l) return null;
		let u = Y("section", "generation-banner");
		u.setAttribute("aria-live", "polite"), u.setAttribute("aria-busy", String(["generating", "applying"].includes(o)));
		let [d, f] = o === "ready" && !c && l ? ["首次整理已完成", "没有可靠结果；人物骨架和用户内容保持不变。"] : o === "ready" && c ? ["有新人物等待补充", "只会为尚未完成的已选择人物生成首次档案。"] : he(o);
		if (u.append(Y("h3", "", d), Y("p", "", f)), n.status === "blocked_source_changed" && r?.sourceDiagnostics) {
			let e = r.sourceDiagnostics, t = e.greeting === "changed" ? "开场白已变化" : e.greeting === "unavailable" ? "开场白暂时无法读取" : "开场白未变化", n = Number(e.worldbookUnreadable) || 0, i = n > 0 ? `，暂时无法读取 ${n} 条` : "";
			u.append(Y("p", "source-change-summary", `${t}；世界书 ${Number(e.worldbookChanged) || 0} 条变化，${Number(e.worldbookMissing) || 0} 条缺失${i}。`));
		}
		let p = Y("div", "generation-actions");
		if (["generating", "applying"].includes(o)) {
			let e = Y("button", "secondary-action", "停止，稍后继续");
			e.type = "button", e.addEventListener("click", ve), p.append(e);
		} else if (o === "blocked_source_changed") {
			let e = Y("button", "primary-action", "采用当前作者来源");
			e.type = "button", e.disabled = y, e.addEventListener("click", () => _e("adoptCurrentSources")), p.append(e);
		} else if (!(o === "ready" && !c) && ![
			"mismatch",
			"future_schema_readonly",
			"input_too_large",
			"requires_rebuild"
		].includes(o)) {
			let e = Y("button", "primary-action", o === "ready" && c ? "为新人物补充档案" : o === "cancelled" ? "继续整理档案" : "生成首次档案");
			e.type = "button", e.disabled = y, e.addEventListener("click", () => _e(n.status === "applying" ? "resume" : "start")), p.append(e);
		}
		if (!["generating", "applying"].includes(o)) {
			let e = Y("button", "secondary-action", o === "blocked_source_changed" ? "重新读取状态" : "重新加载");
			e.type = "button", e.addEventListener("click", () => i?.({ announceLoading: !0 })), p.append(e);
		}
		return !t && o === "uninitialized" && u.append(Y("p", "generation-hint", "还没有选择 C；可以先到“因缘簿”选择人物。")), (p.children?.length || p.childNodes?.length) && u.append(p), u;
	}, Ae = () => V(), X = (e) => {
		if (!e) return !1;
		let t = e.kind === "profile" ? ".profile-tab" : ".profile-tool", n = e.kind === "profile" ? "profileId" : "contentMode", r = [...p.querySelectorAll(t)].find((t) => t.dataset[n] === e.id);
		return r?.focus?.(), r?.scrollIntoView?.({
			block: "nearest",
			inline: "nearest"
		}), !!r;
	}, je = () => {
		let e = f.activeElement;
		return e?.dataset?.profileId ? {
			kind: "profile",
			id: e.dataset.profileId
		} : e?.dataset?.contentMode ? {
			kind: "tool",
			id: e.dataset.contentMode
		} : null;
	}, Me = () => {
		let e = z;
		return z = null, X(e);
	}, Ne = (e, { restoreFocus: t = !1 } = {}) => {
		let n = ae();
		n && (n.selectedProfileId = e, n.contentMode = "dossier", n.viewedOrder = ie(n.viewedOrder, e), n.unreadUpdatedIds.delete(e), n.railIds.includes(e) || n.railIds.push(e), t && (z = {
			kind: "profile",
			id: e
		}), Ae(), Z(), Me());
	}, Pe = ({ availableWidth: e, itemWidths: t = {} } = {}, n = !0) => {
		let r = ae(), { profiles: i } = U(_), a = je();
		if (!r) return z = null, {
			changed: !1,
			railIds: []
		};
		if (i.length <= 2) {
			let e = i.map((e) => e.identityId), t = e.join("|") !== r.railIds.join("|");
			return r.railIds = e, z = null, t && n && (Z(), X(a)), {
				changed: t,
				railIds: [...r.railIds]
			};
		}
		let o = Number(e), s = oe(r, i), c = se(r, i);
		if (!(o > 0)) return z = null, {
			changed: !1,
			railIds: c
		};
		let l = F.get(I);
		l || (l = /* @__PURE__ */ new Map(), F.set(I, l));
		let u = t instanceof Map ? t : new Map(Object.entries(t || {}));
		for (let [e, t] of u) Number(t) > 0 && l.set(e, Number(t));
		let d = (e) => l.get(e) || 72, f = new Set(s.filter((e) => e === r.selectedProfileId || r.unreadUpdatedIds.has(e))), p = [...f].reduce((e, t) => e + d(t), Math.max(0, f.size - 1) * 7);
		for (let e of s) {
			if (f.has(e)) continue;
			let t = d(e) + (f.size ? 7 : 0);
			(f.size < 2 || p + t <= o) && (f.add(e), p += t);
		}
		let m = i.map((e) => e.identityId).filter((e) => f.has(e)), h = m.join("|") !== c.join("|");
		return h && (r.railIds = m, n && (Z(), X(a))), z = null, {
			changed: h,
			railIds: [...m]
		};
	}, Fe = (e) => {
		if (!e || R) return;
		R = !0;
		let t = () => {
			R = !1;
			let t = f.querySelector(".profile-switcher");
			if (t !== e) {
				t && Fe(t);
				return;
			}
			let n = Number(e.clientWidth);
			if (!(n > 0)) {
				z = null;
				return;
			}
			let r = new Map([...e.querySelectorAll(".profile-tab")].map((e) => [e.dataset.profileId, Number(e.getBoundingClientRect?.().width || e.offsetWidth || 0)]));
			Pe({
				availableWidth: n,
				itemWidths: r
			});
		};
		typeof globalThis.requestAnimationFrame == "function" ? globalThis.requestAnimationFrame(t) : globalThis.queueMicrotask?.(t);
	}, Ie = (e) => {
		L?.disconnect?.(), L = null, Fe(e), typeof globalThis.ResizeObserver == "function" && (L = new globalThis.ResizeObserver(() => Fe(e)), L.observe(e));
	}, Le = (e, t, n, r) => {
		let i = t.filter((e) => !r.has(e.identityId)), a = Y("section", "people-content more-view"), o = Y("div", "content-heading");
		if (o.append(Y("h2", "", `更多人物（${i.length}）`), Y("p", "", "这些人物仍在关注中，只是暂时退出快捷轨道。点击即可回到档案并提高轨道优先级。")), a.append(o), !i.length) a.append(Y("p", "layer-empty", "当前没有退出快捷轨道的人物。"));
		else {
			let e = Y("div", "more-list");
			for (let t of i) {
				let r = Y("button", "more-person");
				r.type = "button", r.dataset.profileId = t.identityId, r.append(Y("span", "subject-tag tag-c", "C"), Y("span", "", n.get(t.identityId))), r.addEventListener("click", () => Ne(t.identityId, { restoreFocus: !0 })), e.append(r);
			}
			a.append(e);
		}
		e.append(a);
	}, Re = (e) => {
		let t = Y("section", "people-content fate-book-view"), n = Y("div", "content-heading");
		n.append(Y("h2", "", "因缘簿"), Y("p", "", "管理候选人物与关注状态；这里的“选择”只表示当前关注，不代表关系已经成立。")), t.append(n), me(t), e.append(t);
	}, Z = () => {
		p.replaceChildren();
		let e = _.peopleFoundation;
		if (e?.status !== "ready" || !Array.isArray(e.profiles)) {
			let e = Y("div", "empty");
			e.append(Y("div", "eyebrow", "PEOPLE / POOL"), Y("h2", "", "先管理当前人物"), Y("p", "", "选择只表示你当前想关注这位人物，不代表已经恋爱或发生关系。关系档案骨架尚未就绪时，人物池仍可查看和管理。")), me(e), p.append(e);
			return;
		}
		let t = ce(_), { selectedCharacters: n, selectedIds: r, profiles: i, profileMap: a } = U(_), o = new Map(n.map((e) => [e.identityId, e.displayName || "未命名人物"])), s = [...r], c = a.get(t?.selectedProfileId), l = new Map([[e.state?.personaId, "我"], ...i.map((e) => [e.identityId, o.get(e.identityId) || e.displayName || "未命名人物"])]), u = Y("div", "people-page"), d = ke(s, i.length > 0);
		d && u.append(d);
		let f = Y("div", "profile-rail-shell"), m = Y("div", "profile-switcher");
		m.setAttribute("role", "tablist"), m.setAttribute("aria-label", "切换人物档案");
		let h = se(t, i).map((e) => a.get(e)).filter(Boolean);
		for (let e of h) {
			let n = t.contentMode === "dossier" && e.identityId === t.selectedProfileId, r = t.unreadUpdatedIds.has(e.identityId), i = l.get(e.identityId), a = Y("button", `profile-tab ${n ? "active" : ""} ${r ? "has-update" : ""}`.trim());
			if (a.type = "button", a.dataset.profileId = e.identityId, a.tabIndex = 0, a.setAttribute("role", "tab"), a.setAttribute("aria-selected", String(n)), a.setAttribute("aria-label", `C ${i}${r ? "，有新更新" : ""}`), a.append(Y("span", "subject-tag tag-c", "C"), Y("span", "profile-tab-name", i)), r) {
				let e = Y("span", "profile-update-dot");
				e.setAttribute("aria-hidden", "true"), a.append(e);
			}
			a.addEventListener("click", () => Ne(e.identityId, { restoreFocus: !0 })), m.append(a);
		}
		let g = Y("div", "profile-tools");
		for (let [e, n] of [["more", "更多"], ["fateBook", "因缘簿"]]) {
			let r = Y("button", `profile-tool ${t.contentMode === e ? "active" : ""}`.trim(), n);
			r.type = "button", r.dataset.contentMode = e, r.setAttribute("aria-pressed", String(t.contentMode === e)), r.addEventListener("click", () => {
				if (t.contentMode === e && c) {
					Ne(c.identityId, { restoreFocus: !0 });
					return;
				}
				t.contentMode = e, Ae(), z = {
					kind: "tool",
					id: e
				}, Z(), Me();
			}), g.append(r);
		}
		if (f.append(m, g), u.append(f), t.contentMode === "more") Le(u, i, l, new Set(t.railIds));
		else if (t.contentMode === "fateBook") Re(u);
		else if (!c) u.append(Y("p", "layer-empty", "还没有已选择的 C。请打开“因缘簿”选择一位人物。"));
		else {
			let e = Y("section", "dossier-card"), t = Y("header", "profile-summary");
			t.append(Y("span", "subject-tag tag-c", "C"));
			let n = Y("div");
			n.append(Y("h2", "", l.get(c.identityId)), Y("p", "", "当前已选择人物的稳定关系档案")), t.append(n), e.append(t), e.append(Ce(c, l.get(c.identityId))), e.append(Oe(c)), u.append(e);
		}
		p.append(u), Ie(m);
	}, ze = () => {
		let e = {
			bonds: "双丝网",
			milestones: "千事",
			knots: "千结"
		}, t = Y("div", "empty");
		t.append(Y("div", "eyebrow", "COMING LATER"), Y("h2", "", e[S] || "此模块"), Y("p", "", "尚未接入业务数据。本次只完成千人关系档案。")), p.replaceChildren(t);
	}, Q = (e) => {
		if (D === "cancelled" && e?.status === "stale" && ["ready", "route_ready"].includes(_?.status)) {
			y = !1, Z();
			return;
		}
		if (!(["ready", "route_ready"].includes(e?.status) && e?.peopleFoundation?.status === "ready")) V(), z = null;
		else {
			let t = re(e), n = U(e).profileMap, r = ae();
			(I && t !== I || r?.selectedProfileId && !n.has(r.selectedProfileId)) && (V(), z = null);
		}
		if (T += 1, y = !1, D = null, _ = e || { status: "error" }, x === "settings") return;
		if (S !== "people") return ze();
		let t = _.status, n = ["ready", "route_ready"].includes(t) && _.peopleRecognitionFailed, r = Array.isArray(_.people?.warnings) && _.people.warnings.some((e) => String(e?.code || "").startsWith("NORMALIZATION_"));
		if (m.textContent = n ? "人物识别失败，已保留旧列表" : {
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
		}[t] || t, h.textContent = t === "route_unavailable" ? [
			"GREETING_INVALID",
			"SCANNER_UNAVAILABLE",
			"SCAN_FAILED",
			"SCAN_RESULT_INVALID",
			"ENTRY_INVALID",
			"ROUTE_INVALID",
			"UNKNOWN"
		].includes(_.diagnosticCode) ? _.diagnosticCode : "UNKNOWN" : _.cardType || "", g.className = "status-dot " + (n || r || [
			"disabled",
			"mismatch",
			"route_mismatch",
			"route_unavailable",
			"error",
			"conflict"
		].includes(t) ? "warn" : ["ready", "route_ready"].includes(t) ? "ready" : ""), t === "awaiting_card_type" || t === "migrated") return fe();
		if (["ready", "route_ready"].includes(t)) return Z();
		let i = t === "disabled" ? ["千千结现在是关闭的", "不会读取聊天、扫描来源、调用 AI 或写入档案。已有数据保持原样。"] : t === "route_mismatch" ? ["路线来源需要确认", "当前路线已锁定，来源诊断仅作提示，不影响人物识别。"] : t === "route_unavailable" ? ["来源扫描不可用", "当前世界书无法进行安全的 dry-run 扫描，请稍后重试。"] : t === "mismatch" ? ["身份需要确认", "当前角色、Persona 或正式档案绑定不一致。为保护已有数据，本次只读。"] : t === "offline" ? ["暂时离线", "正式存储暂时不可用，恢复连接后可重新打开。"] : t === "stopped" ? ["还没有可用聊天", "请先打开一个单人聊天，再打开千千结。"] : t === "preparing" ? ["正在恢复档案", "请稍候，档案恢复完成前不能操作人物。"] : t === "renaming" ? ["正在恢复人物改名", "上次改名尚未完成，正在核对人物档案与列表。"] : ["正在准备档案", "正式状态尚未就绪，请稍后重试。"], a = Y("div", "empty");
		if (a.append(Y("div", "eyebrow", "QIANQIANJIE"), Y("h2", "", i[0]), Y("p", "", i[1])), t === "disabled") {
			let e = Y("button", "open-settings", "打开设置");
			e.type = "button", e.addEventListener("click", q), a.append(e);
		}
		p.replaceChildren(a);
	}, $ = async (e) => {
		if (!y) {
			y = !0;
			try {
				let n = await e();
				if (n?.status === "conflict" || n?.status === "error") {
					Q({
						..._,
						status: ["ready", "route_ready"].includes(_.status) ? _.status : n.status,
						people: _.people,
						peopleError: "档案发生冲突，请稍后重试"
					});
					return;
				}
				if (typeof i == "function") {
					await i();
					return;
				}
				let r = t?.getPeople ? await t.getPeople() : n;
				Q(_.peopleRecognitionFailed ? {
					..._,
					people: r
				} : {
					..._,
					people: r,
					peopleError: null
				});
			} catch {
				Q({
					..._,
					status: ["ready", "route_ready"].includes(_.status) ? _.status : "error",
					people: _.people,
					peopleError: "操作失败，原人物列表已保留"
				});
			} finally {
				y = !1;
			}
		}
	};
	return f.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			e.preventDefault(), H();
			return;
		}
		if (e.key !== "Tab") return;
		let t = ee();
		if (!t.length) return;
		let n = t[0], r = t[t.length - 1];
		e.shiftKey && f.activeElement === n ? (e.preventDefault(), r.focus()) : !e.shiftKey && f.activeElement === r && (e.preventDefault(), n.focus());
	}), f.querySelector(".close").addEventListener("click", H), f.querySelector(".settings-btn")?.addEventListener("click", () => {
		x === "settings" ? (w += 1, x = "people", S = "people", f.querySelectorAll(".tab").forEach((e, t) => {
			e.classList.toggle("active", t === 0), e.setAttribute("aria-selected", String(t === 0));
		}), Q(_)) : q();
	}), f.querySelectorAll(".tab").forEach((e) => e.addEventListener("click", () => {
		w += 1, x = "people", S = e.dataset.tab || "people", f.querySelectorAll(".tab").forEach((t) => {
			let n = t === e;
			t.classList.toggle("active", n), t.setAttribute("aria-selected", String(n));
		}), Q(_);
	})), B = l({
		panel: f.querySelector(".panel"),
		dragHandle: f.querySelector(".topbar"),
		resizeHandle: f.querySelector(".panel-resize-handle")
	}), Q(_), {
		host: d,
		root: f,
		show: (e = document.activeElement) => {
			b = e, B?.restore?.(), d.hidden = !1, d.setAttribute("aria-hidden", "false"), Ie(f.querySelector(".profile-switcher")), f.querySelector(".close").focus();
		},
		close: H,
		setState: Q,
		settlePeopleRail: Pe,
		showSettings: q,
		getState: () => ({ ..._ })
	};
}
//#endregion
//#region src/ui/fab.js
var f = "qqj-fab-pos", p = 36, m = () => globalThis.innerWidth <= 540 || globalThis.matchMedia?.("(max-width: 540px)").matches, h = () => ({
	width: Number(globalThis.innerWidth) || 0,
	height: Number(globalThis.innerHeight) || 0
}), g = (e, t) => Math.max(0, Math.min(Math.max(0, t - p), e));
function _({ onClick: e } = {}) {
	let t = document.createElement("div");
	t.id = "qqj-fab-host", t.attachShadow({ mode: "open" });
	let n = t.shadowRoot;
	n.innerHTML = "<style>:host{position:fixed;right:16px;top:calc(100dvh - 80px - 44px);z-index:1000;touch-action:none}button{width:36px;height:36px;border:0;border-radius:50%;background:#B23A48;color:#fff;cursor:pointer;box-shadow:0 7px 18px rgba(178,58,72,.32);touch-action:none;display:grid;place-items:center;padding:4px}button:focus-visible{outline:2px solid #23262D;outline-offset:3px}svg{width:28px;height:28px;display:block}@media(max-width:540px){:host{right:14px}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}</style><button type=\"button\" aria-label=\"打开千千结\"><svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\" width=\"64\" height=\"64\" fill=\"none\"><circle cx=\"32\" cy=\"32\" r=\"25\" stroke=\"currentColor\" stroke-width=\"0.9\"/><g stroke=\"currentColor\" stroke-width=\"0.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M 30.72 28.58 C 27.3 26.5, 24.5 25.3, 20.46 25.38 C 17.2 25.45, 15.53 28.1, 15.55 31.36 C 15.57 35.1, 17.6 37.8, 19.82 39.05 C 21.5 40.0, 23.4 39.9, 24.74 39.48 L 40.12 30.29\"/><path d=\"M 32.85 36.06 C 35.6 37.7, 37.8 39.2, 38.84 39.48 C 42.8 40.6, 46.0 38.3, 47.60 34.99 C 49.0 31.8, 47.6 28.5, 44.61 26.02 C 42.7 24.5, 39.2 24.7, 36.91 26.02 L 27.94 31.57\"/><path d=\"M 23.45 30.29 L 30.72 34.56\"/><path d=\"M 26.02 33.07 L 23.67 34.35\"/><path d=\"M 35.63 31.57 L 32.85 30.08\"/><path d=\"M 37.34 33.07 L 39.91 34.35\"/></g></svg></button>";
	let r = n.querySelector("button"), i = null, a = !1, o = null, s = () => {
		t.style.left = "", t.style.top = "calc(100dvh - 80px - 44px)", t.style.right = m() ? "14px" : "16px";
	}, c = () => {
		if (m()) return null;
		try {
			let e = JSON.parse(globalThis.localStorage?.getItem(f) || "null");
			return Number.isFinite(e?.x) && Number.isFinite(e?.y) ? e : null;
		} catch {
			return null;
		}
	}, l = (e) => {
		let n = h();
		if (!n.width || !n.height || !e) return;
		let r = g(e.x, n.width), i = g(e.y, n.height);
		t.style.left = `${r}px`, t.style.top = `${i}px`, t.style.right = "auto", o = {
			x: r,
			y: i
		};
	}, u = () => {
		if (m()) return;
		let e = t.getBoundingClientRect(), n = h(), r = {
			x: g(e.left, n.width),
			y: g(e.top, n.height)
		};
		o = r;
		try {
			globalThis.localStorage?.setItem(f, JSON.stringify({
				x: Math.round(r.x),
				y: Math.round(r.y)
			}));
		} catch {}
	}, d = () => {
		s(), m() || l(o || c());
	}, p = () => {
		m() ? s() : l(o || c());
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
		let a = h();
		t.style.left = `${g(i.origX + n, a.width)}px`, t.style.top = `${g(i.origY + r, a.height)}px`, t.style.right = "auto";
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
	}), globalThis.addEventListener?.("resize", p), d(), {
		host: t,
		root: n,
		button: r,
		restore: d,
		onResize: p,
		destroy: () => globalThis.removeEventListener?.("resize", p)
	};
}
//#endregion
//#region src/ui/wand-entry.js
function v(e) {
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
function y(e) {
	let t = Number(e?.status || e?.statusCode || 0), n = String(e?.code || e?.name || "").toLowerCase(), r = String(e?.message || "");
	return e?.name === "AbortError" || /timeout|timed.?out|etimedout|abort/.test(n) || /timeout|timed.?out|超时/i.test(r) || [408, 504].includes(t) ? "API 请求超时，请稍后重试" : [401, 403].includes(t) || /unauthori[sz]ed|forbidden|认证|api.?key/.test(`${n} ${r}`.toLowerCase()) ? "API 认证失败，请检查配置后重试" : t === 429 || /rate.?limit|too many requests|限流/.test(`${n} ${r}`.toLowerCase()) ? "API 请求过于频繁，请稍后重试" : /jsonData|generateTask 返回值无效|未返回 jsonData|结果不是 json|结果结构|结构无效|字段无效|来源锚点无效|无可用人物|schema/i.test(r) ? "人物识别结果格式无效" : "人物识别失败，请稍后重试";
}
//#endregion
//#region src/bootstrap.js
function b({ formal: e, people: t, settings: n, apiTools: r, loadState: i, initialRelations: a, reviewActions: o, onPluginEnabledChange: s, documentRef: c = globalThis.document, panelFactory: l = d, fabFactory: u = _, wandInstaller: f = v, enableFab: p = !1 } = {}) {
	if (!c) return {
		setState() {},
		show() {}
	};
	let m = c.getElementById("qqj-panel-host");
	if (m) return m.__qqjInstance;
	let h = () => n?.isEnabled?.() !== !1, g = 0, b = () => h() ? { status: "stale" } : { status: "disabled" }, x = async (e, n) => {
		let r = () => h() && n === g;
		if (!r() || typeof t?.getPeople != "function") return r() ? e : b();
		let i = await t.getPeople();
		if (!r()) return b();
		if (![
			"uninitialized",
			"preparing",
			"deleting",
			"restoring",
			"renaming",
			"conflict",
			"stale"
		].includes(i?.status) || typeof t.identify != "function") return {
			...e,
			people: i
		};
		try {
			let n = await t.identify({ onPhase: (t) => {
				r() && T({
					...e,
					status: t
				});
			} });
			if (!r()) return b();
			let i = n?.status === "people_error" ? n : await t.getPeople();
			return r() ? {
				...e,
				people: {
					...i,
					warnings: [...new Map([...i?.warnings || [], ...n?.warnings || []].map((e) => [e.code || JSON.stringify(e), e])).values()].slice(0, 80)
				},
				...n?.status === "conflict" ? { peopleError: "人物改名恢复发生冲突，请稍后重试" } : {},
				...n?.peopleError ? { peopleError: n.peopleError } : {},
				peopleRecognitionFailed: n?.status === "people_error" || !!n?.peopleError
			} : b();
		} catch (t) {
			return r() ? {
				...e,
				status: ["ready", "route_ready"].includes(e?.status) ? e.status : "people_error",
				people: i,
				peopleError: y(t),
				peopleRecognitionFailed: !0
			} : b();
		}
	}, S, C = async ({ announceLoading: t = !1 } = {}) => {
		let n = ++g;
		if (!h()) {
			let e = { status: "disabled" };
			return n === g && S?.setState(e), e;
		}
		t && S?.setState({ status: "loading" });
		try {
			let t = typeof i == "function" ? await i() : await x(typeof e?.getFormalState == "function" ? await e.getFormalState() : { status: "error" }, n), r = h() && n === g ? t : b();
			return n === g && T(r), r;
		} catch {
			let e = h() ? { status: "error" } : { status: "disabled" };
			return n === g && T(e), e;
		}
	}, w = (e) => {
		S.host.style.display = "block", S.show(e?.currentTarget || e?.target || c.activeElement), C({ announceLoading: !0 });
	};
	S = l({
		formal: e,
		people: t,
		settings: n,
		apiTools: r,
		loadState: typeof i == "function" ? C : void 0,
		initialRelations: a,
		reviewActions: o,
		onPluginEnabledChange: s,
		onClose: () => {
			g += 1, S.host.style.display = "none";
		}
	});
	let T = (e) => {
		if (S.setState(e), e?.status === "people_error") {
			let t = S.root?.querySelector?.(".view"), n = c.createElement?.("p");
			n && (n.className = "error", n.textContent = e.peopleError || "人物识别失败：暂时无法读取人物结果，请稍后重试。", t?.append?.(n));
		}
	};
	S.host.style.display = "none", c.body.append(S.host);
	let E = p || typeof c.createElement != "function" ? u({ onClick: w }) : { host: null };
	E.host && (E.host.style ||= {}, E.host.style.display = h() ? "" : "none", c.body.append(E.host)), f(w), c.addEventListener("keydown", (e) => {
		e.key === "Escape" && !S.host.hidden && S.close();
	});
	let D = (e) => {
		g += 1, E.host?.style && (E.host.style.display = e ? "" : "none"), e || T({ status: "disabled" });
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
export { b as bootstrap };
