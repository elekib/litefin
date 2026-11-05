/**
 * ============================================================================
 * Litefin Tizen - Seerr Requests Page
 * ============================================================================
 * Lightweight request tracker: a card grid of Seerr requests with poster,
 * status, requester and age. Users with manage permission can approve or
 * decline pending requests; in-flight downloads show a progress line.
 * ============================================================================
 */

import Page from './Page.js';
import { router } from '../core/Router.js';
import { focusManager } from '../ui/FocusManager.js';
import { toast } from '../ui/Toast.js';
import { seerr } from '../api/seerrClient.js';
import { api } from '../api/ApiClient.js';
import { i18n } from '../utils/i18n.js';
import { logger } from '../utils/Logger.js';

const log = logger.create('SeerrRequestsPage');

const PAGE_SIZE = 18;

const FILTERS = [
    { id: 'all', key: 'All' },
    { id: 'pending', key: 'SeerrPendingApproval' },
    { id: 'processing', key: 'SeerrDownloading' },
    { id: 'unavailable', key: 'SeerrComingSoon' },
    { id: 'available', key: 'SeerrStatusAvailable' }
];

const escapeHtml = (value) =>
    String(value ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

/** Compact age such as "4d" from an ISO timestamp, or '' when unparseable. */
function formatAge(iso) {
    const then = Date.parse(iso);
    if (!then) return '';
    const mins = Math.max(0, Math.floor((Date.now() - then) / 60000));
    if (mins < 60) return `${Math.max(1, mins)}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d`;
    return `${Math.floor(days / 30)}mo`;
}

class SeerrRequestsPage extends Page {
    constructor() {
        super();
        this._isAsyncPage = true;
        this._filter = 'all';
        this._canManage = false;
        this._requests = [];
        this._total = 0;
        this._details = new Map();
        this._busy = false;
        this._isDestroyed = false;
    }

    render() {
        return `
            <div class="page seerr-requests-page">
                <main class="page-content seerr-requests-content">
                    <div class="seerr-requests-filters" id="requests-filters">
                        ${FILTERS.map(
                            (f) =>
                                `<button class="seerr-requests-chip" tabindex="0" data-filter="${f.id}">${i18n.t(f.key)}</button>`
                        ).join('')}
                    </div>
                    <div class="seerr-requests-grid" id="requests-list"></div>
                    <div class="seerr-requests-empty hidden" id="requests-empty">${i18n.t('SeerrNoRequests')}</div>
                    <div id="requests-more-wrap"><button class="seerr-requests-chip hidden" id="requests-more" tabindex="0">${i18n.t('SeerrLoadMore')}</button></div>
                </main>
            </div>
        `;
    }

    async onInit() {
        this.title = i18n.t('SeerrRequests');
        this.setLoading(true);

        this.registerFocusSection('requests-filters', this.$('#requests-filters'), {
            orientation: 'horizontal',
            leaveLeft: 'sidebar',
            leaveDown: 'requests-list'
        });
        this.registerFocusSection('requests-list', this.$('#requests-list'), {
            orientation: 'grid',
            leaveLeft: 'sidebar',
            leaveUp: 'requests-filters',
            leaveDown: 'requests-more'
        });
        this.registerFocusSection('requests-more', this.$('#requests-more-wrap'), {
            orientation: 'horizontal',
            leaveLeft: 'sidebar',
            leaveUp: 'requests-list'
        });

        this.el.addEventListener('click', (e) => this._onClick(e));
        // Missing Jellyfin avatar -> drop the <img> and let the initial underneath show
        this.el.addEventListener(
            'error',
            (e) => e.target.classList?.contains('seerr-requests-avatar-img') && e.target.remove(),
            true
        );

        this._canManage = await seerr.canManageRequests();
        await this._load(true);

        this.setLoading(false);
        this.setActiveSection(this._requests.length ? 'requests-list' : 'requests-filters');
        this.markReady();
    }

    onDestroyed() {
        this._isDestroyed = true;
    }

    // ========================================================================
    // Data
    // ========================================================================

    async _load(reset) {
        if (reset) this._requests = [];
        try {
            const { results, total } = await seerr.requestList(this._filter, PAGE_SIZE, this._requests.length);
            // Seerr's processing filter can still return finished media; keep only real in-flight downloads
            const visible = this._filter === 'processing' ? results.filter((r) => !this._isFinished(r)) : results;
            this._requests = this._requests.concat(visible);
            this._total = total;
            await this._resolveDetails(visible);
        } catch (err) {
            log.warn('Failed to load requests', err);
            toast.show(i18n.t('SeerrRequestsLoadFailed'));
        }
        if (!this._isDestroyed) this._renderList();
    }

    _isFinished(req) {
        const media = req.media || {};
        const hasDownload = Array.isArray(media.downloadStatus) && media.downloadStatus.length > 0;
        return (media.status === 5 || req.status === 5) && !hasDownload;
    }

    _detailKey(req) {
        const media = req.media || {};
        return `${req.type || media.mediaType}:${media.tmdbId}`;
    }

    /** Request records carry no title/poster, so fetch (cached) media details for each. */
    async _resolveDetails(requests) {
        await Promise.all(
            requests.map(async (req) => {
                const key = this._detailKey(req);
                const media = req.media || {};
                if (!media.tmdbId || this._details.has(key)) return;
                try {
                    const detail = await seerr.details(req.type || media.mediaType, media.tmdbId);
                    this._details.set(key, detail || {});
                } catch (err) {
                    this._details.set(key, {});
                }
            })
        );
    }

    // ========================================================================
    // Rendering
    // ========================================================================

    /**
     * Resolves the badge for a request from the request state refined by the
     * media's own state, so in-flight downloads read "Downloading 42%".
     */
    _statusOf(req) {
        const media = req.media || {};
        const badge = (key, variant, pct = null) => ({ label: i18n.t(key), variant, pct });

        if (req.status === 1) return badge('SeerrPendingApproval', 'pending');
        if (req.status === 3) return badge('SeerrRequestDeclined', 'declined');
        if (req.status === 4) return badge('SeerrRequestFailed', 'declined');
        if (media.status === 6) return badge('SeerrStatusDeleted', 'declined');
        if (media.status === 5) return badge('SeerrStatusAvailable', 'approved');
        if (media.status === 4) return badge('SeerrStatusPartial', 'partial');
        if (req.status === 5) return badge('SeerrStatusCompleted', 'completed');

        const dl = Array.isArray(media.downloadStatus) ? media.downloadStatus[0] : null;
        if (media.status === 3 || dl) {
            const pct = dl && dl.size > 0 ? Math.round(((dl.size - dl.sizeLeft) / dl.size) * 100) : null;
            const status = badge('SeerrDownloading', 'downloading', pct);
            if (pct !== null) status.label += ` ${pct}%`;
            return status;
        }
        return badge('SeerrRequestApproved', 'approved');
    }

    _renderList() {
        this.$$('[data-filter]').forEach((chip) =>
            chip.classList.toggle('active', chip.dataset.filter === this._filter)
        );

        this.$('#requests-list').innerHTML = this._requests.map((req) => this._renderCard(req)).join('');
        this.$('#requests-empty').classList.toggle('hidden', this._requests.length > 0);
        this.$('#requests-more').classList.toggle('hidden', this._requests.length >= this._total);
        focusManager.invalidateCache();
    }

    _renderCard(req) {
        const media = req.media || {};
        const type = req.type || media.mediaType;
        const detail = this._details.get(this._detailKey(req)) || {};
        const status = this._statusOf(req);

        const title = detail.Name || '';
        const year = detail.ProductionYear ? `(${detail.ProductionYear})` : '';
        const user = req.requestedBy?.displayName || req.requestedBy?.jellyfinUsername || '';
        const age = formatAge(req.createdAt);
        const jfId = req.requestedBy?.jellyfinUserId;

        const avatar = `<span class="seerr-requests-avatar">${escapeHtml(user.charAt(0).toUpperCase())}${
            jfId
                ? `<img class="seerr-requests-avatar-img" src="${escapeHtml(api.getUserImageUrl(jfId, { maxWidth: 80 }))}" alt="">`
                : ''
        }</span>`;
        const progress =
            status.pct != null
                ? `<span class="seerr-requests-progress"><span style="width:${status.pct}%"></span></span>`
                : '';
        const poster = detail._imageUrl
            ? `<img class="seerr-requests-poster" src="${escapeHtml(detail._imageUrl)}" alt="" loading="lazy">`
            : '<span class="seerr-requests-poster"></span>';
        const actions =
            this._canManage && req.status === 1
                ? `<div class="seerr-requests-actions">
                       <button class="seerr-requests-btn approve" tabindex="0" data-action="approve" data-id="${req.id}">${i18n.t('SeerrApprove')}</button>
                       <button class="seerr-requests-btn decline" tabindex="0" data-action="decline" data-id="${req.id}">${i18n.t('SeerrDecline')}</button>
                   </div>`
                : '';

        return `
            <div class="seerr-requests-card" data-id="${req.id}">
                <button class="seerr-requests-open" tabindex="0" data-action="open" data-type="${escapeHtml(type)}" data-tmdb="${escapeHtml(media.tmdbId)}">
                    ${poster}
                    <span class="seerr-requests-body">
                        <span class="seerr-requests-name">${escapeHtml(title)}</span>
                        <span class="seerr-requests-year">${escapeHtml(year)}</span>
                        <span class="seerr-requests-status ${status.variant}">${escapeHtml(status.label)}</span>
                        ${progress}
                        <span class="seerr-requests-user">
                            ${avatar}
                            <span>${escapeHtml(user)}${age ? ` · ${escapeHtml(i18n.t('SeerrAgo', [age]))}` : ''}</span>
                        </span>
                    </span>
                </button>
                ${actions}
            </div>
        `;
    }

    // ========================================================================
    // Actions
    // ========================================================================

    async _onClick(e) {
        const chip = e.target.closest('[data-filter]');
        if (chip) {
            this._filter = chip.dataset.filter;
            await this._load(true);
            return;
        }
        if (e.target.closest('#requests-more')) {
            await this._load(false);
            return;
        }

        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (btn.dataset.action === 'open') {
            router.navigate(`/seerr/${btn.dataset.type}/${btn.dataset.tmdb}`);
            return;
        }
        await this._decide(btn.dataset.action, btn.dataset.id);
    }

    async _decide(action, id) {
        if (this._busy) return;
        this._busy = true;
        try {
            if (action === 'approve') {
                await seerr.approveRequest(id);
                toast.show(i18n.t('SeerrRequestApproved'));
            } else {
                await seerr.declineRequest(id);
                toast.show(i18n.t('SeerrRequestDeclined'));
            }
            // Update the handled card locally instead of refetching the whole list
            const wasPendingView = this._filter === 'pending';
            this._requests = wasPendingView
                ? this._requests.filter((r) => String(r.id) !== String(id))
                : this._requests.map((r) =>
                      String(r.id) === String(id) ? { ...r, status: action === 'approve' ? 2 : 3 } : r
                  );
            this._total = Math.max(0, this._total - (wasPendingView ? 1 : 0));
            this._renderList();
            this.setActiveSection(this._requests.length ? 'requests-list' : 'requests-filters');
        } catch (err) {
            log.warn(`Failed to ${action} request ${id}`, err);
            toast.show(i18n.t('SeerrRequestActionFailed'));
        } finally {
            this._busy = false;
        }
    }
}

export default SeerrRequestsPage;
