/*! Lucide v1.17.0 — ISC License. Copyright (c) 2026 Lucide Icons and Contributors.
 * Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted,
 * provided that the above copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT,
 * OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF
 * CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 * Full upstream notice: docs/lucide-license.txt. Full icon catalog described in docs/qianchuang-assets.md. */
import {LUCIDE_ICONS} from './qianchuang-lucide-data.js';
export const qianchuangIconNames = Object.freeze(Object.keys(LUCIDE_ICONS));
const normalize = value => String(value??'').normalize('NFKC').toLocaleLowerCase().replace(/[\s_-]+/gu,'');
const names = new Map(qianchuangIconNames.map(name=>[normalize(name),name]));
const legacy = {bath:'Bath',laundry:'WashingMachine',kitchen:'CookingPot',dining:'Utensils',rest:'BedDouble',storage:'Archive',work:'BriefcaseBusiness',building:'Building2',place:'MapPin'};
export const qianchuangIconName = value => legacy[value]??names.get(normalize(value))??null;
const shapes=new Map(),canonical=new Map();
for(const name of qianchuangIconNames){const shape=JSON.stringify(LUCIDE_ICONS[name]);if(!shapes.has(shape))shapes.set(shape,name);canonical.set(name,shapes.get(shape));}
export const qianchuangIconCanonicalName = value => canonical.get(qianchuangIconName(value))??null;

const attr = value => String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
export const qianchuangIcon = kind => {
 const nodes=LUCIDE_ICONS[qianchuangIconName(kind)??'MapPin'];
 return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${nodes.map(([tag,attrs])=>`<${tag} ${Object.entries(attrs).map(([key,value])=>`${key}="${attr(value)}"`).join(' ')}/>`).join('')}</svg>`;
};
