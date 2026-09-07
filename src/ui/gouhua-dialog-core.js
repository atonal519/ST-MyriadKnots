// Copied from ST-SevenDaysCal/modal.js @ fb93e5466c14fa28158004454790100a0f284f53.
// Source: prepareDialog/mountDialog/choose/confirm/prompt. QQJ-only seams: focus hooks, scheduler, hasActive.
const OVERLAY_ID = 'sp-addon-dialog';

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 通用决策弹窗只管理自身遮罩和 Promise 生命周期；业务判断与持久化留给调用方。
export function createGouhuaDialogCore({ $, mount, getRootClass = () => '', subscribeContextChange = () => () => {}, removeOverlay = null, captureFocus = () => null, restoreFocus = () => {}, schedule = setTimeout } = {}) {
    if (typeof $ !== 'function' || !mount?.appendChild) throw new TypeError('弹窗管理器缺少 DOM 依赖');
    const purgeOverlay = removeOverlay || (() => $(`#${OVERLAY_ID}`).remove());
    let activeCancel = null;

    function cancelActive() {
        if (!activeCancel) return false;
        activeCancel();
        return true;
    }

    function prepareDialog() {
        cancelActive();
        purgeOverlay();
    }

    // 所有弹窗共用同一套关闭语义，避免某个接口漏掉遮罩、Esc 或聊天切换清理。
    function mountDialog($overlay, resolve, { onClose } = {}) {
        let done = false;
        let unsubscribe = () => {};
        const finish = value => {
            if (done) return false;
            done = true;
            if (activeCancel === externalClose) activeCancel = null;
            try { onClose?.(); }
            finally {
                unsubscribe();
                $overlay.remove();
                resolve(value);
            }
            return true;
        };
        const externalClose = () => finish(null);
        activeCancel = externalClose;
        $overlay.on('click', function (event) { if (event.target === this) externalClose(); });
        $overlay.on('keydown', event => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            externalClose();
        });
        $overlay.addClass(String(getRootClass() || ''));
        mount.appendChild($overlay[0]);
        unsubscribe = subscribeContextChange(externalClose) || (() => {});
        return Object.freeze({ finish, close: externalClose, isDone: () => done });
    }

    function choose({ title = '', body = '', note = '', choices = [] } = {}) {
        if (!Array.isArray(choices) || !choices.length) return Promise.resolve(null);
        return new Promise(resolve => {
            prepareDialog();
            const previousFocus = captureFocus();
            const buttons = choices.map((choice, index) => {
                const tone = choice.primary ? 'primary' : 'secondary';
                return `<button class="sp-dialog-button sp-dialog-button-${tone}" type="button" data-dialog-choice="${index}">${escapeHtml(choice.label)}</button>`;
            }).join('');
            const $overlay = $(`<div id="${OVERLAY_ID}" class="sp-dialog-overlay">
                <div class="sp-dialog-sheet" role="dialog" aria-modal="true" aria-labelledby="sp-dialog-title">
                    <div id="sp-dialog-title" class="sp-dialog-head">${escapeHtml(title)}</div>
                    <div class="sp-dialog-body">${escapeHtml(body)}</div>
                    ${note ? `<div class="sp-dialog-note">${escapeHtml(note)}</div>` : ''}
                    <div class="sp-dialog-actions">${buttons}</div>
                </div>
            </div>`);
            const session = mountDialog($overlay, resolve, { onClose: () => restoreFocus(previousFocus) });
            $overlay.find('[data-dialog-choice]').on('click', function () {
                const choice = choices[Number($(this).attr('data-dialog-choice'))];
                session.finish(choice?.value ?? null);
            });
            schedule(() => $overlay.find('[data-dialog-choice]').last().trigger('focus'), 0);
        });
    }

    function confirm({ title, body, note, confirmText = '确定', cancelText = '取消' } = {}) {
        return choose({
            title,
            body,
            note,
            choices: [
                { value: 'cancel', label: cancelText },
                { value: 'confirm', label: confirmText, primary: true },
            ],
        }).then(value => value === 'confirm');
    }

    function prompt({ title = '', body = '', initialValue = '', placeholder = '', maxLength = 40, confirmText = '保存', cancelText = '取消', validate } = {}) {
        return new Promise(resolve => {
            prepareDialog();
            const previousFocus = captureFocus();
            const limit = Number(maxLength) > 0 ? Number(maxLength) : 40;
            const $overlay = $(`<div id="${OVERLAY_ID}" class="sp-dialog-overlay">
                <div class="sp-dialog-sheet" role="dialog" aria-modal="true" aria-labelledby="sp-dialog-title">
                    <div id="sp-dialog-title" class="sp-dialog-head">${escapeHtml(title)}</div>
                    ${body ? `<div class="sp-dialog-body">${escapeHtml(body)}</div>` : ''}
                    <input type="text" class="sp-dialog-input" value="${escapeHtml(initialValue)}" placeholder="${escapeHtml(placeholder)}" maxlength="${limit}" autocomplete="off">
                    <div class="sp-dialog-input-error" aria-live="polite"></div>
                    <div class="sp-dialog-actions">
                        <button class="sp-dialog-button sp-dialog-button-secondary sp-dialog-cancel" type="button">${escapeHtml(cancelText)}</button>
                        <button class="sp-dialog-button sp-dialog-button-primary sp-dialog-submit" type="button">${escapeHtml(confirmText)}</button>
                    </div>
                </div>
            </div>`);
            const session = mountDialog($overlay, resolve, { onClose: () => restoreFocus(previousFocus) });
            const submit = () => {
                const value = String($overlay.find('.sp-dialog-input').val() ?? '').trim();
                const raw = typeof validate === 'function' ? validate(value) : '';
                const error = typeof raw === 'string' ? raw : '';
                if (error) {
                    $overlay.find('.sp-dialog-input-error').html(`<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${escapeHtml(error)}`);
                    $overlay.find('.sp-dialog-input').trigger('focus');
                    return;
                }
                session.finish(value);
            };
            $overlay.find('.sp-dialog-submit').on('click', submit);
            $overlay.find('.sp-dialog-cancel').on('click', session.close);
            $overlay.find('.sp-dialog-input').on('input', () => $overlay.find('.sp-dialog-input-error').empty()).on('keydown', event => {
                if (event.key === 'Enter') { event.preventDefault(); submit(); }
                else if (event.key === 'Escape') { event.preventDefault(); session.close(); }
            });
            schedule(() => $overlay.find('.sp-dialog-input').trigger('focus').trigger('select'), 0);
        });
    }

    return Object.freeze({ confirm, choose, prompt, cancelActive, hasActive: () => activeCancel !== null });
}
